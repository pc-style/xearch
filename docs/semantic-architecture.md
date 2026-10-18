# Incremental semantic search

## Decision

Add Qdrant as a private, rebuildable semantic index alongside the existing
Rust/Tantivy keyword service. Keep Convex as the application database. Keep
the receiver, outbound download worker, keyword request grammar, ranking,
signed tickets, pagination and publication acknowledgements unchanged.

The semantic projection has its own durable delivery state. An embedding
failure must not hold up capture retention, keyword indexing or publication.
It reads retained captures; it does not acquire posts or call paid providers.

This is a single-machine design with a path to separating the vector service
and embedding worker later. It is not a high-availability cluster, and a
single VM still has a single failure domain.

## Evidence and alternatives

The full local experiment used 306,952 posts and 384-dimensional BGE-small
vectors. At the requested search effort of 256, Qdrant's unfiltered tie-aware
recall was 0.9908, versus pgvector's 0.9884. Filtered recall was 1/1/1 versus
0.9972/1/1. On the production VM's separate 10,000-post experiment, pgvector
reached 1.0000 and Qdrant 0.9950, with unfiltered p50 latency of 1.22 and
1.26 ms respectively. These timings exclude embedding inference.

The small experiment deliberately included all semantic targets and had fewer
distractors: exact target hits were 32/40, compared with 20/40 in the full
corpus. Neither test establishes production relevance, ingestion throughput,
or capacity at a million posts. The four-model comparison was paused; BGE-small
is a tested baseline, not a proven best embedding model.

| Alternative                                              | Decision                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qdrant plus a local transactional delivery queue         | Selected: keeps vector storage independent of application and keyword state, with explicit disk placement and a separate embedding process.                                  |
| PostgreSQL plus pgvector                                 | Competitive measured retrieval and simpler atomic SQL/vector updates, but introduces a database server and a corpus migration that this application does not otherwise need. |
| An in-process exact FAISS index                          | Useful reference and fast at 10,000 posts; it would make persistence, updates, filtering and recovery application responsibilities.                                          |
| Embedding inside the existing keyword import transaction | Rejected: model availability and inference would delay ordinary search freshness.                                                                                            |

Two independent designs and a separate review selected the Qdrant shape.
The PostgreSQL design contributed transactional capture publication,
metadata-only update tests and explicit source-freshness limits. The review
identified a cross-process timeout race: an earlier write can remain in flight
after a worker dies. Consequently, point IDs identify immutable revisions,
rather than reusing one mutable Qdrant point for every version of a tweet.

## Ownership and data flow

```text
x.md -> existing outbound worker -> capture receiver :4319
                                      |
                              retained captures
                               /             \
                  existing Rust watcher    semantic projector
                          |                 Rust normalization export
                    Tantivy index           SQLite desired state + pending work
                          |                         |
                 keyword API :4320          CPU ONNX embeddings
                          |                         |
                 existing edge :4321        Qdrant on loopback
                                                    |
                                           private semantic API :4330
```

Only the semantic worker mutates its projection state and vector collection.
The query process reads SQLite snapshots and searches Qdrant. The worker and
query process use the same immutable model manifest. The existing keyword
writer keeps its own lock, directories and lifecycle.

The semantic API accepts natural text and explicit author/date filters. It
returns similarity scores, posts and coverage information. It does not
reinterpret keyword operators, manufacture exact totals or reuse keyword
cursors. Its bearer credential is separate from the vector administration
credential. Both internal services bind loopback. The app's explicit Semantic
mode reaches only the authenticated query endpoint through an exact route on
the existing search gateway; health, administration and Qdrant remain private.
No additional public listener is needed.

Keyword remains the default. Persist the selected mode in search sessions,
saved searches and URLs, with absent modes interpreted as keyword for existing
data. Semantic mode uses similarity order and a single bounded result page;
its partial indexing coverage must be visible, including captures not yet
normalized as well as posts awaiting embeddings. Switching modes starts a new
search rather than reusing the other mode's results or pagination state.

## Durable updates

1. Discover content-addressed capture files, including late arrivals. Keep
   the discovery ledger on disk rather than retaining all posts or vectors
   in memory. Do not use a maximum file timestamp as the discovery cursor.
