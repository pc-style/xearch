# Private semantic projection

Additive CPU semantic retrieval beside the unchanged Rust/Tantivy keyword API.
Convex, imports, capture receiver, publication receipts, existing systemd units,
nginx and the public frontend are untouched. This code is **not installed or
running in production** by being committed.

The baseline is `BAAI/bge-small-en-v1.5`, 384 dimensions, CLS pooling, L2
normalization, right truncation at 512 tokens including special tokens. It is not
a claim that this is the best relevance model. Queries receive the literal
`Represent this sentence for searching relevant passages: ` prefix. Documents
are exactly shared Rust `Post::searchable()`, without a prefix. No paid embedding
API or GPU/PyTorch dependency is used.

## Local verification

```sh
cargo fmt --manifest-path search/Cargo.toml --all -- --check
cargo clippy --manifest-path search/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path search/Cargo.toml -p search-ingest -p xearch-export --locked
uv sync --project search/semantic --frozen
PYTHONPATH=search/semantic uv run --project search/semantic --frozen python -m unittest discover -s search/semantic/tests -v
# Downloads checksummed Qdrant 1.19.2, uses temporary paths/random loopback ports,
# then removes it. Does not connect to production 6333 or start imports.
uv run --project search/semantic --frozen python search/semantic/tests/run_qdrant.py
```

`uv.lock` pins every Python dependency; Python 3.12 is required. Runtime versions
are checked at startup. Qdrant client 1.19.1 talks to Qdrant 1.19.2. The tested
release archive is Linux x86_64 GNU; other platforms need a separately reviewed
binary pin, not an unchecked download. Integration tests use fake inference;
`warmup` explicitly downloads and verifies a real model before publishing its
manifest. Serving never downloads models.

## Protocol and ordering

`xearch-export CAPTURE.json` streams one JSONL event per accepted normalized
post, then a receipt **only after valid complete EOF**. Each event has `version:1`,
`type:post`, `post`, `searchable`, nullable `observedAtMs`, and candidate `ordinal`.
Ordinals count rejected candidates too; profile records are skipped. The receipt
has `accepted`, `rejected`, `normalizer:search-ingest-v1`, and
`textPolicy:post-searchable-v1`. Nonzero exit, broken stdout, trailing garbage,
malformed timestamps or missing terminal receipt fail the export. The existing
64 MiB raw-envelope bound applies. A capture record's payload can materialize
within that bound; this is not a one-post memory guarantee.

The worker hash-checks the immutable source before and after export. It scans
only lower-case 64-hex `.json` files, excluding receipts/quarantine/symlinks.
Traversal streams pages into a disk ledger; rescans discover late files.
Completed captures are skipped by SHA. Failed captures retain a visible failure,
checkpointed staging, attempt count and stage; a later pass retries them. Neither
mtime nor replay order becomes a revision clock.

SQLite WAL with `synchronous=FULL` publishes a whole capture in one transaction
only after valid EOF, receipt count validation, successful exporter exit and
checksum verification. Staging commits remain invisible. Publication pages its
reads and merges by `(timestamp_provenance, observedAtMs, captureSHA, ordinal)`.
Missing timestamps have provenance 0 and sort below every timestamped capture;
legacy ties use SHA/ordinal deterministically. `receivedAt` is acquisition
freshness, **not a provider edit version**: clock skew, old provider snapshots,
and simultaneous conflicts remain limitations.

One OS flock owner writes each generation DB. Delivery and discovery interleave;
oldest attempted work is selected fairly. A failed page moves behind unattempted
work. Batches of 32 posts and ONNX sub-batches of 16 bound working memory, not
usage. Discovery continues during backfill. No corpus-sized ID/vector cache or
application quotas exist.

Desired point IDs are immutable UUIDs of generation/post/source revision. A
successful `wait=True` write conditionally acknowledges only that exact revision.
Ambiguous retries cannot overwrite a newer UUID. Unchanged searchable text reuses
the previous delivered vector through `with_vectors=True`; missing vectors safely
fall back to inference. New revision points have current author/date metadata.

