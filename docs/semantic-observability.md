# Semantic projection observability

Production observability belongs to EU PostHog project **283153**. The
semantic runtime emits aggregate operational events only when explicitly
configured as production. Development and test runs must not emit events.
Use the existing production project's public ingestion key and EU host in a
new private service environment file; never copy private build credentials.

## Event contract

| Event                  | Purpose                                | Allowed operational properties                                                  |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `semantic.index_batch` | Index delivery and catch-up throughput | model/generation, stage, processed count, pending count/age, elapsed time       |
| `semantic.search`      | End-to-end query health                | model/generation, returned count, underfill, embedding/retrieval/total duration |
| `semantic.error`       | Failed stage and retry investigation   | model/generation, stage, error category; no raw exception message               |
| `semantic.heartbeat`   | Projection liveness and coverage       | model/generation, desired/delivered/pending counts, pending age                 |

The service identity is a fixed infrastructure identifier, never an email or
user handle. Exclude queries, post text, post IDs, source paths, author handles,
URLs, request bodies, bearer tokens, model download credentials and raw
exception messages. Record only allowlisted properties. Analytics failures
must not change the indexing acknowledgement or search result.

## Scout context

Semantic retrieval is a projection of the retained corpus, separate from the
existing keyword service. Keep their health and coverage distinct. A healthy
Qdrant endpoint does not prove embedding progress, and an empty semantic page
during backfill does not prove that the source archive lacks the post.

Start investigations with the active generation and the first failing stage:

1. No heartbeat: inspect the semantic worker's unit state and safe status
   endpoint. Check process restart history privately; do not export logs.
2. Pending count or oldest age grows: compare capture discovery, normalization
   and embedding/delivery throughput. Distinguish a slow initial backfill from
   a queue that stopped progressing. Check disk and model-load errors before
   changing concurrency on the shared two-CPU VM.
3. Query latency rises: separate embedding time from vector retrieval time.
   Compare available memory and vector-service optimization load with ordinary
   keyword latency. Do not use the precomputed-vector benchmark as an
   end-to-end inference baseline.
4. Underfilled responses: inspect projection coverage, revision mismatches and
   filter selectivity. A bounded ANN candidate search is not an exact result
   count. Check orphan reconciliation and current model manifest before
   attributing underfill to the embedding model.
5. Model/generation changes: compare like-for-like corpus, filters and target
   queries. Coverage and quality must both be checked; equal vector dimensions
   do not make models compatible.

For a dashboard, chart batch throughput and pending age together, error count
by stage, heartbeat recency, search p50/p95 split into embedding/retrieval,
and underfill frequency by generation. Keep initial-backfill periods visible
when interpreting these charts. This document is the checked-in scout context;
it does not claim a remote dashboard or alert has been created.

Deployment verification must record whether ingestion accepted a privacy-safe
event and, where authenticated project read access is available, whether that
event appeared in project 283153. An HTTP ingestion acknowledgement alone is
not proof of a dashboard, alert, or queryable event. Report those states
separately rather than treating a green service check as observability proof.
