mod support;
use search_backend::{IndexSink, SearchBackend};
use search_model::{Error, Post, SearchRequest, Sort};
use std::collections::BTreeSet;
use support::{post, request};

fn all(engine: &dyn SearchBackend, mut request: SearchRequest) -> search_model::Result<Vec<Post>> {
    let expr = search_query::parse(&request.query, request.author.as_deref())?;
    let mut posts = Vec::new();
    loop {
        let response = engine.search(&expr, &request, 1_800_000_000_000)?;
        posts.extend(response.rows);
        request.cursor = response.next_cursor;
        if request.cursor.is_none() {
            break;
        }
    }
    Ok(posts)
}

#[test]
fn phrases_filters_sorting_updates_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    {
        let engine = search_tantivy::open(directory.path(), true).unwrap();
        let mut writer = engine.writer().unwrap();
        let mut bob = post(3, "to be or not to be rust");
        bob.author = "bob".into();
        bob.author_id = "200".into();
        for post in [
            post(1, "to be or not to be"),
            post(2, "to not be or to be"),
            bob,
            post(4, "CAFÉ Rust"),
        ] {
            writer.upsert(&post).unwrap();
        }
        writer.commit().unwrap();
    }
    let engine = search_tantivy::open(directory.path(), false).unwrap();
    assert_eq!(
        all(&engine, request("\"to be or not to be\" from:alice"))
            .unwrap()
            .iter()
            .map(|p| p.tweet_id.as_str())
            .collect::<Vec<_>>(),
        ["1"]
    );
    assert_eq!(all(&engine, request("café")).unwrap().len(), 1);
    assert_eq!(all(&engine, request("rust -from:bob")).unwrap().len(), 1);
    assert_eq!(
        all(&engine, request("(café OR not) from:alice"))
            .unwrap()
            .len(),
        3
    );
    assert_eq!(all(&engine, request("the")).unwrap().len(), 0);
    assert_eq!(
        all(&engine, request("from:alice until:1970-01-02"))
            .unwrap()
            .len(),
        3
    );
    for (sort, expected) in [
        (Sort::Likes, vec!["4", "2", "1"]),
        (Sort::Newest, vec!["4", "2", "1"]),
        (Sort::Oldest, vec!["1", "2", "4"]),
    ] {
        let mut req = request("from:alice");
        req.sort = sort;
        req.limit = 1;
        assert_eq!(
            all(&engine, req)
                .unwrap()
                .iter()
                .map(|p| p.tweet_id.as_str())
                .collect::<Vec<_>>(),
            expected
        );
    }
    let mut req = request("from:alice");
    req.limit = 1;
    let expression = search_query::parse(&req.query, None).unwrap();
    req.cursor = engine.search(&expression, &req, 100).unwrap().next_cursor;
    let mut writer = engine.writer().unwrap();
    writer.upsert(&post(1, "edited rust")).unwrap();
    writer.commit().unwrap();
    assert!(matches!(
        engine.search(&expression, &req, 100),
        Err(Error::StaleCursor)
    ));
    assert!(
        all(&engine, request("\"to be or not to be\" from:alice"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(all(&engine, request("from:alice")).unwrap().len(), 3);
}

#[test]
fn seeded_random_queries_match_an_independent_scan_oracle() {
    // Fixed LCG seed makes failures exactly reproducible. No production corpus needed.
    let mut seed = 0x5eed_u64;
    let words = ["the", "rust", "a", "search", "and", "disk", "be", "fast"];
    let mut next = || {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        usize::try_from(seed >> 32).unwrap()
    };
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    let mut corpus = Vec::new();
    for id in 1..=150 {
        let text = (0..12)
            .map(|_| words[next().checked_rem(words.len()).unwrap()])
            .collect::<Vec<_>>()
            .join(" ");
        let mut p = post(id, &text);
        if id % 2 == 0 {
            p.author = "bob".into();
            p.author_id = "200".into();
        }
        writer.upsert(&p).unwrap();
        corpus.push(p);
    }
    writer.commit().unwrap();
    for _ in 0..100 {
        let a = words[next().checked_rem(words.len()).unwrap()];
        let b = words[next().checked_rem(words.len()).unwrap()];
        for (raw, phrase) in [
            (format!("{a} {b} from:alice"), false),
            (format!("\"{a} {b}\" from:alice"), true),
        ] {
            let expected = corpus
                .iter()
                .filter(|post| {
                    let tokens = post.text.split_whitespace().collect::<Vec<_>>();
                    post.author == "alice"
                        && if phrase {
                            tokens.windows(2).any(|pair| pair == [a, b])
                        } else {
                            tokens.contains(&a) && tokens.contains(&b)
                        }
                })
                .map(|p| p.tweet_id.clone())
                .collect::<BTreeSet<_>>();
            let results = all(&engine, request(&raw)).unwrap();
            let actual = results
                .iter()
                .map(|p| p.tweet_id.clone())
                .collect::<BTreeSet<_>>();
            assert_eq!(actual.len(), results.len(), "duplicate pagination: {raw}");
            assert_eq!(actual, expected, "oracle mismatch: {raw}");
        }
    }
}

#[test]
fn absent_metrics_sort_last_and_popularity_never_relaxes_matching() {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    let mut missing = post(1, "rust");
    missing.likes = None;
    missing.created_at = None;
    let mut viral = post(2, "unrelated");
    viral.likes = Some(u32::MAX);
    for p in [missing, viral, post(3, "rust")] {
        writer.upsert(&p).unwrap();
    }
    writer.commit().unwrap();
    for sort in [Sort::Likes, Sort::Oldest, Sort::Newest, Sort::Engagement] {
        let mut req = request("rust");
        req.sort = sort;
        assert_eq!(
            all(&engine, req)
                .unwrap()
                .iter()
                .map(|p| p.tweet_id.as_str())
                .collect::<Vec<_>>(),
            ["3", "1"]
        );
    }
}

#[test]
fn pagination_window_capping_and_warning() {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    for id in 1..=5 {
        writer.upsert(&post(id, "rust test")).unwrap();
    }
    writer.commit().unwrap();

    let mut req = request("rust");
    req.limit = 2;
    let expr = search_query::parse(&req.query, None).unwrap();
    let first = engine.search(&expr, &req, 100).unwrap();
    let cursor_json: serde_json::Value =
        serde_json::from_str(first.next_cursor.as_ref().unwrap()).unwrap();
    let fingerprint = cursor_json["fingerprint"].as_str().unwrap().to_string();

    // Fabricate a cursor near MAX_WINDOW (offset 9998) when corpus has only 5 items.
    let near_window_cursor = serde_json::json!({
        "fingerprint": fingerprint,
        "offset": 9998,
        "now": 100,
    })
    .to_string();

    req.cursor = Some(near_window_cursor);
    req.limit = 2;
    let resp = engine.search(&expr, &req, 100).unwrap();
    assert_eq!(resp.rows.len(), 0);
    assert_eq!(resp.next_cursor, None);
    // Crucially: no false warning that window was capped when results simply ended.
    assert!(resp.warnings.is_empty());
}
