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
            .map(|p| p.tweet_id.to_string())
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
                .map(|p| p.tweet_id.to_string())
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
    assert_eq!(
        all(&engine, request("\"to be or not to be\" from:alice"))
            .unwrap()
            .len(),
        0
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
                .map(|p| p.tweet_id)
                .collect::<BTreeSet<_>>();
            let results = all(&engine, request(&raw)).unwrap();
            let actual = results.iter().map(|p| p.tweet_id).collect::<BTreeSet<_>>();
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
                .map(|p| p.tweet_id.to_string())
                .collect::<Vec<_>>(),
            ["3", "1"]
        );
    }
}

#[test]
fn count_author_deduplicates_reimports_and_normalizes_the_handle() {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    let mut bob = post(1, "hello");
    bob.author = "bob".into();
    {
        let mut writer = engine.writer().unwrap();
        writer.upsert(&bob).unwrap();
        writer.commit().unwrap();
    }
    assert_eq!(engine.count_author("bob").unwrap(), 1, "one post so far");
    assert_eq!(
        engine.count_author("@Bob").unwrap(),
        1,
        "author counting must normalize like ingestion does"
    );
    assert_eq!(engine.count_author("alice").unwrap(), 0);

    // Re-importing the exact same tweet id must not double the count: this
    // is what makes count_author an honest uniquePostCount source per
    // docs/publication-contract.md, unlike a running import counter.
    {
        let mut writer = engine.writer().unwrap();
        writer.upsert(&bob).unwrap();
        writer.commit().unwrap();
    }
    assert_eq!(
        engine.count_author("bob").unwrap(),
        1,
        "reimporting the same post must not inflate the unique count"
    );

    let mut second = post(2, "world");
    second.author = "bob".into();
    {
        let mut writer = engine.writer().unwrap();
        writer.upsert(&second).unwrap();
        writer.commit().unwrap();
    }
    assert_eq!(
        engine.count_author("bob").unwrap(),
        2,
        "a genuinely new post must be counted"
    );
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
    assert_eq!(resp.warnings.len(), 0);
}

fn segments(engine: &search_tantivy::Engine) -> search_model::Result<u64> {
    let mut stats = request("hello");
    stats.include_stats = true;
    let expr = search_query::parse(&stats.query, None)?;
    let response = engine.search(&expr, &stats, 1_800_000_000_000)?;
    response
        .stats
        .map(|stats| stats.backend.segments)
        .ok_or_else(|| Error::Invalid("stats requested but missing".into()))
}

#[test]
fn one_writer_per_import_still_lets_segments_merge() {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    // The indexer's shape: a fresh writer per import, dropped right after
    // its commit. Without waiting for merges this left 40 segments.
    for id in 1..=40 {
        let mut writer = engine.writer().unwrap();
        writer.upsert(&post(id, "hello")).unwrap();
        writer.commit().unwrap();
    }
    assert!(segments(&engine).unwrap() < 20, "segments never merged");
    assert_eq!(all(&engine, request("hello")).unwrap().len(), 40);
}

#[test]
fn compact_merges_to_one_segment_and_keeps_every_post() {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    for id in 1..=5 {
        let mut writer = engine.writer().unwrap();
        writer.upsert(&post(id, "hello")).unwrap();
        writer.commit().unwrap();
    }
    assert!(engine.compact().unwrap() >= 1);
    assert_eq!(segments(&engine).unwrap(), 1);
    assert_eq!(all(&engine, request("hello")).unwrap().len(), 5);
}

#[test]
fn a_search_sees_a_commit_made_after_the_previous_search() {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    {
        let mut writer = engine.writer().unwrap();
        writer.upsert(&post(1, "hello")).unwrap();
        writer.commit().unwrap();
    }
    assert_eq!(all(&engine, request("hello")).unwrap().len(), 1);
    // A second process (the indexer) commits; `serve` must pick it up
    // without reloading on every search.
    let other = search_tantivy::open(dir.path(), false).unwrap();
    {
        let mut writer = other.writer().unwrap();
        writer.upsert(&post(2, "hello")).unwrap();
        writer.commit().unwrap();
    }
    assert_eq!(all(&engine, request("hello")).unwrap().len(), 2);
}

