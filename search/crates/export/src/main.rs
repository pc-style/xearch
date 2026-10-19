//! Streaming JSONL adapter. The final receipt exists only after valid EOF.
use search_ingest::ReplayObserver;
use search_model::{Error, Post, Result};
use std::{
    io::{BufWriter, Write},
    path::Path,
};

struct Output<W: Write>(W);
impl<W: Write> ReplayObserver for Output<W> {
    fn post(&mut self, observed_at_ms: Option<i64>, ordinal: u64, post: &Post) -> Result<()> {
        serde_json::to_writer(
            &mut self.0,
            &serde_json::json!({
                "type": "post", "version": 1, "post": post, "searchable": post.searchable(),
                "observedAtMs": observed_at_ms, "ordinal": ordinal,
            }),
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
        self.0
            .write_all(b"\n")
            .map_err(|e| Error::Storage(e.to_string()))
    }
}
fn main() -> Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or_else(|| Error::Invalid("Usage: xearch-export CAPTURE.json".into()))?;
    let mut output = Output(BufWriter::new(std::io::stdout().lock()));
    let receipt = search_ingest::replay_observed(Path::new(&path), &mut output)?;
    serde_json::to_writer(&mut output.0, &serde_json::json!({
        "type": "receipt", "version": 1, "accepted": receipt.accepted, "rejected": receipt.rejected,
        "normalizer": "search-ingest-v1", "textPolicy": "post-searchable-v1",
    })).map_err(|e| Error::Storage(e.to_string()))?;
    output
        .0
        .write_all(b"\n")
        .map_err(|e| Error::Storage(e.to_string()))?;
    output.0.flush().map_err(|e| Error::Storage(e.to_string()))
}
