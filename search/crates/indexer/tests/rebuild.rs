use search_backend::SearchBackend;
use search_indexer::{Config, rebuild, run_once};
use search_model::{SearchRequest, Sort};
use search_tantivy::INDEX_FORMAT;
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn config_in(dir: &Path) -> Result<Config> {
    let config = Config {
        index: dir.join("index"),
        archive: dir.join("archive"),
        drop_dir: dir.join("drop"),
        state_dir: dir.join("state"),
        poll_interval: Duration::from_secs(1),
        publish: None,
        health: None,
    };
    std::fs::create_dir_all(&config.drop_dir)?;
    Ok(config)
}

/// Drop a capture batch holding post 7 with `likes`, arrived at `arrived`.
fn capture(config: &Config, name: char, likes: u32, arrived: SystemTime) -> Result<()> {
    let path = config
        .drop_dir
        .join(format!("{}.json", name.to_string().repeat(64)));
    let body = serde_json::json!({
        "version": 1,
        "runId": "run",
        "source": "x-md",
        "terminal": "complete",
        "request": {"origin": "https://mdfromx.com", "resource": "live", "input": "from:hero"},
        "records": [{"receivedAt": 1, "payload": {"posts": [{
            "id": "7",
            "author": {"screen_name": "hero", "id": "42"},
            "text": "hello world",
            "created_timestamp": 1_758_000_000_i64,
            "likes": likes,
        }]}}],
    });
    std::fs::write(&path, body.to_string())?;
    std::fs::File::options()
        .write(true)
        .open(&path)?
        .set_modified(arrived)?;
    Ok(())
}

fn likes(config: &Config) -> Result<Option<u32>> {
    let engine = search_tantivy::open(&config.index, false)?;
    let expression = search_query::parse("hello", None)?;
    let request = SearchRequest {
        version: 1,
        query: "hello".into(),
        author: None,
        sort: Sort::Relevance,
        limit: 20,
        cursor: None,
        include_stats: false,
    };
    let response = engine.search(&expression, &request, 0)?;
    Ok(response.rows.first().and_then(|post| post.likes))
}

fn format(config: &Config) -> Result<u32> {
    Ok(search_tantivy::open(&config.index, false)?.format()?)
}

/// Make the index look committed by a binary from before formats were
/// stamped: same posts, no payload in `meta.json`.
fn unstamp(config: &Config) -> Result<()> {
    let path = config.index.join("meta.json");
    let mut meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    if let Some(meta) = meta.as_object_mut() {
        meta.insert("payload".into(), serde_json::Value::Null);
    }
    std::fs::write(&path, meta.to_string())?;
    Ok(())
}

fn hours_ago(hours: u64) -> Result<SystemTime> {
    SystemTime::now()
        .checked_sub(Duration::from_secs(hours.saturating_mul(3600)))
        .ok_or_else(|| "clock before the epoch".into())
}

#[test]
fn the_latest_capture_wins_whatever_its_name() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path()).unwrap();
    // The newer capture sorts first by name.
    capture(&config, '0', 20, hours_ago(1).unwrap()).unwrap();
    capture(&config, 'f', 10, hours_ago(2).unwrap()).unwrap();
    run_once(&config).unwrap();
    assert_eq!(likes(&config).unwrap(), Some(20));
}

#[test]
fn an_index_built_the_old_way_is_rebuilt_on_the_next_pass() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path()).unwrap();
    capture(&config, 'f', 10, hours_ago(2).unwrap()).unwrap();
    capture(&config, '0', 20, hours_ago(1).unwrap()).unwrap();
    run_once(&config).unwrap();
    assert_eq!(format(&config).unwrap(), INDEX_FORMAT);

    unstamp(&config).unwrap();
    assert_eq!(format(&config).unwrap(), 0);
    // An ordinary import does not make an old index current.
    capture(&config, 'a', 20, SystemTime::now()).unwrap();
    {
        let engine = search_tantivy::open(&config.index, false).unwrap();
        search_ingest::import(
            &config.drop_dir.join(format!("{}.json", "a".repeat(64))),
            &config.archive,
            engine.writer().unwrap(),
        )
        .unwrap();
    }
    assert_eq!(format(&config).unwrap(), 0);

    run_once(&config).unwrap();
    assert_eq!(format(&config).unwrap(), INDEX_FORMAT);
    // Replayed in the order the captures arrived: the latest numbers stay.
    assert_eq!(likes(&config).unwrap(), Some(20));
    assert!(!rebuild::failure_path(&config.state_dir).exists());
}

