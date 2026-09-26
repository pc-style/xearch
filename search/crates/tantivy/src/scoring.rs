use crate::signals::{Segment, Signals};
use search_model::Sort;
use std::cmp::Reverse;
use std::sync::Arc;
use tantivy::collector::sort_key::NaturalComparator;
use tantivy::collector::{SegmentSortKeyComputer, SortKeyComputer};
use tantivy::columnar::Column;
use tantivy::{DocId, Score, SegmentReader};

pub struct Ranking {
    pub sort: Sort,
    pub now: i64,
    /// Corpus-wide signals, when the engine computes them.
    pub signals: Option<Arc<Signals>>,
}

pub type Key = (bool, u64, Reverse<u64>);

pub struct SegmentRanking {
    sort: Sort,
    now: i64,
    id: Column<u64>,
    likes: Column<u64>,
    created: Column<i64>,
    engagement: Column<f64>,
    signals: Option<Arc<Segment>>,
}

impl SortKeyComputer for Ranking {
    type SortKey = Key;
    type Child = SegmentRanking;
    type Comparator = NaturalComparator;
    fn requires_scoring(&self) -> bool {
        matches!(self.sort, Sort::Relevance | Sort::Engagement)
    }
    fn segment_sort_key_computer(&self, reader: &SegmentReader) -> tantivy::Result<Self::Child> {
        let fields = reader.fast_fields();
        Ok(SegmentRanking {
            sort: self.sort,
            now: self.now,
            id: fields.u64("id")?,
            likes: fields.u64("likes")?,
            created: fields.i64("created")?,
            engagement: fields.f64("engagement")?,
            signals: self
                .signals
                .as_ref()
                .and_then(|signals| signals.segment(reader.segment_id()))
                .cloned(),
        })
    }
}

/// An `f64` as a `u64` that sorts the same way, negatives included (the
/// raw bits of a negative float sort backwards and above every positive).
const fn ordered_f64(value: f64) -> u64 {
    let bits = value.to_bits();
    if value.is_sign_negative() {
        !bits
    } else {
        bits | (1 << 63)
    }
}

/// The score [`ordered_f64`] encoded.
pub const fn score_of(ordered: u64) -> f64 {
    f64::from_bits(if ordered >> 63 == 1 {
        ordered & !(1 << 63)
    } else {
        !ordered
    })
}

impl SegmentSortKeyComputer for SegmentRanking {
    type SortKey = Key;
    type SegmentSortKey = Key;
    type SegmentComparator = NaturalComparator;
    fn segment_sort_key(&mut self, doc: DocId, score: Score) -> Key {
        let created = self.created.first(doc);
        let (present, value) = match self.sort {
            Sort::Relevance | Sort::Engagement => {
                let weights = if self.sort == Sort::Relevance {
                    search_ranking::RELEVANT
                } else {
                    search_ranking::POPULAR
                };
                let value = search_ranking::score(
                    weights,
                    score,
                    self.engagement.first(doc).unwrap_or(0.0),
                    self.signals
                        .as_ref()
                        .map_or(0.0, |signals| signals.authority(doc)),
                    created,
                    self.now,
                );
                (true, ordered_f64(value))
            }
            Sort::Likes => {
                let likes = self.likes.first(doc);
                (likes.is_some(), likes.unwrap_or(0))
            }
            Sort::Newest | Sort::Oldest => {
                let ordered =
                    u64::from_ne_bytes(created.unwrap_or(0).to_ne_bytes()) ^ (1_u64 << 63);
                (
                    created.is_some(),
                    if self.sort == Sort::Newest {
                        ordered
                    } else {
                        u64::MAX.saturating_sub(ordered)
                    },
                )
            }
        };
        (present, value, Reverse(self.id.first(doc).unwrap_or(0)))
    }
    fn convert_segment_sort_key(&self, key: Key) -> Key {
        key
    }
}

#[cfg(test)]
mod tests {
    use super::{ordered_f64, score_of};

    #[test]
    fn scores_round_trip_through_their_sort_key() {
        for value in [-3.5, -0.0, 0.0, 1e-9, 2.25, f64::MAX, f64::MIN] {
            assert_eq!(score_of(ordered_f64(value)).to_bits(), value.to_bits());
        }
        assert!(ordered_f64(-1.0) < ordered_f64(-0.5) && ordered_f64(-0.5) < ordered_f64(0.5));
    }
}
