# Provisioning, promotion and recovery (not executed)

These templates add three user services. They do not modify or restart the
production import worker, capture receiver, keyword API/indexer, frontend or
nginx. No sudo or public proxy configuration is needed. Default stable code is
`/home/exedev/xearch-semantic/current`, outside the auto-updated
`~/xearch-worker` checkout. Data is `~/xearch-data/semantic`. `%h` is the user home.
For other locations, review matching unit drop-ins and private env paths together.

## Reviewed initial provisioning

Prerequisites: Linux x86_64 GNU, Python 3.12, uv 0.11.7, Rust toolchain compatible
with the committed workspace lock, enough disk/RAM, and the parent-approved raw
archive path. Verify 4330, 6333 and 6334 are unused. Review code before invoking
setup. Setup downloads/builds a new release, freezes model artifacts, generates
**new** private credentials/config if absent, and preserves existing env/data.
It refuses existing release paths or conflicting Qdrant config; it never starts
services, installs units, swaps `current`, or recreates an existing collection.
A failed partial new release needs private inspection and a new release path;
there is no recursive cleanup of persistent data.

```sh
python deploy/semantic/setup.py \
  --release "$HOME/xearch-semantic/releases/semantic-v1" \
  --data "$HOME/xearch-data/semantic" \
  --archive /absolute/parent-approved/archive
```

Qdrant GNU release:
`https://github.com/qdrant/qdrant/releases/download/v1.19.2/qdrant-x86_64-unknown-linux-gnu.tar.gz`
SHA-256 `34a788a09a4cb278b5c6d2af96d9a6db30c8c7e88ae3550455f7a4d425bb8d4b`,
read from the official GitHub release asset digest and verified before extraction.
`release.json` records the binary hash and generation. Qdrant client/startup
readback rejects a server other than 1.19.2. Python uses `uv sync --frozen` with
the committed full dependency lock. Model setup is explicit; runtime is offline.

`qdrant.env` holds the admin key and storage/snapshot paths. `semantic.env` holds
paths, the Qdrant key and a distinct read token. Both are 0600; directories are
0700 and services use `UMask=0077`. Existing files are never truncated. Setup
defaults telemetry to development: configure the project 283153 EU public key
privately and explicitly opt into production before starting approved VM work.
Do not print env files or authorization headers in review artifacts.

For initial deployment only, after review:

```sh
ln -s releases/semantic-v1 "$HOME/xearch-semantic/current"
install -d -m 700 "$HOME/.config/systemd/user"
install -m 600 deploy/systemd/xearch-qdrant.service deploy/systemd/xearch-semantic.service deploy/systemd/xearch-semantic-worker.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now xearch-qdrant.service
python scripts/semantic-ctl.py init
systemctl --user enable --now xearch-semantic-worker.service
# Start API after initial readiness/coverage is understood; no public exposure.
systemctl --user enable --now xearch-semantic.service
```

Qdrant binds HTTP 6333/gRPC 6334 to loopback, requires its admin credential and
uses on-disk vectors/payload/HNSW, one shard/indexing/optimization thread. The API
binds only 4330. API and worker each use one CPU ONNX thread, separate processes.
Initial memory settings: Qdrant high/max 1536M/2G; API 512M/768M; worker 768M/1G.
Nice 10/15 deprioritizes semantic work. These are memory isolation hypotheses,
not measured VM capacity or usage quotas. OOM kills preserve pending SQLite work
and keyword service; inspect rather than blindly raising limits.

Verification must distinguish **prepared**, **installed**, **enabled**,
**running**, and **health-checked**. A successful setup/green unit is insufficient:

```sh
systemctl --user is-enabled xearch-qdrant xearch-semantic-worker xearch-semantic
systemctl --user is-active xearch-qdrant xearch-semantic-worker xearch-semantic
ss -ltnp 'sport = :4330 or sport = :6333 or sport = :6334'
curl --fail --silent http://127.0.0.1:4330/health
python scripts/semantic-ctl.py status
```