#[test]
fn a_rebuild_never_drops_posts_the_archive_has_lost() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path()).unwrap();
    capture(&config, 'f', 10, hours_ago(1).unwrap()).unwrap();
    run_once(&config).unwrap();
    std::fs::remove_dir_all(&config.archive).unwrap();
    std::fs::create_dir_all(&config.archive).unwrap();

    rebuild::request(&config.state_dir).unwrap();
    let error = run_once(&config).unwrap_err().to_string();
    assert!(error.contains("not rebuilding"), "{error}");
    assert_eq!(
        likes(&config).unwrap(),
        Some(10),
        "the old index still serves"
    );
    assert!(rebuild::failure_path(&config.state_dir).exists());
    assert!(!rebuild::request_path(&config.state_dir).exists());

    // An old index whose rebuild just failed waits before trying again.
    unstamp(&config).unwrap();
    run_once(&config).unwrap();
    assert_eq!(format(&config).unwrap(), 0);
}

#[test]
fn a_rebuild_by_hand_replaces_every_post_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path()).unwrap();
    capture(&config, 'f', 10, hours_ago(2).unwrap()).unwrap();
    capture(&config, '0', 20, hours_ago(1).unwrap()).unwrap();
    run_once(&config).unwrap();

    let engine = search_tantivy::open(&config.index, false).unwrap();
    let rebuilt = rebuild::rebuild(&config.archive, &engine).unwrap();
    assert_eq!((rebuilt.files, rebuilt.skipped, rebuilt.posts), (2, 0, 1));
    assert_eq!(engine.num_docs().unwrap(), 1);
    assert_eq!(likes(&config).unwrap(), Some(20));
}

/// What the index holds for a post, for every shape of post the importer
/// knows. Changing any of it without bumping [`INDEX_FORMAT`] would leave
/// production's older posts as they were, so this pins the two together:
/// when it fails, bump `INDEX_FORMAT` (search/crates/tantivy) and paste the
/// new fingerprint.
#[test]
fn what_is_indexed_changes_only_with_the_index_format() {
    use sha2::Digest;
    let raw = serde_json::json!([
        {
            "id": "1", "author": {"screen_name": "Hero", "id": "42", "name": "Hero"},
            "text": "@sidekick ship it https://t.co/abc see @perplexity_ai",
            "created_timestamp": 1_758_000_000_i64,
            "likes": 10, "replies": 2, "retweets": 3, "quotes": 1, "bookmarks": 4,
            "replying_to": {"screen_name": "sidekick"},
            "raw_text": {"facets": [{"type": "url", "expanded_url": "https://example.com/a"}]},
        },
        {
            "id": "2", "author": {"screen_name": "hero", "id": "42"}, "text": "lol",
            "created_timestamp": 1_758_000_001_i64, "likes": 0,
        },
        {
            "id": "3", "author": {"screen_name": "hero", "id": "42"},
            "text": "read this https://example.com/post",
            "created_timestamp": 1_758_000_002_i64, "likes": 5,
            "card": {"url": "https://example.com/post", "title": "A post", "domain": "example.com"},
            "media": {"all": [{"type": "photo", "url": "https://pbs.twimg.com/media/a.jpg"}]},
            "quote": {
                "url": "https://x.com/other/status/9",
                "author": {"screen_name": "other", "name": "Other"},
                "text": "quoted words",
            },
        },
    ]);
    let mut hash = sha2::Sha256::new();
    for value in raw.as_array().unwrap() {
        let post = search_ingest::normalize(value).unwrap();
        hash.update(serde_json::to_vec(&post).unwrap());
        hash.update(post.searchable().as_bytes());
        hash.update(search_ranking::prior(&post).to_bits().to_le_bytes());
    }
    let fingerprint = format!("{:x}", hash.finalize());
    assert_eq!(
        (INDEX_FORMAT, fingerprint.as_str()),
        (
            1,
            "1ee343d98b37b295d50d8fb5529c6ea5761a613167af6f95df862d49542e66ef"
        )
    );
}
