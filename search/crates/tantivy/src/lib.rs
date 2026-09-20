//! Memory-mapped Tantivy adapter. The API and ingest pipeline depend only on traits.
mod scoring;

use search_backend::{IndexSink, SearchBackend};
use search_model::{Error, Post, Result, SearchRequest, SearchResponse};
use search_query::Expr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ops::Bound, path::Path};
use tantivy::collector::TopDocs;
use tantivy::query::{
    AllQuery, BooleanQuery, ConstScoreQuery, EmptyQuery, Occur, PhraseQuery, Query, RangeQuery,
    TermQuery,
};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing,
    TextOptions, Value,
};
use tantivy::tokenizer::{LowerCaser, SimpleTokenizer, TextAnalyzer, TokenStream};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

const MAX_WINDOW: usize = 10_000;

fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}

fn schema() -> Schema {
    let mut schema = Schema::builder();
    schema.add_u64_field("id", INDEXED | FAST);
    schema.add_text_field("author", STRING);
    schema.add_text_field(
        "text",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("words")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        ),
    );
    schema.add_i64_field("created", INDEXED | FAST);
    schema.add_u64_field("likes", FAST);
    schema.add_f64_field("engagement", FAST);
    schema.add_text_field("post", STORED);
    schema.build()
}

fn analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .build()
}

/// Open a disk index. Creation is explicit; readers never silently create an empty corpus.
///
/// # Errors
/// Returns filesystem, incompatible schema or index errors.
pub fn open(path: &Path, create: bool) -> Result<Engine> {
    let expected = schema();
    let index = if create {
        std::fs::create_dir_all(path).map_err(storage)?;
        Index::open_or_create(
            tantivy::directory::MmapDirectory::open(path).map_err(storage)?,
            expected.clone(),
        )
        .map_err(storage)?
    } else {
        Index::open_in_dir(path).map_err(storage)?
    };
    if index.schema() != expected {
        return Err(Error::Invalid(
            "Incompatible index. Reimport into a new directory.".into(),
        ));
    }
    index.tokenizers().register("words", analyzer());
    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::Manual)
        .doc_store_cache_num_blocks(8)
        .try_into()
        .map_err(storage)?;
    Ok(Engine { index, reader })
}

pub struct Engine {
    index: Index,
    reader: IndexReader,
}

impl Engine {
    /// Create a single writer with a bounded 32 MB indexing buffer.
    ///
    /// # Errors
    /// Fails if another writer owns the lock or storage is unavailable.
    pub fn writer(&self) -> Result<Writer> {
        Ok(Writer {
            writer: self
                .index
                .writer_with_num_threads(1, 32_000_000)
                .map_err(storage)?,
            schema: self.index.schema(),
        })
    }

    fn field(&self, name: &str) -> Result<Field> {
        self.index.schema().get_field(name).map_err(storage)
    }

    /// Live document count, reloaded from disk. Used to detect a registry
    /// that believes it is complete while the index is actually empty.
    ///
    /// # Errors
    /// Returns storage errors when the index cannot be read.
    pub fn num_docs(&self) -> Result<u64> {
        self.reader.reload().map_err(storage)?;
        Ok(self.reader.searcher().num_docs())
    }

    fn compile(&self, expression: &Expr) -> Result<Box<dyn Query>> {
        match expression {
            Expr::Term(text) | Expr::Phrase(text) => {
                let mut analyzer = analyzer();
                let mut stream = analyzer.token_stream(text);
                let mut terms = Vec::new();
                while stream.advance() {
                    terms.push(Term::from_field_text(
                        self.field("text")?,
                        &stream.token().text,
                    ));
                }
                if terms.is_empty() {
                    return Ok(Box::new(EmptyQuery));
                }
                if matches!(expression, Expr::Phrase(_)) && terms.len() > 1 {
                    return Ok(Box::new(PhraseQuery::new(terms)));
                }
                Ok(Box::new(BooleanQuery::new(
                    terms
                        .into_iter()
                        .map(|term| -> (Occur, Box<dyn Query>) {
                            (
                                Occur::Must,
                                Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs)),
                            )
                        })
                        .collect(),
                )))
            }
            Expr::Author(author) => Ok(Box::new(ConstScoreQuery::new(
                Box::new(TermQuery::new(
                    Term::from_field_text(self.field("author")?, author),
                    IndexRecordOption::Basic,
                )),
                0.0,
            ))),
            Expr::Since(time) => Ok(Box::new(ConstScoreQuery::new(
                Box::new(RangeQuery::new(
                    Bound::Included(Term::from_field_i64(self.field("created")?, *time)),
                    Bound::Unbounded,
                )),
                0.0,
            ))),
            Expr::Until(time) => Ok(Box::new(ConstScoreQuery::new(
                Box::new(RangeQuery::new(
                    Bound::Unbounded,
                    Bound::Excluded(Term::from_field_i64(self.field("created")?, *time)),
                )),
                0.0,
            ))),
            Expr::And(children) | Expr::Or(children) => {
                let occur = if matches!(expression, Expr::And(_)) {
                    Occur::Must
                } else {
                    Occur::Should
                };
                let children = children
                    .iter()
                    .map(|child| self.compile(child).map(|query| (occur, query)))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Box::new(BooleanQuery::new(children)))
            }
            Expr::Not(child) => Ok(Box::new(BooleanQuery::new(vec![
                (
                    Occur::Must,
                    Box::new(ConstScoreQuery::new(Box::new(AllQuery), 0.0)),
                ),
                (Occur::MustNot, self.compile(child)?),
            ]))),
        }
    }
}