GC records obsolete exact UUIDs durably and deletes them only after the current
replacement is delivered/acknowledged. Cyclic bounded Qdrant scroll catches
orphan late writes. There are no absence-based deletes and no deletion API:
current ingest sources do not carry authoritative ordered tombstones. Future
source tombstones require an explicit revision-aware extension.

Startup and every worker pass read the collection marker and generation. Missing
collections are recreated with a new marker and all current rows are requeued.
A foreign/misconfigured collection is refused, never destructively replaced.
Cyclic bounded point readback also finds holes after restores that preserve the
marker; SQLite acknowledgements alone do not prove restored coverage. Reconcile
progress is persisted. Pending work survives failures/crashes.

## Commands and private API

```sh
# Explicit download; freeze ONNX/tokenizer/config hashes in model/manifest.json.
uv run --project search/semantic --frozen python -m semantic.service warmup --model-dir /private/model
# All commands use SEMANTIC_MODEL_DIR, SEMANTIC_STATE, SEMANTIC_ARCHIVE,
# SEMANTIC_EXPORTER, QDRANT__SERVICE__API_KEY and (serve) SEMANTIC_READ_TOKEN.
python scripts/semantic-ctl.py init        # create/validate this generation only
python scripts/semantic-ctl.py once        # one bounded discovery/ingest/delivery/reconcile pass
python scripts/semantic-ctl.py watch       # sole writer; graceful SIGTERM after bounded work
python scripts/semantic-ctl.py serve       # independent read-only SQLite/query process
python scripts/semantic-ctl.py status      # safe counts/stages; no source identifiers
python scripts/semantic-ctl.py reconcile   # one bounded pass; requires worker stopped
python scripts/semantic-ctl.py backup --output /private/new-backup.sqlite
```

Both API and worker verify the frozen manifest/artifact hashes. The manifest also
pins policy, normalizer, prefix and inference versions. DB/collection generation
mismatch fails; a new generation needs separate state/config. `status` reports
posts, pending, acknowledged, coverage, staged rows, capture status counts and
queue lag without handles/IDs/text. SQLite backup uses its online backup API;
never copy a live `.sqlite` file without its WAL.

Only `127.0.0.1:4330` serves HTTP. `GET /health` is unauthenticated and returns
minimal readiness/model/coverage/counts. `POST /semantic/v1/search` requires a
strong bearer **read token distinct from the Qdrant admin key**. The request is:

```json
{
  "text": "durable jobs",
  "author": "alice",
  "sinceMs": 1700000000000,
  "untilMs": 1800000000000,
  "limit": 20
}
```

Only `text`, optional `author`, `sinceMs`, `untilMs`, and `limit` (1..100) are
accepted. Dates are nonnegative integer milliseconds with inclusive since and
exclusive until; missing post dates do not satisfy date filters. Unknown/duplicate
fields, bool-as-int, malformed auth, non-JSON, chunked/partial/oversized bodies
are rejected. Natural text has no keyword grammar, cursor or exact total.

Results contain `hits:[{post,score}]`, model/generation, acknowledged coverage,
pending/counts, `underfilled`, bounded candidate count and embedding/retrieval
milliseconds. At most 1000 candidates are retrieved. Hydration pins a read-only
SQLite snapshot and skips obsolete revision points, checks filters again, and
returns current full posts from SQLite. Underfill can reflect stale candidates,
ANN/filter behavior or incomplete coverage; it never means an exhaustive total.
Coverage is the durable acknowledgement ledger; same-marker restores converge
through cyclic readback. `/health` includes the last completed reconciliation
cycle time. No private query/post fields are logged.

Production observability requires explicit `SEMANTIC_ENV=production`, the EU
project **283153 public key** in `SEMANTIC_POSTHOG_KEY`, and
`SEMANTIC_POSTHOG_HOST=https://eu.i.posthog.com`. Disabled otherwise. Events are
`semantic.index_batch`, `semantic.search`, `semantic.error`, and
`semantic.heartbeat`, with only allowlisted numeric counts/timings/lag and fixed
model/generation/stage. No queries, text, IDs, handles, emails, credentials or
exception messages. The bounded asynchronous emitter times out after 2 seconds;
telemetry failure never blocks SQLite publication or serving. Verify received
production events and the parent's dashboards/scout context separately.

See [deployment and recovery](../../deploy/semantic/README.md).