#[test]
fn plurals_match_totals_count_and_side_by_side_words_rank_first() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    for post in [
        post(1, "my new ssd"),
        post(2, "cheap SSDs today"),
        post(3, "two batteries"),
        post(4, "first we went local"),
        post(5, "local first apps"),
        post(6, "the news today"),
        post(7, "something new"),
    ] {
        writer.upsert(&post).unwrap();
    }
    writer.commit().unwrap();
    let ids = |query: &str| {
        all(&engine, request(query))
            .unwrap()
            .iter()
            .map(|p| p.tweet_id.to_string())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(ids("ssd"), BTreeSet::from(["1".into(), "2".into()]));
    assert_eq!(ids("ssds"), BTreeSet::from(["1".into(), "2".into()]));
    assert_eq!(ids("battery"), BTreeSet::from(["3".into()]));
    // Quoted words and non-plurals stay exact.
    assert_eq!(ids("\"ssds\""), BTreeSet::from(["2".into()]));
    assert_eq!(ids("news"), BTreeSet::from(["6".into()]));

    let expr = search_query::parse("local first", None).unwrap();
    let mut first_page = request("local first");
    first_page.limit = 1;
    let response = engine
        .search(&expr, &first_page, 1_800_000_000_000)
        .unwrap();
    assert_eq!(response.total, Some(2));
    assert_eq!(response.rows[0].tweet_id.to_string(), "5");
    first_page.cursor = response.next_cursor;
    let next = engine
        .search(&expr, &first_page, 1_800_000_000_000)
        .unwrap();
    assert_eq!(next.total, None, "only the first page counts");
}

#[test]
fn replies_to_others_rank_below_equal_posts() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    let mut reply = post(1, "rust is fast");
    reply.likes = Some(10);
    reply.reply_to = Some("bob".into());
    let mut own = post(2, "rust is fast");
    own.likes = Some(10);
    let mut thread = post(3, "rust is fast");
    thread.likes = Some(10);
    thread.reply_to = Some("alice".into());
    for post in [reply, own, thread] {
        writer.upsert(&post).unwrap();
    }
    writer.commit().unwrap();
    let order = all(&engine, request("rust"))
        .unwrap()
        .iter()
        .map(|p| p.tweet_id.to_string())
        .collect::<Vec<_>>();
    assert_eq!(order.last().map(String::as_str), Some("1"));
}

#[test]
fn reply_handles_are_not_searched_and_thin_posts_rank_last() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    // Only the reply chain says "beyang": not a match.
    let mut chain = post(1, "@beyang @theo nice");
    chain.reply_to = Some("beyang".into());
    // Named in what the author wrote: a match.
    let mut named = post(2, "@sqs ask beyang about it");
    named.reply_to = Some("sqs".into());
    // The same words, but one says almost nothing.
    let thin = post(3, "rust lol");
    let full = post(4, "rust compile times are fine now");
    for post in [chain, named, thin, full] {
        writer.upsert(&post).unwrap();
    }
    writer.commit().unwrap();
    let ids = |query| {
        all(&engine, request(query))
            .unwrap()
            .iter()
            .map(|p| p.tweet_id.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids("beyang"), ["2"]);
    assert_eq!(ids("rust"), ["4", "3"]);
}

