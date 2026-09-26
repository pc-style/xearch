//! Ranking signals that need the whole corpus, not one post: each author's
//! authority (`PageRank` over who replies to, quotes and mentions whom), who
//! wrote each post and what it says (for diversity), and which posts quote
//! which (to show quotes under results).
//!
//! Computed by a Tantivy [`Warmer`], which runs whenever the reader loads a
//! new set of segments and finishes before searches see them. A server
//! reloads in the background, so no search waits for this. Each post's
//! stored JSON is parsed once per process and remembered by tweet id, so a
//! reload after an import or merge only parses the posts it has not seen.
use search_model::Post;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use tantivy::index::SegmentId;
use tantivy::schema::{Field, Value};
use tantivy::{DocId, Searcher, SearcherGeneration, TantivyDocument, Warmer};

/// Posts quoting a result that are kept per result, best first.
pub const QUOTES_KEPT: usize = 2;

/// Per document of one segment, by doc id. Deleted documents hold defaults.
pub struct Segment {
    /// The author's authority, as [`search_ranking::authority`] scales it.
    pub authority: Box<[f64]>,
    /// The author, as an index into the warmer's account table.
    pub author: Box<[u32]>,
    /// [`search_ranking::wording`], or `None`.
    pub wording: Box<[Option<u64>]>,
    /// [`search_ranking::is_quiet`].
    pub quiet: Box<[bool]>,
}

impl Segment {
    pub fn authority(&self, doc: DocId) -> f64 {
        self.authority.get(at(doc)).copied().unwrap_or(0.0)
    }
}

/// Everything the current searcher's segments need.
#[derive(Default)]
pub struct Signals {
    segments: HashMap<SegmentId, Arc<Segment>>,
    /// Tweet id → ids of posts quoting it, best first.
    quoted_by: Arc<HashMap<u64, Box<[u64]>>>,
}

impl Signals {
    pub fn segment(&self, id: SegmentId) -> Option<&Arc<Segment>> {
        self.segments.get(&id)
    }

    pub fn quoted_by(&self, tweet: u64) -> &[u64] {
        self.quoted_by.get(&tweet).map_or(&[], |ids| ids)
    }
}

/// What one post contributes, read from its stored JSON.
struct Facts {
    author: u32,
    targets: Box<[(u32, f32)]>,
    wording: Option<u64>,
    quotes: Option<u64>,
}

/// A stored post: its tweet id and a hash of its stored JSON. Two versions
/// of a post (a new capture, an edit) differ in the hash.
type Key = (u64, u64);

#[derive(Default)]
struct Memory {
    accounts: HashMap<String, u32>,
    /// Each segment already read: every document's key, or `None` if it was
    /// deleted when read. Segments never change, and deleted documents stay
    /// deleted, so a segment is read once.
    segments: HashMap<SegmentId, Arc<[Option<Key>]>>,
    facts: HashMap<Key, Facts>,
}

impl Memory {
    fn account(&mut self, handle: &str) -> u32 {
        let handle = handle.to_ascii_lowercase();
        let next = u32::try_from(self.accounts.len()).unwrap_or(u32::MAX);
        *self.accounts.entry(handle).or_insert(next)
    }

    fn facts(&mut self, post: &Post) -> Facts {
        let targets = search_ranking::interactions(post)
            .into_iter()
            .map(|(handle, weight)| (self.account(&handle), weight))
            .collect();
        Facts {
            author: self.account(&post.author),
            targets,
            wording: search_ranking::wording(post),
            quotes: post.quote.as_ref().and_then(|quote| status_id(&quote.url)),
        }
    }

