//! Memory-mapped Tantivy adapter. The API and ingest pipeline depend only on traits.
mod scoring;
mod signals;

use search_backend::{IndexSink, SearchBackend};
use search_model::{BackendStats, Error, Post, Result, SearchRequest, SearchResponse, SearchStats};
use search_query::Expr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ops::Bound,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime},
};
use tantivy::collector::{Count, DocSetCollector, TopDocs};
use tantivy::query::{
    AllQuery, BooleanQuery, BoostQuery, ConstScoreQuery, EmptyQuery, Occur, PhraseQuery, Query,
    RangeQuery, TermQuery,
};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing,
    TextOptions, Value,
};
use tantivy::tokenizer::{LowerCaser, SimpleTokenizer, TextAnalyzer, TokenStream};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

const MAX_WINDOW: usize = 10_000;

/// How much a plural or singular form of a searched word counts against the
/// exact spelling.
const OTHER_FORM_WEIGHT: f32 = 0.8;

/// How much searched words appearing side by side add, against the words'
/// own scores (see `Engine::adjacent`).
const ADJACENT_WEIGHT: f32 = 1.0;

/// The singular and plural of an English word, as far as a suffix can tell.
/// Deliberately small: no stemming, so `run` never matches `running` and
/// the index needs no rebuild. Only plain lowercase words of three letters
/// or more; names, numbers and code keep their exact spelling.
fn word_forms(word: &str) -> Vec<String> {
    // Words that end in "s" without being plurals of anything worth finding.
    const NOT_PLURAL: [&str; 8] = [
        "news",
        "series",
        "species",
        "always",
        "perhaps",
        "sometimes",
        "whereas",
        "towards",
    ];
    if word.len() < 3 || !word.bytes().all(|c| c.is_ascii_lowercase()) || NOT_PLURAL.contains(&word)
    {
        return Vec::new();
    }
    let sibilant = ["s", "x", "z", "ch", "sh"];
    if let Some(stem) = word.strip_suffix("ies").filter(|stem| stem.len() > 1) {
        return vec![format!("{stem}y")];
    }
    if let Some(stem) = word.strip_suffix("es")
        && sibilant.iter().any(|end| stem.ends_with(end))
    {
        return vec![stem.to_owned()];
    }
    // A stem under three letters is a word like "its", "has" or "was".
    if let Some(stem) = word.strip_suffix('s')
        && stem.len() >= 3
        && !["s", "u", "i"].iter().any(|end| stem.ends_with(end))
    {
        return vec![stem.to_owned()];
    }
    if sibilant.iter().any(|end| word.ends_with(end)) {
        return vec![format!("{word}es")];
    }
    if let Some(stem) = word.strip_suffix('y')
        && !stem.ends_with(['a', 'e', 'i', 'o', 'u'])
    {
        return vec![format!("{stem}ies")];
    }
    vec![format!("{word}s")]
}

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
/// Searches see every commit made before they start: each one checks
/// `meta.json` and reloads first if it changed. Right for the indexer,
/// which writes and counts; searches rank without the corpus-wide signals
/// (see [`open_for_search`]).
///
/// # Errors
/// Returns filesystem, incompatible schema or index errors.
pub fn open(path: &Path, create: bool) -> Result<Engine> {
    open_with(path, create, ReloadPolicy::Manual, false)
}

/// [`open`], plus the corpus-wide ranking signals.
///
/// Author authority, diversity and quotes under results (see `signals.rs`),
/// computed on each reload. Opening reads every post once, well under a
/// second for 200,000.
///
/// # Errors
/// Returns filesystem, incompatible schema or index errors.
pub fn open_for_search(path: &Path, create: bool) -> Result<Engine> {
    open_with(path, create, ReloadPolicy::Manual, true)
}

/// Open an existing index for a long-running server.
///
/// Tantivy watches `meta.json` on a background thread (polling every
/// 500 ms) and reloads there, so no search pays for a reload or waits
/// behind one; a commit from the indexer shows up within about half a
/// second.
///
/// # Errors
/// Returns filesystem, incompatible schema or index errors.
pub fn open_for_serving(path: &Path) -> Result<Engine> {
    open_with(path, false, ReloadPolicy::OnCommitWithDelay, true)
}