#[test]
fn a_serving_engine_picks_up_commits_in_the_background() {
    let directory = tempfile::tempdir().unwrap();
    // Create the index, as the indexer would.
    let indexer = search_tantivy::open(directory.path(), true).unwrap();
    let mut writer = indexer.writer().unwrap();
    writer.upsert(&post(1, "rust")).unwrap();
    writer.commit().unwrap();
    let server = search_tantivy::open_for_serving(directory.path()).unwrap();
    assert_eq!(all(&server, request("rust")).unwrap().len(), 1);
    writer.upsert(&post(2, "rust again")).unwrap();
    writer.commit().unwrap();
    // Tantivy polls meta.json every 500 ms.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while all(&server, request("rust")).unwrap().len() < 2 {
        assert!(
            std::time::Instant::now() < deadline,
            "commit never showed up"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn by(id: u32, author: &str, text: &str, likes: u32) -> Post {
    let mut post = post(id, text);
    post.author = author.into();
    post.url = format!("https://x.com/{author}/status/{id}");
    post.likes = Some(likes);
    post
}

fn ids(posts: &[Post]) -> Vec<u64> {
    posts.iter().map(|post| post.tweet_id.0).collect()
}

#[test]
fn cited_authors_rank_first_among_equal_posts() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open_for_search(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    // Everyone mentions "cited"; nobody mentions "plain".
    let mut posts = vec![
        by(1, "plain", "rust compile times are fine now", 50),
        by(2, "cited", "rust compile times are fine now", 50),
    ];
    for (offset, fan) in ["a", "b", "c", "d"].into_iter().enumerate() {
        let id = 10 + u32::try_from(offset).unwrap();
        posts.push(by(id, fan, "thanks @cited for the help today", 5));
    }
    for post in &posts {
        writer.upsert(post).unwrap();
    }
    writer.commit().unwrap();
    assert_eq!(ids(&all(&engine, request("rust")).unwrap()), [2, 1]);
    // Without the corpus-wide signals the tie falls to the tweet id.
    let plain = search_tantivy::open(directory.path(), false).unwrap();
    assert_eq!(ids(&all(&plain, request("rust")).unwrap()), [1, 2]);
}

#[test]
fn diversity_makes_room_for_others_but_not_for_quiet_posts_or_repeats() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open_for_search(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    for post in [
        by(1, "prolific", "rust tip one about borrowing", 1000),
        by(2, "prolific", "rust tip two about lifetimes", 990),
        by(3, "prolific", "rust tip three about traits", 980),
        by(4, "prolific", "rust tip four about macros", 970),
        by(5, "other", "rust tip from someone else entirely", 900),
        by(6, "quiet", "rust tip nobody has seen yet", 0),
        by(7, "copier", "Rust tip one about borrowing!", 995),
    ] {
        writer.upsert(&post).unwrap();
    }
    writer.commit().unwrap();
    let order = ids(&all(&engine, request("rust tip")).unwrap());
    let position = |id: u64| order.iter().position(|&seen| seen == id).unwrap();
    // The other author's post moves up past prolific's later ones.
    assert!(position(5) < position(4), "{order:?}");
    // The word-for-word copy sinks below the original it repeats.
    assert!(position(7) > position(1), "{order:?}");
    // The quiet post rises past nothing.
    assert_eq!(order.last(), Some(&6), "{order:?}");
    assert_eq!(order.len(), 7);
}

#[test]
fn one_authors_results_keep_their_order() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open_for_search(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    for id in 1..=12 {
        writer
            .upsert(&by(id, "solo", "rust notes for the week", id * 10))
            .unwrap();
    }
    writer.commit().unwrap();
    let plain = search_tantivy::open(directory.path(), false).unwrap();
    assert_eq!(
        ids(&all(&engine, request("rust")).unwrap()),
        ids(&all(&plain, request("rust")).unwrap())
    );
}

#[test]
fn pages_cut_one_order_across_the_diversity_window() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open_for_search(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    let authors = ["a", "b", "c"];
    for id in 1..=150_u32 {
        let author = authors[usize::try_from(id).unwrap() % 3];
        let text = format!("rust post number {id}");
        writer.upsert(&by(id, author, &text, id % 40)).unwrap();
    }
    writer.commit().unwrap();
    for limit in [7, 20] {
        let mut paged = request("rust");
        paged.limit = limit;
        let order = ids(&all(&engine, paged).unwrap());
        assert_eq!(order.len(), 150, "limit {limit}");
        assert_eq!(
            order.iter().collect::<BTreeSet<_>>().len(),
            150,
            "limit {limit}"
        );
    }
    let mut small = request("rust");
    small.limit = 7;
    let mut large = request("rust");
    large.limit = 20;
    assert_eq!(
        ids(&all(&engine, small).unwrap()),
        ids(&all(&engine, large).unwrap())
    );
}

#[test]
fn results_show_the_best_posts_quoting_them() {
    let directory = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open_for_search(directory.path(), true).unwrap();
    let mut writer = engine.writer().unwrap();
    let original = by(1, "theo", "the ssd speeds are wild", 500);
    let quote = |id: u32, author: &str, text: &str, likes: u32| {
        let mut post = by(id, author, text, likes);
        post.quote = Some(search_model::Quote {
            url: "https://x.com/theo/status/1".into(),
            author: "theo".into(),
            display_name: None,
            text: "the ssd speeds are wild".into(),
            created_at: None,
            image: None,
        });
        post
    };
    for post in [
        original,
        quote(2, "fan", "agreed, benchmarks inside", 3),
        quote(3, "critic", "these numbers are misleading", 400),
        quote(4, "lurker", "same thoughts here honestly", 40),
    ] {
        writer.upsert(&post).unwrap();
    }
    writer.commit().unwrap();
    let rows = all(&engine, request("ssd")).unwrap();
    let theo = rows.iter().find(|post| post.tweet_id.0 == 1).unwrap();
    let quoted: Vec<&str> = theo.quoted_by.iter().map(|q| q.author.as_str()).collect();
    assert_eq!(quoted, ["critic", "lurker"]);
    assert_eq!(theo.quoted_by[0].url, "https://x.com/critic/status/3");
    // A quote is shown under what it quotes, not under itself.
    let critic = all(&engine, request("misleading")).unwrap();
    assert!(critic[0].quoted_by.is_empty());
    // Editing a quote into a plain post removes it after the next commit.
    writer
        .upsert(&by(3, "critic", "edited: no longer a quote", 400))
        .unwrap();
    writer.commit().unwrap();
    let rows = all(&engine, request("ssd")).unwrap();
    let quoted: Vec<&str> = rows[0]
        .quoted_by
        .iter()
        .map(|q| q.author.as_str())
        .collect();
    assert_eq!(quoted, ["lurker", "fan"]);
}