2. Verify a capture's hash and stream it through the existing Rust
   normalizer. Export accepted posts, `Post::searchable()` and source
   observation metadata. Successful parsing ends with a terminal receipt.
3. Stage rows in bounded transactions. Publish them into desired state and
   pending work only after the terminal receipt and successful process exit.
   A truncated or malformed capture must not become a completed capture.
4. Compare source revisions before replacing desired state. Captured
   `receivedAt` is an observation clock, not an upstream edit version. Legacy
   inputs without that clock have a separate, deterministic lower-priority
   ordering. Hash and source position break ties; replay time and copied
   mtimes do not create new revisions.
5. Read a bounded batch of pending revisions. Embed changed searchable text;
   reuse the previous vector for metadata-only changes where available.
6. Write a deterministic revision-specific point and wait for durable vector
   service acknowledgement. Acknowledge exactly that revision in SQLite.
   Lost acknowledgements are replayable. A delayed earlier write cannot
   replace the point belonging to a newer revision.
7. Filter retrieved points against a consistent snapshot of current desired
   revisions before returning posts. Collect obsolete points by exact ID;
   reconcile late orphan writes and missing collection state. Report bounded
   candidate underfill and indexing coverage instead of hiding them.

The source does not currently supply an authoritative deletion stream. Absence
from a capture is not deletion. A future deletion feature needs ordered
tombstones retained outside the disposable vector projection; it must not be
implemented as "delete everything not in this import."

## Growth and model changes

Store vectors, HNSW and non-indexed payloads on disk. Index only fields used
for filtering. Begin with one shard, one embedding thread and one indexing
thread on this 2-vCPU VM. Batch sizes and worker concurrency bound working
memory; they are not per-user quotas or daily usage caps.

The model manifest covers artifact checksums, tokenizer/configuration,
dimensions, query prefix, normalization, text policy and truncation. A changed
model or text policy creates a new generation and collection. Backfill it
without touching the serving generation; verify coverage and quality before
changing the query service's generation. Keep the previous generation for
rollback until the new one is verified. Do not mix embedding spaces because
they happen to have the same dimensions.

Raw float32 vectors alone cost 1,536 bytes per post at 384 dimensions:
about 1.43 GiB per million posts. This excludes payloads, graph, SQLite,
WAL, snapshots, temporary optimization files and a second model generation.
The deployment-time VM observation was 8 GB RAM, two CPUs and about 24 GB
free disk. Measure actual bytes/post and peak working set before extrapolating
capacity. On-disk placement trades memory pressure for disk latency; it does
not create unlimited capacity.

Move the vector service to a larger machine when its measured storage,
optimization headroom or query latency warrants it. The worker communicates
through the vector client boundary, so that move does not require changing
Convex or the public keyword contract. Sharding, replicas and remote network
authentication require a separately verified deployment, not merely a config
flag on this VM.

## Rollout and proof

Install versioned releases outside the production checkout that the existing
VM updater fast-forwards. Use new owner-only state and credential files;
preserve existing environment files, archives and backups. Unit installation,
enablement, process liveness and a working search are separate checks.

Before declaring the projection ready, verify normalization parity, rollback
on malformed/truncated captures, duplicate and older capture replay,
metadata-only vector reuse, failure after vector write but before local
acknowledgement, late old writes, collection loss, manifest mismatch, strict
filters and credential rejection. Then exercise capture-to-result flow and
restart convergence against the real vector service on the VM.

Measure CPU inference, end-to-end query latency, embedding throughput,
pending count/age, RSS, disk use and ordinary keyword health during backfill.
Label a running backfill as incomplete until the actual desired and delivered
counts reconcile. Preserve evidence without placing post text, credentials or
production logs in Git. See [semantic observability](semantic-observability.md)
for the event and investigation contract.

## Upstream references

- [Qdrant storage](https://qdrant.tech/documentation/manage-data/storage/)
- [Pinned Qdrant configuration](https://github.com/qdrant/qdrant/blob/v1.19.2/config/config.yaml)
- [FastEmbed](https://github.com/qdrant/fastembed)
- [pgvector](https://github.com/pgvector/pgvector)

Read the installed client types and pinned server configuration when applying
settings: current upstream documentation can describe a newer server API.