pub struct Writer {
    writer: IndexWriter,
    schema: Schema,
}

impl IndexSink for Writer {
    fn upsert(&mut self, post: &Post) -> Result<()> {
        let id = post
            .tweet_id
            .parse::<u64>()
            .map_err(|_| Error::Invalid("Tweet ID must be an unsigned integer.".into()))?;
        let field = |name| self.schema.get_field(name).map_err(storage);
        let mut document = TantivyDocument::default();
        document.add_u64(field("id")?, id);
        document.add_text(
            field("author")?,
            search_query::normalize_author(&post.author)?,
        );
        document.add_text(field("text")?, &post.text);
        document.add_text(
            field("post")?,
            serde_json::to_string(post).map_err(storage)?,
        );
        document.add_f64(field("engagement")?, search_ranking::engagement(post));
        if let Some(time) = post.created_at {
            document.add_i64(field("created")?, time);
        }
        if let Some(likes) = post.likes {
            document.add_u64(field("likes")?, u64::from(likes));
        }
        self.writer
            .delete_term(Term::from_field_u64(field("id")?, id));
        self.writer.add_document(document).map_err(storage)?;
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        self.writer.commit().map_err(storage)?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    fingerprint: String,
    offset: usize,
    now: i64,
}

impl SearchBackend for Engine {
    fn search(
        &self,
        expression: &Expr,
        request: &SearchRequest,
        now: i64,
    ) -> Result<SearchResponse> {
        request.validate()?;
        self.reader.reload().map_err(storage)?;
        let searcher = self.reader.searcher();
        let mut hash = Sha256::new();
        hash.update(
            serde_json::to_vec(&(expression, request.sort, request.limit)).map_err(storage)?,
        );
        for segment in searcher.segment_readers() {
            hash.update(segment.segment_id().uuid_string());
            hash.update(segment.num_deleted_docs().to_le_bytes());
        }
        let fingerprint = format!("{:x}", hash.finalize());
        let cursor = request
            .cursor
            .as_ref()
            .map(|raw| {
                serde_json::from_str::<Cursor>(raw)
                    .map_err(|_| Error::Invalid("Invalid cursor.".into()))
            })
            .transpose()?;
        let (offset, now) = if let Some(cursor) = cursor {
            if cursor.fingerprint != fingerprint {
                return Err(Error::StaleCursor);
            }
            if cursor.offset >= MAX_WINDOW
                || cursor.now > now
                || now.saturating_sub(cursor.now) > 300_000
            {
                return Err(Error::Invalid(
                    "Cursor expired or outside the result window.".into(),
                ));
            }
            (cursor.offset, cursor.now)
        } else {
            (0, now)
        };
        let query = self.compile(expression)?;
        let page_limit = request.limit.min(MAX_WINDOW.saturating_sub(offset));
        let collector = TopDocs::with_limit(page_limit.saturating_add(1))
            .and_offset(offset)
            .order_by(scoring::Ranking {
                sort: request.sort,
                now,
            });
        let hits = searcher.search(&query, &collector).map_err(storage)?;
        let more = hits.len() > page_limit;
        let rows = hits
            .into_iter()
            .take(page_limit)
            .map(|(_, address)| {
                let document = searcher.doc::<TantivyDocument>(address).map_err(storage)?;
                let raw = document
                    .get_first(self.field("post")?)
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| storage("Missing stored post"))?;
                serde_json::from_str(raw).map_err(storage)
            })
            .collect::<Result<Vec<Post>>>()?;
        let next_offset = offset.saturating_add(rows.len());
        let next_cursor = if more && next_offset < MAX_WINDOW {
            Some(
                serde_json::to_string(&Cursor {
                    fingerprint,
                    offset: next_offset,
                    now,
                })
                .map_err(storage)?,
            )
        } else {
            None
        };
        let warnings = if more && next_offset >= MAX_WINDOW {
            vec!["Result window capped at 10,000. Narrow your query.".into()]
        } else {
            Vec::new()
        };
        Ok(SearchResponse {
            rows,
            next_cursor,
            warnings,
        })
    }
}