fn open_with(path: &Path, create: bool, policy: ReloadPolicy, signals: bool) -> Result<Engine> {
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
    let warmer = signals.then(|| Arc::new(signals::SignalWarmer::new(fields.post)));
    let mut builder = index
        .reader_builder()
        .reload_policy(policy)
        .doc_store_cache_num_blocks(8);
    if let Some(warmer) = &warmer {
        let warmer: Arc<dyn tantivy::Warmer> = warmer.clone();
        builder = builder.warmers(vec![Arc::downgrade(&warmer)]);
    }
    let reader = builder.try_into().map_err(storage)?;
    Ok(Engine {
        index,
        reader,
        fields,
        meta: path.join("meta.json"),
        loaded: Mutex::new(None),
        watched: matches!(policy, ReloadPolicy::OnCommitWithDelay),
        warmer,
    })
}

/// What identifies one version of `meta.json`. Tantivy replaces the file
/// atomically on every commit (a rename, so a new inode), so any commit —
/// from this process or the separate indexer — changes this stamp.
#[derive(Clone, Copy, PartialEq, Eq)]
struct MetaStamp {
    modified: SystemTime,
    len: u64,
    inode: u64,
}

impl MetaStamp {
    fn read(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            modified: metadata.modified().ok()?,
            len: metadata.len(),
            inode: inode(&metadata),
        })
    }
}

#[cfg(unix)]
fn inode(metadata: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(metadata)
}

#[cfg(not(unix))]
const fn inode(_: &std::fs::Metadata) -> u64 {
    0
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
    meta: PathBuf,
    /// The `meta.json` the reader last reloaded, so a search only pays for
    /// `reload()` — which reopens every segment — after a commit.
    loaded: Mutex<Option<MetaStamp>>,
    /// Tantivy reloads in the background (see [`open_for_serving`]).
    watched: bool,
    /// Computes corpus-wide signals on each reload; the reader holds it
    /// weakly, so the engine keeps it alive.
    warmer: Option<Arc<signals::SignalWarmer>>,
}

impl Engine {
    /// Create a single writer with a bounded 32 MB indexing buffer.
    ///
    /// # Errors
    /// Fails if another writer owns the lock or storage is unavailable.
    pub fn writer(&self) -> Result<Writer> {
        Ok(Writer {
            writer: Some(
                self.index
                    .writer_with_num_threads(1, 32_000_000)
                    .map_err(storage)?,
            ),
            fields: self.fields,
        })
    }

    /// Merge every segment into one and delete the files that frees.
    /// Returns how many segments there were before.
    ///
    /// For an index that grew while writers were dropped before their
    /// background merges ran (one small segment per import): search and
    /// reload cost both grow with the segment count.
    ///
    /// # Errors
    /// Fails if another writer owns the lock, or on storage errors.
    pub fn compact(&self) -> Result<usize> {
        let mut writer: IndexWriter = self
            .index
            .writer_with_num_threads(1, 32_000_000)
            .map_err(storage)?;
        let segments = self.index.searchable_segment_ids().map_err(storage)?;
        if segments.len() > 1 {
            writer.merge(&segments).wait().map_err(storage)?;
        }
        writer.garbage_collect_files().wait().map_err(storage)?;
        writer.wait_merging_threads().map_err(storage)?;
        Ok(segments.len())
    }