    /// Every document's key in a segment not read before, reading the facts
    /// of posts not seen before. A merge copies posts into a new segment
    /// unchanged, so it costs reading and hashing them, not parsing.
    fn read(
        &mut self,
        reader: &tantivy::SegmentReader,
        post: Field,
    ) -> tantivy::Result<Arc<[Option<Key>]>> {
        if let Some(keys) = self.segments.get(&reader.segment_id()) {
            return Ok(Arc::clone(keys));
        }
        let ids = reader.fast_fields().u64("id")?;
        let store = reader.get_store_reader(1)?;
        let mut keys = Vec::with_capacity(at(reader.max_doc()));
        for doc in 0..reader.max_doc() {
            let alive = reader
                .alive_bitset()
                .is_none_or(|alive| alive.is_alive(doc));
            let id = ids.first(doc).unwrap_or(0);
            let document = if alive && id != 0 {
                store.get::<TantivyDocument>(doc).ok()
            } else {
                None
            };
            let Some(raw) = document
                .as_ref()
                .and_then(|document| document.get_first(post))
                .and_then(|value| value.as_str())
            else {
                keys.push(None);
                continue;
            };
            let key = (id, hash(raw));
            if !self.facts.contains_key(&key) {
                // Search stored this JSON, so it parses; if not, the post
                // just goes without signals.
                if let Ok(post) = serde_json::from_str::<Post>(raw) {
                    let facts = self.facts(&post);
                    self.facts.insert(key, facts);
                }
            }
            keys.push(Some(key));
        }
        let keys: Arc<[Option<Key>]> = keys.into();
        self.segments.insert(reader.segment_id(), Arc::clone(&keys));
        Ok(keys)
    }
}

/// A `u32` index (a doc id, an account) as a `usize`.
fn at(index: u32) -> usize {
    usize::try_from(index).unwrap_or(usize::MAX)
}

fn hash(raw: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    raw.hash(&mut hasher);
    hasher.finish()
}

/// The tweet id in an `x.com/<handle>/status/<id>` URL.
fn status_id(url: &str) -> Option<u64> {
    let (_, rest) = url.split_once("/status/")?;
    let digits = rest.split(|c: char| !c.is_ascii_digit()).next()?;
    digits.parse().ok().filter(|id| *id > 0)
}

pub struct SignalWarmer {
    post: Field,
    memory: Mutex<Memory>,
    current: RwLock<Arc<Signals>>,
}

impl SignalWarmer {
    pub fn new(post: Field) -> Self {
        Self {
            post,
            memory: Mutex::new(Memory::default()),
            current: RwLock::new(Arc::default()),
        }
    }

