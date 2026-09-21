//! Memory-mapped Tantivy adapter. The API and ingest pipeline depend only on traits.
mod scoring;

use search_backend::{IndexSink, SearchBackend};
use search_model::{BackendStats, Error, Post, Result, SearchRequest, SearchResponse, SearchStats};
use search_query::Expr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ops::Bound, path::Path, time::Instant};
use tantivy::collector::{Count, TopDocs};
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

fn started(enabled: bool) -> Option<Instant> {
    enabled.then(Instant::now)
}

fn elapsed_us(start: Option<Instant>) -> u64 {
    start.map_or(0, |started| {
        u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
    })
}

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
    let fields = Fields::from_schema(&expected)?;
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
    Ok(Engine {
        index,
        reader,
        fields,
    })
}

#[derive(Clone, Copy)]
struct Fields {
    id: Field,
    author: Field,
    text: Field,
    created: Field,
    likes: Field,
    engagement: Field,
    post: Field,
}

impl Fields {
    fn from_schema(schema: &Schema) -> Result<Self> {
        let field = |name| schema.get_field(name).map_err(storage);
        Ok(Self {
            id: field("id")?,
            author: field("author")?,
            text: field("text")?,
            created: field("created")?,
            likes: field("likes")?,
            engagement: field("engagement")?,
            post: field("post")?,
        })
    }
}

