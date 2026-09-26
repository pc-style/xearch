# Search performance notes

This is the measurement record for the Rust search changes in this branch. The
numbers are local observations on the development machine, not a production
SLO.

## Baseline and measured result

The clean baseline was commit `590c4a7`.

### In-memory layout

Measured with a temporary Rust example using `std::mem::size_of`:

| Type                    |                             Baseline |              Branch |
| ----------------------- | -----------------------------------: | ------------------: |
| `Post`                  |                            240 bytes |           200 bytes |
| tweet ID representation | heap-backed `String` (24-byte field) | `TweetId` (8 bytes) |

`TweetId` still serializes as the original decimal JSON string, so JavaScript
precision and the public `tweetId` contract do not change. The unused internal
`authorId` result field was removed; ingest still validates the provider author
ID, and old stored JSON with an extra field remains deserializable.

The audit deliberately did not narrow persisted IDs or receipt counters from
`u64`: X Snowflakes exceed `u32`, and those counters are durable aggregates.
`Option<u32>` remains on the public post model because `None` versus zero is a
wire-level meaning; its 8-byte inline cost is accepted rather than silently
changing omission semantics.

### Retrieval benchmark

Command used for both runs:

```sh
cargo bench --manifest-path search/Cargo.toml \
  -p search-tantivy --bench search -- \
  --noplot --sample-size 50 --warm-up-time 1 --measurement-time 2
```

Representative medians from the same VM:

| Query                  | Baseline |   Branch |
| ---------------------- | -------: | -------: |
| `rust disk`            | 56.37 µs | 34.43 µs |
| `the`                  | 72.12 µs | 41.29 µs |
| `"to be or not to be"` | 87.70 µs | 54.40 µs |
| `from:alice`           | 72.53 µs | 45.50 µs |
| `the -rust`            | 94.53 µs | 63.05 µs |

Criterion artifacts are written under `search/target/criterion/`. CPU
frequency and background load can move absolute values significantly; use the
command above for a fresh paired run rather than treating this table as a
portable guarantee.

## Assembly and SIMD conclusion

The ranking assembly was generated with:

```sh
cargo rustc --manifest-path search/Cargo.toml -p search-ranking \
  --release --lib -- --emit=asm -C target-cpu=native
```

The custom ranking functions use scalar floating-point instructions and call
libm `log1p`/`exp` for the current relevance/recency formula. Those calls are
data-dependent per candidate, so this code is not a useful hand-SIMD target.
Tantivy's postings/columnar internals remain responsible for their own
vectorized decoding. Stats report retrieval/collection wall time and candidate
count rather than adding per-candidate clocks to the default hot path.

## What changed

- Rust keeps tweet IDs as compact `u64` values behind a wire-compatible
  `TweetId` serializer.
- Tantivy field handles are resolved once when the engine opens instead of by
  name on every indexing operation and query compilation.
- The default search path does no timing instrumentation.
- `includeStats: true` opt-in requests backend and API timings in integer
  microseconds. The response is unchanged and omits `stats` by default.
- The website exposes a **Stats for nerds** checkbox and renders backend/API
  stages without changing ordinary result payloads.
- Snowflake date derivation was deliberately not added in this branch: the
  normalizer's existing provider timestamp semantics are preserved rather than
  inventing dates for numeric IDs whose provenance is unknown.

## Rebuild and compatibility

The Tantivy schema is unchanged by the compact Rust model and field-handle
cache. Existing indexes do not require a rebuild for this change. The
`includeStats` request member defaults false, and old opaque cursors continue
to use the same JSON shape.

## Segments and reloads

Search and reload time both grow with the number of index segments, and the
production index had 4,186 segments for 186k posts (September 26, 2026)
because the `main` indexer dropped its writer after each import before
Tantivy could merge. Measured locally with `serve` on a copy of production
from a day earlier (2,297 segments), then after one import had merged it:

| Stage (median)                | 2,297 segments | 1 segment |
| ----------------------------- | -------------: | --------: |
| Reload after a commit         |          61 ms |    0.5 ms |
| Retrieve (match, rank, count) |          29 ms |    1.1 ms |
| Whole request, service side   |          30 ms |    1.8 ms |

- Writers wait for their merges when dropped (`impl Drop for Writer`). The
  merge policy looks at every segment, so the first import after deploying
  that change merged the 2,297-segment copy into one in 4.6 seconds; no
  manual `compact` is needed. The log merge policy then keeps the count at
  around ten.
- `serve` opens the index with `open_for_serving`: Tantivy polls
  `meta.json` every 500 ms and reloads on a background thread. A search
  never reloads, and never waits behind another search's reload holding the
  lock, which it did before. A commit shows up within about half a second.
- The slowest remaining queries are very common words ("this is" matches
  10k posts: about 8 ms, half of it the side-by-side phrase bonus reading
  positions). Every match is scored, because the ranking mixes in
  engagement and freshness, so Tantivy cannot skip low-scoring blocks.