Privately prove missing/wrong semantic auth gives 401, admin key is not accepted
as the API read token, good auth with filters returns normalized current posts,
and no bound interface is public. Use a private Python HTTP client loading the
env rather than putting tokens in shell arguments. Measure cold/warm embedding
p50/p95, posts/sec, queue lag, full-corpus RSS/disk/compaction peak and concurrent
keyword p95. On the stated 2 CPU/8GB VM require at least 1GiB available RAM, 5GiB
free disk and at most 10% keyword p95 regression; project bytes/post through
corpus growth and dual-generation operation. These are parent acceptance checks,
not implemented app quotas. Verify live EU PostHog events/dashboard context.

## Generations and rollback

A frozen manifest produces a generation-specific DB and Qdrant collection.
Changing any model/tokenizer/config hash, prefix, dimension, policy, normalizer
or inference version needs a new generation. Never edit a running manifest or
reuse its DB. To rebuild, prepare another model directory/env and state path;
run a second worker via `semantic-ctl.py --env /private/candidate.env --release
/absolute/release watch`. It owns a different flock/DB/collection and independently
replays the same archive. Keep old generation catching up for rollback. There is
no distributed multi-model control plane.

For promotion, first finish a complete candidate scan and verify its capture
ledger, zero pending, no malformed-capture failures, and completed point readback.
Then stop the candidate writer gracefully, run bounded `reconcile` passes until
a complete cycle finishes and zero missing/pending remains. Discovery/receipt
and reconciliation timestamps in safe status/health give recorded barriers.
Compare candidate counts/normalization and relevance/filter results to source
and expected semantic coverage. Run a private candidate API on an isolated test
machine or stop the old API to test candidate on 4330; no listener override here.
Acknowledge any captures arriving after the barrier; resume candidate catch-up
before switching. Only then review and atomically promote the API's private env
config to the candidate state/model, restart **semantic API only**, and verify
model/generation/coverage readback and authenticated search. Keep prior env/release
for rollback. Parent performs this configuration promotion; no command here
automatically considers pending=0 alone sufficient.

For a code release swap, prepare/verify a separate release, stop semantic worker
and API, create `current.incoming` symlink to the reviewed release and rename it
over `current`. Restart semantic worker/API only. Do not restart Qdrant during
an application-only release. A Qdrant binary upgrade requires its own version,
checksum, snapshots, client/config compatibility and isolated restore rehearsal.
Rollback swaps the old code symlink and API env config, then restarts only these
semantic processes. Stopping/disabling the semantic API/worker leaves all existing
search/import services available. Do not delete old projection/capture data.

## Backup and restore proof

Capture archive remains the reconstruction source; Qdrant vectors are disposable.
Use SQLite's online backup API while the worker is live:

```sh
python scripts/semantic-ctl.py backup --output "$HOME/xearch-data/semantic/backups/new-generation.sqlite"
```

This copies a consistent DB including metadata, desired work, capture ledger and
GC. Do not copy only a live database file or checkpoint/copy unsafely. Keep backup
private and retain model manifest/artifacts and private env separately. For faster
recovery, use Qdrant's authenticated collection snapshot API with a private client;
do not expose snapshots or print credentials. SQLite and Qdrant need not be from
the same instant because immutable revision validation/reconciliation repairs
cross-store differences.

Rehearse restoring the SQLite backup to a **new** state path and using a new
isolated Qdrant instance. A production endpoint must not be used for a rehearsal.
Verify backup counts/generation and artifact hashes, recreate the empty collection,
run the worker until current rows are re-delivered, and compare authenticated
results/filter behavior. Also rehearse same-marker older Qdrant snapshot holes:
cyclic readback must requeue them despite prior acknowledgements. Tests cover
lost acknowledgements, restore holes and late orphan writes; real VM restore and
full corpus resource proofs remain parent work. Never promote before readback.
