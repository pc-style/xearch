# Vector and hybrid search benchmark

A reproducible comparison of semantic and hybrid retrieval options for the
search service: the existing Tantivy service, Tantivy plus an in-process HNSW
index, Qdrant, ParadeDB, and Elasticsearch, with local and API embedding
models. Nothing here touches the production index, archive, services, or
Convex; every script reads the archive and writes under `$VECBENCH_DATA`
(default `~/vecbench-data`).

## Run

```sh
python3 -m venv ~/vecbench-venv   # or: uv venv ~/vecbench-venv
~/vecbench-venv/bin/pip install openai numpy fastembed requests "psycopg[binary]" hnswlib qdrant-client
cd bench/vector
PY=~/vecbench-venv/bin/python
BIN=~/xearch-worker/search/target/release/xearch-search   # production build of search/

# 1. Corpus and a deterministic 50k sample (seed 7, 2,500 quote pairs kept together)
python3 -I extract.py ~/xearch-data/search/archive ~/vecbench-data
python3 -I sample.py  ~/xearch-data/search/archive ~/vecbench-data 50000 7
# Tantivy index of the same sample (the importer takes ≤64 MiB per file)
mkdir -p ~/vecbench-data/dumps ~/vecbench-data/tantivy/archive
python3 -I -c "import json; d=json.load(open('$HOME/vecbench-data/sample-dump.json'))['posts']
[json.dump({'posts': d[i:i+10000]}, open(f'$HOME/vecbench-data/dumps/part{i//10000:02d}.json','w')) for i in range(0,len(d),10000)]"
for f in ~/vecbench-data/dumps/part*.json; do $BIN --index ~/vecbench-data/tantivy/index import --input $f --archive ~/vecbench-data/tantivy/archive; done

# 2. Query sets (LLM via any OpenAI-compatible endpoint in OPENAI_BASE_URL/OPENAI_API_KEY)
$PY queries.py gpt-5.6-luna

# 3. Embeddings (length-sorted, checkpointed batches)
$PY embed.py fastembed:BAAI/bge-small-en-v1.5 --threads 2
$PY embed.py openai:text-embedding-3-small          # needs a valid OPENAI_API_KEY
$PY embed.py gemini:gemini-embedding-001:768        # needs GEMINI_API_KEY

# 4. Engine-independent runs: Tantivy, exact dense kNN, RRF hybrid
$PY exact.py --tantivy-bin $BIN --tantivy-index ~/vecbench-data/tantivy/index --models fastembed_BAAI_bge-small-en-v1.5

# 5. Engines, one at a time (each container gets --cpus=1), then the in-process sidecar
for e in tantivy es qdrant paradedb; do $PY engines.py $e; done
$PY sidecar.py

# 6. AND-first cascades from saved runs, judge pooled topical results, score everything
$PY cascade.py
$PY judge.py claude-sonnet-5-5
$PY evaluate.py --md
$PY report.py

# 7. Model comparison on a shared 10k sub-corpus (larger local models are slow here)
$PY models.py subset
$PY models.py embed fastembed:snowflake/snowflake-arctic-embed-m
$PY models.py embed fastembed:google/embeddinggemma-300m
$PY models.py score
```

## What is measured

| Query set | Size | Built from | Measures |
|---|---|---|---|
| `lex` | 200 | the target post's three rarest words (no LLM) | exact-term recall; guards against regressions |
| `para` | 200 | LLM search written from memory, told not to reuse distinctive words | vocabulary-gap recall, the case semantic search is for |
| `quote` | 200 | a quoting post's own words → the post it quotes | natural relatedness, no LLM |
| `topic` | 40 | LLM general queries seeded by sample posts | nDCG@10 / P@10 from pooled, blind, graded LLM judgments |

Known-item sets report Recall@10, MRR@10 and the zero-result rate. Engines report
indexing throughput, on-disk size, container memory after the run, ANN recall@10
against brute force on identical vectors, and client round-trip latency
(p50/p95/p99) for lexical, vector, author-filtered vector and hybrid search. Query
embedding latency is reported separately by `embed.py` and must be added to any
vector or hybrid latency.

## Limits to keep in mind

- One 2-vCPU shared VM; engines are capped at one CPU; production search shared the
  other core. Latencies are comparative, not capacity claims.
- 50k of the 312,940 archived posts. Memory and size scale roughly linearly; ANN
  latency grows sub-linearly; the full corpus was not loaded into any engine.
- LLM-written queries and LLM judgments are proxies for human relevance labels.
- Engines use their own BM25 implementations and tokenizers; scores are not
  comparable across engines, only rankings. Qdrant's `Qdrant/bm25` sparse encoder
  stems and drops English stop words; Tantivy, ES `standard` and ParadeDB's default
  tokenizer do not. Part of any Qdrant quality lead is that analyzer, not the engine.
- Qdrant is timed over gRPC. Over REST, responses above ~10 hits stall ~45 ms on a
  delayed ACK although the server reports ~1.3 ms.
- Query text is passed through `common.plain` for every engine: the search service
  rejects unbalanced parentheses, wildcards and unknown `field:` operators.
