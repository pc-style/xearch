# Indexing and data-service boundary

This is the integration contract proposed by the application side. A temporary loopback raw-file receiver now exists in `scripts/capture-server.mjs` at the user's request. It does not implement normalization or corpus search. The collaborator can replace it without changing the product workflow.

## Responsibilities

**This build:** choose the x.md endpoint, collect raw payloads, attach request/receipt timestamps, pin account identity, batch transport, retry transient failures, track acknowledgments in Convex, expose live job state. It also acquires web pages through Firecrawl.

**Data service:** durably retain raw captures, normalize deterministically, validate complete ingress fields, retain/quarantine rejected input, deduplicate posts, apply edits/deletes/metrics policies, store the corpus, and provide ranked search pages. Import completion in this app means raw handoff completed, not that all records were normalized or indexed.

The [previous ingress contract](https://github.com/Priyansh4444/xearch/blob/master/docs/INGRESS.md) remains an architecture reference. Raw x.md objects are deliberately not converted into it here. Quotes, media variants, article bodies, unknown fields, and missing values survive the handoff.

## Raw capture receiver

Set `RAW_CAPTURE_URL` to the exact receiving endpoint. `RAW_CAPTURE_TOKEN` authenticates ingestion; the x.md API key is never sent to it. Redirects are rejected. Use separate least-privilege credentials for capture and search. `DATA_SERVICE_TOKEN` remains a legacy fallback only when the corresponding dedicated token is unset; neither dedicated token is reused for the other capability.

```http
POST <RAW_CAPTURE_URL>
Content-Type: application/json
Authorization: Bearer <RAW_CAPTURE_TOKEN>
Idempotency-Key: <sha256 of exact UTF-8 request body>
```

```json
{
  "version": 1,
  "runId": "opaque-convex-job-id",
  "attempt": 1,
  "sequence": 0,
  "source": "x-md",
  "request": {
    "origin": "https://mdfromx.com",
    "resource": "bulk",
    "input": "theo",
    "since": "2026-01-01",
    "refresh": false
  },
  "records": [
    {
      "receivedAt": 1789776000000,
      "payload": { "post": { "id": "123", "text": "Original provider object and all its fields" } }
    }
  ],
  "terminal": "more"
}
```

`payload` is the complete decoded JSON response (including the entire `{profile, posts, meta}` history envelope), or one bulk NDJSON line when explicitly streaming. `request.format` distinguishes these; the profile preflight is labeled `resource: "profile"`. It is semantically preserved, not byte-identical to the original HTTP response. No credential headers enter the capture. `receivedAt` is when this collector observes the record; it is not a claim about the age of the upstream engagement snapshot. x.md can serve archived data; the normalizer must account for this and use provider freshness metadata when available. A metric refresh explicitly requests `refresh=true`.

For bulk collection the profile response is handed off first, then the account's numeric ID is pinned before history is requested. Bodies contain at most 25 ordinary stream records per batch and have a 4 MB hard transport limit. Oversized records fail loudly; nothing is trimmed. A normal endpoint response remains one raw record, even if it contains multiple posts — with one exception, below.

### Split history pages

A single history page can now carry up to 5000 posts, which does not fit in one 4 MB body (real captures run ~2.1-6.2 KB per post, and a measured live 5000-post request returned 3.4 MB for 1535 posts). Rather than failing such an import, the collector splits that one page across several captures and says so explicitly:

```json
{
  "receivedAt": 1789776000000,
  "payload": { "profile": {}, "posts": ["…a slice of this page…"], "meta": {} },
  "part": { "index": 0, "of": 3, "totalPosts": 2500 }
}
```

`part` is present only on a split page and never on any other record. Every part repeats the page's own envelope (`profile`, `meta`, and any unknown fields) verbatim and carries a disjoint slice of `posts` in the provider's original order, so concatenating `part.index` 0..`of-1` reproduces the page exactly; `totalPosts` is the whole page's post count. Parts are chosen by measured serialized bytes, not by a fixed post count. Parts are batched through the ordinary capture batcher, so the receiver-visible guarantees are only these: the parts of one page arrive in order, within one `runId` and `attempt`, across one or more captures whose `sequence` values are non-decreasing. Two small parts of the same page can share a capture, and the capture carrying the final part is not necessarily `terminal: "complete"` — `terminal` describes the capture, not the part, and stays `"more"` whenever collection continues. Do not infer page boundaries from `terminal` or from capture boundaries; use `part.index`/`part.of`. The receiver deduplicates as usual — a replay of the same page produces the same parts, and the same ids for identical bytes.

Return only after durable retention:

```json
{
  "captureId": "same-sha256-as-idempotency-key",
  "durable": true,
  "receiptId": "receiver-owned-opaque-id"
}
```

The receiver must return the same successful receipt for an already accepted idempotency key. A lost HTTP response is retried once with identical bytes. A new acquisition attempt can produce new captures and overlapping post IDs: raw-retention idempotency is separate from downstream normalization/deduplication.

`terminal` is `more`, `complete`, or `partial`. A complete bulk handoff requires a valid history envelope with matching account identity, or an NDJSON terminal summary and clean EOF, plus acknowledged captures. A final `partial` capture is best effort when the source fails. The receiver must not infer completion from a missing follow-up request. Convex stores receipts and progress only; it is not a raw-data spool. If the receiver stays unavailable, the run fails and acquisition must be replayed from x.md. Durable storage across producer crashes is the receiver's responsibility once it acknowledges a capture.

`source: "firecrawl"` uses the same envelope with `resource: "scrape" | "search"`. The Firecrawl component returns decoded provider `data`; that whole object is handed off. Web preview cache hits do not create new captures.

## Search service

Set `SEARCH_API_URL` to the exact retrieval endpoint and `SEARCH_SERVICE_TOKEN` to its read-only bearer credential. Retrieval and ranking live entirely on that side.

```json
{
  "version": 1,
  "query": "local first",
  "author": "theo",
  "sort": "relevance",
  "limit": 20,
  "cursor": "optional-opaque-cursor",
  "includeStats": true
}
```

Sort values: `relevance`, `engagement`, `likes`, `newest`, `oldest`. Omitted author means all indexed accounts. The provider owns the cursor and its relationship to query and sort. The Rust API returns HTTP 409 Conflict for a stale cursor; on a paginated request the app asks the user to restart the search rather than treating it as a service outage.

```json
{
  "rows": [
    {
      "tweetId": "123",
      "author": "theo",
      "text": "A display excerpt, up to 6000 characters",
      "url": "https://x.com/theo/status/123",
      "createdAt": 1789776000000,
      "likes": 12,
      "reposts": 2,
      "replies": 1,
      "links": ["https://example.com/article"],
      "displayName": "Theo",
      "avatar": "https://example.com/avatar.jpg"
    }
  ],
  "nextCursor": "optional",
  "warnings": [],
  "stats": {
    "backend": {
      "totalUs": 1200,
      "reloadUs": 40,
      "fingerprintUs": 12,
      "cursorUs": 2,
      "compileUs": 18,
      "retrieveUs": 980,
      "rankingCalls": 240,

      "materializeUs": 90,
      "candidateHits": 21,
      "returnedRows": 20,
      "indexDocs": 100000,
      "segments": 8
    },
    "api": {
      "totalUs": 1500,
      "authUs": 8,
      "validateUs": 1,
      "cursorVerifyUs": 3,
      "parseUs": 7,
      "permitUs": 1,
      "queueUs": 15,
      "engineUs": 1210,
      "postprocessUs": 20,
      "cursorSignUs": 9
    }
  }
}
```

`includeStats` is optional and defaults to false. Timings are integer microseconds. `backend.retrieveUs` includes Tantivy retrieval, collection, and ranking; `rankingCalls` reports the number of candidates presented to the ranking collector. `api.totalUs` includes authentication and the API stages up to the framework's final JSON encoding; `authUs` is reported separately. Sample values are illustrative, not a performance guarantee.

Up to 20 rows per page; dates in epoch milliseconds. Only tweetId, author, text, url, and links are required. Missing metrics stay absent. Tweet IDs remain decimal strings on the wire while Rust stores them as compact u64 values. All rendered URLs must be HTTPS. Use warnings for truncated excerpts, incomplete coverage, or approximate ranking. The app validates this display contract, saves a short-lived search session, and renders it reactively. It does not normalize raw X content into this shape or rerank results.

## x.md configuration

`X_MD_BASE_URL`: `https://mdfromx.com` (default) or `https://x.pcstyle.dev`. `X_MD_API_KEY` is sent only as a bearer header to the configured allowed origin. No automatic failover sends it to another host. `X_MD_API_KEY_FALLBACK`, when set, is a second key for the same origin: a request the first key gets refused for (401, 402, 403) or rate limited on (429) is repeated once with the fallback, and the fallback's own answer is the one reported.

Supported jobs: bulk history, live search, a post/conversation, profile, followers, following, and archive inspection. Production bulk jobs request JSON at x.md's documented per-request maximum of 5000 posts (`concurrency=8`); `nextUntil` comes from its `meta.oldest` only when truncated. The earlier 500-post request size was this app's own, not the provider's: it made a full account import spend ten requests where one now does, against an allowance x.md's live headers report as 20 imports per 15 minutes per API key. The receiver deduplicates inclusive boundaries. An explicit NDJSON collector remains available for bounded streaming, but never issues an oldest-based continuation: capped streams contain first arrivals, not necessarily the newest posts, so doing so could skip unseen newer records. Re-running the same account without `until` lets x.md top up its archive. `refresh:true` requests new snapshots. A handle reassignment pauses collection instead of combining different numeric account identities.
