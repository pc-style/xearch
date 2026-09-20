//! Replayable imports: retain exact input bytes, stream posts, commit, then receipt.
use search_backend::IndexSink;
use search_model::{Error, Post, Result};
use serde::{
    Deserialize, Serialize,
    de::{DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::File,
    io::{BufReader, Read, Write},
    path::Path,
};

/// Hard cap on one import's input bytes.
pub const MAX_INPUT: u64 = 64 * 1024 * 1024;

fn storage(error: impl fmt::Display) -> Error {
    Error::Storage(error.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub sha256: String,
    pub accepted: u64,
    pub rejected: u64,
}

/// Retain and import a dump envelope or an existing x.md capture envelope.
///
/// A crash before the receipt is safe to replay; source IDs are idempotent.
/// The sink is consumed: on any failure the staged (uncommitted) writer is
/// dropped here, so a poisoned writer can never be committed by a caller.
///
/// # Errors
/// Returns I/O, malformed envelope or sink errors. No receipt is written on failure.
pub fn import(input: &Path, archive: &Path, mut sink: impl IndexSink) -> Result<Receipt> {
    std::fs::create_dir_all(archive).map_err(storage)?;
    let mut source = File::open(input)
        .map_err(storage)?
        .take(MAX_INPUT.saturating_add(1));
    let mut spool = tempfile::NamedTempFile::new_in(archive).map_err(storage)?;
    let copied = std::io::copy(&mut source, &mut spool).map_err(storage)?;
    if copied > MAX_INPUT {
        return Err(Error::Invalid(
            "Input exceeds the 64 MiB import limit; split captures first.".into(),
        ));
    }
    spool.as_file().sync_all().map_err(storage)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut File::open(spool.path()).map_err(storage)?, &mut hasher).map_err(storage)?;
    let digest = format!("{:x}", hasher.finalize());
    let raw = archive.join(format!("{digest}.json"));
    if raw.exists() {
        // Verify the existing archive rather than trusting a filename after disk corruption.
        let mut previous = Sha256::new();
        std::io::copy(&mut File::open(&raw).map_err(storage)?, &mut previous).map_err(storage)?;
        if format!("{:x}", previous.finalize()) != digest {
            return Err(storage("Archive checksum mismatch"));
        }
    } else {
        spool.persist_noclobber(&raw).map_err(storage)?;
    }
    File::open(archive)
        .and_then(|dir| dir.sync_all())
        .map_err(storage)?;
    let mut quarantine = tempfile::NamedTempFile::new_in(archive).map_err(storage)?;
    let mut receipt = Receipt {
        sha256: digest.clone(),
        accepted: 0,
        rejected: 0,
    };
    let mut context = Context {
        sink: &mut sink,
        receipt: &mut receipt,
        quarantine: &mut quarantine,
        failure: None,
    };
    let mut deserializer =
        serde_json::Deserializer::from_reader(BufReader::new(File::open(&raw).map_err(storage)?));
    let parsed = Envelope(&mut context).deserialize(&mut deserializer);
    // A sink or quarantine failure halts parsing through the serde boundary;
    // report it as itself rather than as malformed input.
    if let Some(error) = context.failure.take() {
        return Err(error);
    }
    parsed.map_err(|e| Error::Invalid(e.to_string()))?;
    deserializer
        .end()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    quarantine.as_file().sync_all().map_err(storage)?;
    quarantine
        .persist(archive.join(format!("{digest}.rejected.jsonl")))
        .map_err(storage)?;
    sink.commit()?;
    let mut saved = tempfile::NamedTempFile::new_in(archive).map_err(storage)?;
    serde_json::to_writer(&mut saved, &receipt).map_err(storage)?;
    saved.as_file().sync_all().map_err(storage)?;
    saved
        .persist(archive.join(format!("{digest}.receipt.json")))
        .map_err(storage)?;
    File::open(archive)
        .and_then(|dir| dir.sync_all())
        .map_err(storage)?;
    Ok(receipt)
}

struct Context<'a> {
    sink: &'a mut dyn IndexSink,
    receipt: &'a mut Receipt,
    quarantine: &'a mut dyn Write,
    failure: Option<Error>,
}

/// Placeholder carried across the serde boundary while the real error waits in `Context`.
struct Halted;
impl fmt::Display for Halted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("import halted by a storage failure")
    }
}

impl Context<'_> {
    fn record(&mut self, value: &Value) -> std::result::Result<(), Halted> {
        if let Err(error) = self.try_record(value) {
            self.failure = Some(error);
            return Err(Halted);
        }
        Ok(())
    }

    fn try_record(&mut self, value: &Value) -> Result<()> {
        match normalize(value) {
            Ok(post) => {
                self.sink.upsert(&post)?;
                self.receipt.accepted = self.receipt.accepted.saturating_add(1);
            }
            Err(error) => {
                serde_json::to_writer(
                    &mut self.quarantine,
                    &serde_json::json!({"error": error.to_string(), "payload": value}),
                )
                .map_err(storage)?;
                self.quarantine.write_all(b"\n").map_err(storage)?;
                self.receipt.rejected = self.receipt.rejected.saturating_add(1);
            }
        }
        Ok(())
    }
}