    /// The signals for the most recently loaded searcher.
    pub fn current(&self) -> Arc<Signals> {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn compute(&self, searcher: &Searcher) -> tantivy::Result<Signals> {
        let mut memory = self.memory.lock().unwrap_or_else(PoisonError::into_inner);
        // Each live post's key and prior, and each segment's keys by doc.
        let mut live: HashMap<Key, f64> = HashMap::new();
        let mut keys_by_segment = Vec::with_capacity(searcher.segment_readers().len());
        for reader in searcher.segment_readers() {
            let keys = memory.read(reader, self.post)?;
            let priors = reader.fast_fields().f64("engagement")?;
            let alive = reader.alive_bitset();
            let mut current: Vec<Option<Key>> = Vec::with_capacity(keys.len());
            for (doc, key) in keys.iter().enumerate() {
                let doc = DocId::try_from(doc).unwrap_or(DocId::MAX);
                // Deleted since the segment was read: an update replaced it.
                let key = key.filter(|_| alive.is_none_or(|alive| alive.is_alive(doc)));
                if let Some(key) = key {
                    live.insert(key, priors.first(doc).unwrap_or(0.0));
                }
                current.push(key);
            }
            keys_by_segment.push((reader.segment_id(), current));
        }
        let segment_ids: HashSet<SegmentId> = keys_by_segment
            .iter()
            .map(|(segment, _)| *segment)
            .collect();
        memory
            .segments
            .retain(|segment, _| segment_ids.contains(segment));
        memory.facts.retain(|key, _| live.contains_key(key));

        let mut pairs: HashMap<(u32, u32), f32> = HashMap::new();
        let mut quoted_by: HashMap<u64, Vec<(f64, u64)>> = HashMap::new();
        for (key, facts) in &memory.facts {
            for &(target, weight) in &facts.targets {
                *pairs.entry((facts.author, target)).or_default() += weight;
            }
            if let Some(quoted) = facts.quotes {
                let prior = live.get(key).copied().unwrap_or(0.0);
                quoted_by.entry(quoted).or_default().push((prior, key.0));
            }
        }
        let mut edges: Vec<(u32, u32, f32)> = pairs
            .into_iter()
            .map(|((from, to), weight)| (from, to, weight))
            .collect();
        // The same index always gets the same ranks, whatever order the
        // map iterated in, so a cursor's order survives a restart.
        edges.sort_unstable_by_key(|&(from, to, _)| (from, to));
        let authority = search_ranking::authority(memory.accounts.len(), &edges);

        let segments = keys_by_segment
            .into_iter()
            .map(|(segment, keys)| {
                let mut built = Segment {
                    authority: vec![0.0; keys.len()].into(),
                    author: vec![u32::MAX; keys.len()].into(),
                    wording: vec![None; keys.len()].into(),
                    quiet: vec![false; keys.len()].into(),
                };
                for (doc, key) in keys.iter().enumerate() {
                    let Some((key, facts)) =
                        key.and_then(|key| Some((key, memory.facts.get(&key)?)))
                    else {
                        continue;
                    };
                    if let Some(slot) = built.authority.get_mut(doc) {
                        *slot = authority.get(at(facts.author)).copied().unwrap_or(0.0);
                    }
                    if let Some(slot) = built.author.get_mut(doc) {
                        *slot = facts.author;
                    }
                    if let Some(slot) = built.wording.get_mut(doc) {
                        *slot = facts.wording;
                    }
                    if let Some(slot) = built.quiet.get_mut(doc) {
                        *slot = search_ranking::is_quiet(live.get(&key).copied().unwrap_or(0.0));
                    }
                }
                (segment, Arc::new(built))
            })
            .collect();
        let quoted_by = Arc::new(
            quoted_by
                .into_iter()
                .map(|(quoted, mut quoting)| {
                    quoting.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
                    let best: Box<[u64]> = quoting
                        .into_iter()
                        .filter(|(_, id)| *id != quoted)
                        .take(QUOTES_KEPT)
                        .map(|(_, id)| id)
                        .collect();
                    (quoted, best)
                })
                .collect(),
        );
        drop(memory);
        Ok(Signals {
            segments,
            quoted_by,
        })
    }
}

impl Warmer for SignalWarmer {
    fn warm(&self, searcher: &Searcher) -> tantivy::Result<()> {
        let mut signals = self.compute(searcher)?;
        let mut current = self.current.write().unwrap_or_else(PoisonError::into_inner);
        // A search that took the previous searcher just before this one is
        // published still finds its segments; garbage collection drops them
        // once no searcher uses them.
        for (id, segment) in &current.segments {
            signals
                .segments
                .entry(*id)
                .or_insert_with(|| Arc::clone(segment));
        }
        *current = Arc::new(signals);
        drop(current);
        Ok(())
    }

    fn garbage_collect(&self, live: &[&SearcherGeneration]) {
        let used: HashSet<SegmentId> = live
            .iter()
            .flat_map(|generation| generation.segments().keys().copied())
            .collect();
        let mut current = self.current.write().unwrap_or_else(PoisonError::into_inner);
        if current.segments.keys().all(|id| used.contains(id)) {
            return;
        }
        let segments = current
            .segments
            .iter()
            .filter(|(id, _)| used.contains(id))
            .map(|(id, segment)| (*id, Arc::clone(segment)))
            .collect();
        let quoted_by = Arc::clone(&current.quoted_by);
        *current = Arc::new(Signals {
            segments,
            quoted_by,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::status_id;

    #[test]
    fn status_ids_come_from_post_urls() {
        assert_eq!(status_id("https://x.com/theo/status/123?s=20"), Some(123));
        assert_eq!(
            status_id("https://x.com/theo/status/123/photo/1"),
            Some(123)
        );
        assert_eq!(status_id("https://x.com/theo"), None);
        assert_eq!(status_id("https://x.com/theo/status/0"), None);
    }
}