    /// Reload the reader if the index has been committed to since the last
    /// reload. A `stat` per search instead of reopening every segment.
    fn refresh(&self) -> Result<()> {
        if self.watched {
            return Ok(());
        }
        let stamp = MetaStamp::read(&self.meta);
        let mut loaded = self
            .loaded
            .lock()
            .map_err(|_| storage("Index reader lock poisoned"))?;
        if stamp.is_some() && *loaded == stamp {
            return Ok(());
        }
        // Stamped before reloading: a commit landing in between leaves a
        // newer stamp on disk, so the next search reloads again.
        self.reader.reload().map_err(storage)?;
        *loaded = stamp;
        drop(loaded);
        Ok(())
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

    /// One searched word, matching its singular and plural too: `ssd` finds
    /// "SSDs" and `batteries` finds "battery". The exact spelling scores a
    /// little higher. Quoted words stay exact.
    fn word(&self, term: Term) -> Box<dyn Query> {
        let forms = term.value().as_str().map(word_forms).unwrap_or_default();
        let exact = Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs));
        if forms.is_empty() {
            return exact;
        }
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Should, exact)];
        for form in forms {
            clauses.push((
                Occur::Should,
                Box::new(BoostQuery::new(
                    Box::new(TermQuery::new(
                        Term::from_field_text(self.fields.text, &form),
                        IndexRecordOption::WithFreqs,
                    )),
                    OTHER_FORM_WEIGHT,
                )),
            ));
        }
        Box::new(BooleanQuery::new(clauses))
    }

    /// For each run of plain words typed side by side (`local first`), an
    /// optional phrase that scores posts using them side by side above
    /// posts that merely contain them somewhere. It never changes which
    /// posts match.
    fn adjacent<'a>(&self, children: &'a [Expr]) -> impl Iterator<Item = Box<dyn Query>> + 'a {
        let fields = self.fields;
        children
            .chunk_by(|a, b| matches!(a, Expr::Term(_)) && matches!(b, Expr::Term(_)))
            .filter(|run| run.len() > 1 && matches!(run.first(), Some(Expr::Term(_))))
            .filter_map(move |run| {
                let mut analyzer = analyzer();
                let mut terms = Vec::new();
                for word in run {
                    let Expr::Term(word) = word else { return None };
                    let mut stream = analyzer.token_stream(word);
                    while stream.advance() {
                        terms.push(Term::from_field_text(fields.text, &stream.token().text));
                    }
                }
                (terms.len() > 1).then(|| -> Box<dyn Query> {
                    Box::new(BoostQuery::new(
                        Box::new(PhraseQuery::new(terms)),
                        ADJACENT_WEIGHT,
                    ))
                })
            })
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
                if matches!(expression, Expr::Phrase(_)) {
                    if terms.len() > 1 {
                        return Ok(Box::new(PhraseQuery::new(terms)));
                    }
                    return Ok(Box::new(BooleanQuery::new(vec![(
                        Occur::Must,
                        Box::new(TermQuery::new(
                            terms.swap_remove(0),
                            IndexRecordOption::WithFreqs,
                        )),
                    )])));
                }
                Ok(Box::new(BooleanQuery::new(
                    terms
                        .into_iter()
                        .map(|term| (Occur::Must, self.word(term)))
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
                let mut clauses = children
                    .iter()
                    .map(|child| self.compile(child).map(|query| (occur, query)))
                    .collect::<Result<Vec<_>>>()?;
                if occur == Occur::Must {
                    clauses.extend(self.adjacent(children).map(|query| (Occur::Should, query)));
                }
                Ok(Box::new(BooleanQuery::new(clauses)))
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
    /// `None` only once dropped (see `Drop`).
    writer: Option<IndexWriter>,
    fields: Fields,
}

impl Writer {
    fn inner(&mut self) -> Result<&mut IndexWriter> {
        self.writer
            .as_mut()
            .ok_or_else(|| storage("Index writer already closed"))
    }
}

/// Tantivy merges segments on background threads after a commit, and
/// dropping an `IndexWriter` abandons them. Each import used its own writer,
/// so nothing ever merged and every import left another segment behind.
impl Drop for Writer {
    fn drop(&mut self) {
        if let Some(writer) = self.writer.take()
            && let Err(error) = writer.wait_merging_threads()
        {
            eprintln!("index merge failed: {error}");
        }
    }
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
        document.add_text(self.fields.text, post.body());
        document.add_text(
            self.fields.post,
            serde_json::to_string(post).map_err(storage)?,
        );
        document.add_f64(self.fields.engagement, search_ranking::prior(post));
        if let Some(time) = post.created_at {
            document.add_i64(self.fields.created, time);
        }
        if let Some(likes) = post.likes {
            document.add_u64(self.fields.likes, u64::from(likes));
        }
        let key = Term::from_field_u64(self.fields.id, id);
        let writer = self.inner()?;
        writer.delete_term(key);
        writer.add_document(document).map_err(storage)?;
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        self.inner()?.commit().map_err(storage)?;
        Ok(())
    }
}

/// The ranked page, plus on the first page how many posts match in all.
/// Counting rides the same pass over the matches, so it costs little.
fn collect<C>(
    searcher: &tantivy::Searcher,
    query: &dyn Query,
    collector: C,
    offset: usize,
) -> Result<(Option<u64>, C::Fruit)>
where
    C: tantivy::collector::Collector,
{
    if offset > 0 {
        return Ok((None, searcher.search(query, &collector).map_err(storage)?));
    }
    let (count, hits) = searcher
        .search(query, &(Count, collector))
        .map_err(storage)?;
    Ok((Some(u64::try_from(count).unwrap_or(u64::MAX)), hits))
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

/// How many of the best results are reordered for diversity. Fixed, so
/// every page of a search is cut from the same order: the first
/// `DIVERSITY_WINDOW` results are these reordered, the rest follow as
/// ranked.
const DIVERSITY_WINDOW: usize = 100;

/// One page of ranked results.
struct Page {
    total: Option<u64>,
    hits: Vec<tantivy::DocAddress>,
    more: bool,
    candidates: usize,
}

impl Engine {
    /// Rank the query's matches and cut the page starting at `offset`.
    fn page(
        searcher: &tantivy::Searcher,
        query: &dyn Query,
        request: &SearchRequest,
        offset: usize,
        now: i64,
        signals: Option<&Arc<signals::Signals>>,
    ) -> Result<Page> {
        let page_limit = request.limit.min(MAX_WINDOW.saturating_sub(offset));
        let ranked = matches!(
            request.sort,
            search_model::Sort::Relevance | search_model::Sort::Engagement
        );
        let diversify = ranked && signals.is_some() && offset < DIVERSITY_WINDOW;
        let ranking = scoring::Ranking {
            sort: request.sort,
            now,
            signals: signals.cloned(),
        };
        if !diversify {
            let collector = TopDocs::with_limit(page_limit.saturating_add(1))
                .and_offset(offset)
                .order_by(ranking);
            let (total, hits) = collect(searcher, query, collector, offset)?;
            let candidates = hits.len();
            let more = hits.len() > page_limit;
            return Ok(Page {
                total,
                hits: hits
                    .into_iter()
                    .take(page_limit)
                    .map(|(_, address)| address)
                    .collect(),
                more,
                candidates,
            });
        }
        // Rank the whole window (and the page, if it runs past it), reorder
        // the window, then cut the page. Counted on the first page only.
        let want = DIVERSITY_WINDOW.max(offset.saturating_add(page_limit).saturating_add(1));
        let collector = TopDocs::with_limit(want).order_by(ranking);
        let (total, mut hits) = if offset == 0 {
            collect(searcher, query, collector, 0)?
        } else {
            (None, searcher.search(query, &collector).map_err(storage)?)
        };
        let candidates = hits.len();
        if let Some(signals) = signals {
            let window = hits.len().min(DIVERSITY_WINDOW);
            diversify_window(
                searcher,
                signals,
                hits.get_mut(..window).unwrap_or_default(),
            );
        }
        let more = hits.len() > offset.saturating_add(page_limit);
        Ok(Page {
            total,
            hits: hits
                .into_iter()
                .skip(offset)
                .take(page_limit)
                .map(|(_, address)| address)
                .collect(),
            more,
            candidates,
        })
    }

    /// The stored posts for `hits`, each with the best posts quoting it.
    fn rows(
        &self,
        searcher: &tantivy::Searcher,
        hits: &[tantivy::DocAddress],
        signals: Option<&Arc<signals::Signals>>,
    ) -> Result<Vec<Post>> {
        hits.iter()
            .map(|&address| {
                let mut post = self.stored(searcher, address)?;
                if let Some(signals) = signals {
                    for &quoting in signals.quoted_by(post.tweet_id.0) {
                        if let Some(quote) = self.find(searcher, quoting)? {
                            post.quoted_by.push(search_model::QuotedBy::of(&quote));
                        }
                    }
                }
                Ok(post)
            })
            .collect()
    }

    fn stored(&self, searcher: &tantivy::Searcher, address: tantivy::DocAddress) -> Result<Post> {
        let document = searcher.doc::<TantivyDocument>(address).map_err(storage)?;
        let raw = document
            .get_first(self.fields.post)
            .and_then(|value| value.as_str())
            .ok_or_else(|| storage("Missing stored post"))?;
        serde_json::from_str(raw).map_err(storage)
    }

    /// The live post with this tweet id, if the index has it.
    fn find(&self, searcher: &tantivy::Searcher, id: u64) -> Result<Option<Post>> {
        let query = TermQuery::new(
            Term::from_field_u64(self.fields.id, id),
            IndexRecordOption::Basic,
        );
        let found = searcher.search(&query, &DocSetCollector).map_err(storage)?;
        found
            .into_iter()
            .min()
            .map(|address| self.stored(searcher, address))
            .transpose()
    }

    fn signals(&self) -> Option<Arc<signals::Signals>> {
        self.warmer.as_ref().map(|warmer| warmer.current())
    }

    fn respond(
        page: &Page,
        rows: Vec<Post>,
        offset: usize,
        fingerprint: String,
        now: i64,
        stats: Option<SearchStats>,
    ) -> Result<SearchResponse> {
        let next_offset = offset.saturating_add(rows.len());
        let next_cursor = if page.more && next_offset < MAX_WINDOW {
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
        let warnings = if page.more && next_offset >= MAX_WINDOW {
            vec!["Result window capped at 10,000. Narrow your query.".into()]
        } else {
            Vec::new()
        };
        Ok(SearchResponse {
            rows,
            total: page.total,
            next_cursor,
            warnings,
            stats,
        })
    }

    // Diagnostics are opt-in; keeping this path separate avoids timer branches
    // in every default search candidate.
    fn search_fast(
        &self,
        expression: &Expr,
        request: &SearchRequest,
        now: i64,
    ) -> Result<SearchResponse> {
        request.validate()?;
        self.refresh()?;
        let searcher = self.reader.searcher();
        let signals = self.signals();
        let fingerprint = fingerprint(&searcher, expression, request.sort, request.limit)?;
        let (offset, now) = cursor_bounds(request, &fingerprint, now)?;
        let query = self.compile(expression)?;
        let page = Self::page(
            &searcher,
            query.as_ref(),
            request,
            offset,
            now,
            signals.as_ref(),
        )?;
        let rows = self.rows(&searcher, &page.hits, signals.as_ref())?;
        Self::respond(&page, rows, offset, fingerprint, now, None)
    }
}

/// Reorder the best results so one author or one wording does not fill
/// them (see [`search_ranking::diversity`]). A quiet post never rises past
/// one ranked above it: diversity makes room for other voices, not for
/// posts nobody engaged with. Stable: ties keep their rank.
fn diversify_window(
    searcher: &tantivy::Searcher,
    signals: &signals::Signals,
    hits: &mut [(scoring::Key, tantivy::DocAddress)],
) {
    let mut by_author: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    let mut wordings: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut lowest = f64::INFINITY;
    let mut adjusted: Vec<(f64, usize)> = Vec::with_capacity(hits.len());
    for (rank, ((_, ordered, _), address)) in hits.iter().enumerate() {
        let segment = searcher
            .segment_readers()
            .get(usize::try_from(address.segment_ord).unwrap_or(usize::MAX))
            .and_then(|reader| signals.segment(reader.segment_id()));
        let doc = usize::try_from(address.doc_id).unwrap_or(usize::MAX);
        let author = segment
            .and_then(|segment| segment.author.get(doc).copied())
            .filter(|author| *author != u32::MAX);
        let wording = segment.and_then(|segment| segment.wording.get(doc).copied().flatten());
        let quiet = segment.is_some_and(|segment| segment.quiet.get(doc).copied().unwrap_or(false));
        let earlier = author.map_or(0, |author| {
            let seen = by_author.entry(author).or_default();
            *seen = seen.saturating_add(1);
            seen.saturating_sub(1)
        });
        let duplicate = wording.is_some_and(|wording| !wordings.insert(wording));
        let mut score = scoring::score_of(*ordered) + search_ranking::diversity(earlier, duplicate);
        if quiet {
            score = score.min(lowest);
        }
        lowest = lowest.min(score);
        adjusted.push((score, rank));
    }
    adjusted.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let original = hits.to_vec();
    for (slot, (_, rank)) in hits.iter_mut().zip(adjusted) {
        if let Some(hit) = original.get(rank) {
            *slot = *hit;
        }
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
        self.refresh()?;
        let searcher = self.reader.searcher();
        let signals = self.signals();
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

        let stage = started(true);
        let page = Self::page(
            &searcher,
            query.as_ref(),
            request,
            offset,
            now,
            signals.as_ref(),
        )?;
        backend.retrieve_us = elapsed_us(stage);
        backend.candidate_hits = u64::try_from(page.candidates).unwrap_or(u64::MAX);
        backend.ranking_calls = backend.candidate_hits;

        let stage = started(true);
        let rows = self.rows(&searcher, &page.hits, signals.as_ref())?;
        backend.materialize_us = elapsed_us(stage);
        backend.returned_rows = u64::try_from(rows.len()).unwrap_or(u64::MAX);

        backend.total_us = elapsed_us(stats_started);
        Self::respond(
            &page,
            rows,
            offset,
            fingerprint,
            now,
            Some(SearchStats { backend, api: None }),
        )
    }
}