struct Envelope<'a, 'b>(&'a mut Context<'b>);
impl<'de> DeserializeSeed<'de> for Envelope<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Envelope<'_, '_> {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an x.md posts or capture envelope")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<(), M::Error> {
        let mut found = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "posts" | "records" => {
                    if found {
                        return Err(serde::de::Error::custom("Duplicate corpus field"));
                    }
                    found = true;
                    map.next_value_seed(Records {
                        context: self.0,
                        captures: key == "records",
                    })?;
                }
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        if !found {
            return Err(serde::de::Error::custom("Missing posts or records array"));
        }
        Ok(())
    }
}

struct Records<'a, 'b> {
    context: &'a mut Context<'b>,
    captures: bool,
}
impl<'de> DeserializeSeed<'de> for Records<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Records<'_, '_> {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an array of posts")
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> std::result::Result<(), S::Error> {
        while let Some(value) = seq.next_element::<Value>()? {
            if self.captures {
                let payload = value
                    .get("payload")
                    .ok_or_else(|| serde::de::Error::custom("Missing capture payload"))?;
                // Only descend into a posts envelope when the field is a
                // real array; a malformed capture record must quarantine
                // rather than abort the whole import behind it.
                if payload.get("posts").is_some_and(Value::is_array) {
                    Envelope(self.context)
                        .deserialize(payload)
                        .map_err(serde::de::Error::custom)?;
                } else if payload.get("type").and_then(Value::as_str) != Some("profile") {
                    self.context
                        .record(payload.get("post").unwrap_or(payload))
                        .map_err(serde::de::Error::custom)?;
                }
            } else {
                self.context
                    .record(&value)
                    .map_err(serde::de::Error::custom)?;
            }
        }
        Ok(())
    }
}

/// Normalize one provider post. Unknown fields survive in the retained raw capture.
///
/// # Errors
/// Returns an error for missing identity/text or malformed counts and dates.
pub fn normalize(value: &Value) -> Result<Post> {
    let string = |v: &Value, key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| Error::Invalid(format!("Missing string {key}")))
    };
    let tweet_id = string(value, "id")?;
    let numeric = tweet_id
        .parse::<u64>()
        .map_err(|_| Error::Invalid("Invalid tweet ID".into()))?;
    if numeric == 0 || numeric.to_string() != tweet_id {
        return Err(Error::Invalid("Noncanonical tweet ID".into()));
    }
    let author_value = value
        .get("author")
        .ok_or_else(|| Error::Invalid("Missing author".into()))?;
    let author = search_query::normalize_author(&string(author_value, "screen_name")?)?;
    let author_id = string(author_value, "id")?;
    if author_id.parse::<u64>().is_err() {
        return Err(Error::Invalid("Invalid author ID".into()));
    }
    let text = string(value, "text")?;
    if text.len() > 256 * 1024 {
        return Err(Error::Invalid("Post text exceeds 256 KiB".into()));
    }
    let count = |key: &str| -> Result<Option<u32>> {
        value
            .get(key)
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| Error::Invalid(format!("Invalid {key}")))
            })
            .transpose()
    };
    let created_at = value
        .get("created_timestamp")
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_i64()
                .filter(|n| *n >= 0)
                .and_then(|n| n.checked_mul(1000))
                .ok_or_else(|| Error::Invalid("Invalid created_timestamp".into()))
        })
        .transpose()?;
    let links = value
        .get("raw_text")
        .and_then(|v| v.get("facets"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| {
            // Key off a usable https string, not key presence: a null
            // expanded_url must not shadow a valid url facet.
            ["expanded_url", "url"]
                .iter()
                .find_map(|key| v.get(*key).and_then(Value::as_str))
        })
        .filter(|s| s.starts_with("https://"))
        .map(str::to_owned)
        .collect();
    Ok(Post {
        url: format!("https://x.com/{author}/status/{tweet_id}"),
        tweet_id,
        author,
        author_id,
        text,
        created_at,
        likes: count("likes")?,
        reposts: match count("reposts")? {
            Some(n) => Some(n),
            None => count("retweets")?,
        },
        replies: count("replies")?,
        quotes: count("quotes")?,
        links,
        display_name: author_value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        avatar: author_value
            .get("avatar_url")
            .and_then(Value::as_str)
            .filter(|s| s.starts_with("https://"))
            .map(str::to_owned),
    })
}