pub struct Engine {
    index: Index,
    reader: IndexReader,
    fields: Fields,
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
            fields: self.fields,
        })
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

    /// Live, deduplicated document count for one author — reloaded from
    /// disk first so a just-committed import is reflected immediately.
    ///
    /// This is the only honest source of a publication update's
    /// `uniquePostCount` (see `docs/publication-contract.md` "What unique
    /// means"): `Writer::upsert` `delete_term`s the previous document for a
    /// tweet id before adding the replacement, so the live doc count per
    /// author is already deduplicated across every capture and every
    /// import ever run for that author — never a running import counter.
    ///
    /// # Errors
    /// Returns [`Error::Invalid`] for an unusable author handle, or storage
    /// errors when the index cannot be read.
    pub fn count_author(&self, author: &str) -> Result<u64> {
        self.reader.reload().map_err(storage)?;
        let normalized = search_query::normalize_author(author)?;
        let term = Term::from_field_text(self.fields.author, &normalized);
        let query = TermQuery::new(term, IndexRecordOption::Basic);
        let count = self
            .reader
            .searcher()
            .search(&query, &Count)
            .map_err(storage)?;
        u64::try_from(count).map_err(|_| Error::Invalid("Author count overflowed u64.".into()))
    }

    fn compile(&self, expression: &Expr) -> Result<Box<dyn Query>> {
        match expression {
            Expr::Term(text) | Expr::Phrase(text) => {
                let mut analyzer = analyzer();
                let mut stream = analyzer.token_stream(text);
                let mut terms = Vec::new();
                while stream.advance() {
                    terms.push(Term::from_field_text(
                        self.fields.text,
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
                    Term::from_field_text(self.fields.author, author),
                    IndexRecordOption::Basic,
                )),
                0.0,
            ))),
            Expr::Since(time) => Ok(Box::new(ConstScoreQuery::new(
                Box::new(RangeQuery::new(
                    Bound::Included(Term::from_field_i64(self.fields.created, *time)),
                    Bound::Unbounded,
                )),
                0.0,
            ))),
            Expr::Until(time) => Ok(Box::new(ConstScoreQuery::new(
                Box::new(RangeQuery::new(
                    Bound::Unbounded,
                    Bound::Excluded(Term::from_field_i64(self.fields.created, *time)),
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
    fields: Fields,
}

impl IndexSink for Writer {
    fn upsert(&mut self, post: &Post) -> Result<()> {
        let id = post.tweet_id.0;
        let mut document = TantivyDocument::default();
        document.add_u64(self.fields.id, id);
        document.add_text(
            self.fields.author,
            search_query::normalize_author(&post.author)?,
        );
        document.add_text(self.fields.text, &post.text);
        document.add_text(
            self.fields.post,
            serde_json::to_string(post).map_err(storage)?,
        );
        document.add_f64(self.fields.engagement, search_ranking::engagement(post));
        if let Some(time) = post.created_at {
            document.add_i64(self.fields.created, time);
        }
        if let Some(likes) = post.likes {
            document.add_u64(self.fields.likes, u64::from(likes));
        }
        self.writer
            .delete_term(Term::from_field_u64(self.fields.id, id));
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

fn fingerprint(
    searcher: &tantivy::Searcher,
    expression: &Expr,
    sort: search_model::Sort,
    limit: usize,
) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(expression, sort, limit)).map_err(storage)?);
    for segment in searcher.segment_readers() {
        hash.update(segment.segment_id().uuid_string());
        hash.update(segment.num_deleted_docs().to_le_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn cursor_bounds(request: &SearchRequest, fingerprint: &str, now: i64) -> Result<(usize, i64)> {
    let cursor = request
        .cursor
        .as_ref()
        .map(|raw| {
            serde_json::from_str::<Cursor>(raw)
                .map_err(|_| Error::Invalid("Invalid cursor.".into()))
        })
        .transpose()?;
    if let Some(cursor) = cursor {
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
        Ok((cursor.offset, cursor.now))
    } else {
        Ok((0, now))
    }
}

impl Engine {
    // Diagnostics are opt-in; keeping this path separate avoids timer branches
    // in every default search candidate.
    fn search_fast(
        &self,
        expression: &Expr,
        request: &SearchRequest,
        now: i64,
    ) -> Result<SearchResponse> {
        request.validate()?;
        self.reader.reload().map_err(storage)?;
        let searcher = self.reader.searcher();
        let fingerprint = fingerprint(&searcher, expression, request.sort, request.limit)?;
        let (offset, now) = cursor_bounds(request, &fingerprint, now)?;
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
                    .get_first(self.fields.post)
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
            stats: None,
        })
    }
}

impl SearchBackend for Engine {
    fn search(
        &self,
        expression: &Expr,
        request: &SearchRequest,
        now: i64,
    ) -> Result<SearchResponse> {
        if !request.include_stats {
            return self.search_fast(expression, request, now);
        }
        let stats_started = started(true);
        request.validate()?;
        let mut backend = BackendStats::default();

        let stage = started(true);
        self.reader.reload().map_err(storage)?;
        let searcher = self.reader.searcher();
        backend.reload_us = elapsed_us(stage);
        backend.index_docs = searcher.num_docs();
        backend.segments = u64::try_from(searcher.segment_readers().len()).unwrap_or(u64::MAX);

        let stage = started(true);
        let fingerprint = fingerprint(&searcher, expression, request.sort, request.limit)?;
        backend.fingerprint_us = elapsed_us(stage);

        let stage = started(true);
        let (offset, now) = cursor_bounds(request, &fingerprint, now)?;
        backend.cursor_us = elapsed_us(stage);

        let stage = started(true);
        let query = self.compile(expression)?;
        backend.compile_us = elapsed_us(stage);

        let page_limit = request.limit.min(MAX_WINDOW.saturating_sub(offset));
        let collector = TopDocs::with_limit(page_limit.saturating_add(1))
            .and_offset(offset)
            .order_by(scoring::Ranking {
                sort: request.sort,
                now,
            });
        let stage = started(true);
        let hits = searcher.search(&query, &collector).map_err(storage)?;
        backend.retrieve_us = elapsed_us(stage);
        backend.candidate_hits = u64::try_from(hits.len()).unwrap_or(u64::MAX);
        backend.ranking_calls = backend.candidate_hits;
        let more = hits.len() > page_limit;

        let stage = started(true);
        let rows = hits
            .into_iter()
            .take(page_limit)
            .map(|(_, address)| {
                let document = searcher.doc::<TantivyDocument>(address).map_err(storage)?;
                let raw = document
                    .get_first(self.fields.post)
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| storage("Missing stored post"))?;
                serde_json::from_str(raw).map_err(storage)
            })
            .collect::<Result<Vec<Post>>>()?;
        backend.materialize_us = elapsed_us(stage);
        backend.returned_rows = u64::try_from(rows.len()).unwrap_or(u64::MAX);

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
        backend.total_us = elapsed_us(stats_started);
        Ok(SearchResponse {
            rows,
            next_cursor,
            warnings,
            stats: Some(SearchStats { backend, api: None }),
        })
    }
}
