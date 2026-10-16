# Results, 2026-10-15

Run on `exp-xearch` (2 vCPU, 7.7 GiB, production VM) with the method in
[README.md](README.md). Corpus: 312,940 unique archived posts from 7,704 authors
(median 13 words). Sample: 50,000 posts, seed 7. Query sets: 200 `lex`, 200
`para`, 200 `quote`, 40 `topic`; 1,936 pooled topic results graded by
`claude-sonnet-5-5` (630 relevant). Queries were written by `gpt-5.6-luna`.

Everything below is **measured** unless marked *estimate*.

## Retrieval quality (50k sample, bge-small-en-v1.5 without query prompt)

| System | lex R@10 / MRR | para R@10 | para zero-result | quote R@10 | topic nDCG@10 |
|---|---|---|---|---|---|
| Tantivy today (AND, no stemming) | 0.995 / 0.983 | 0.010 | 96.5% | 0.000 | 0.131 |
| BM25 OR, no stemming (ES, ParadeDB) | 0.995 / 0.982 | 0.370 | 0% | 0.215 | 0.432 |
| BM25 OR, stemmed + stop words (Qdrant/bm25) | 0.995 / 0.969 | 0.420 | 0% | 0.275 | 0.574 |
| Dense only (exact kNN) | 0.665 / 0.511 | 0.565 | 0% | 0.265 | 0.486 |
| RRF hybrid, unstemmed OR + dense (ES app-side / ParadeDB SQL) | 0.990 / 0.79 (ES), 0.75 (ParadeDB) | 0.545 / 0.540 | 0% | 0.290 | 0.512 / 0.496 |
| RRF hybrid, stemmed + dense (Qdrant native) | 0.995 / 0.854 | 0.595 | 0% | 0.305 | 0.605 |
| RRF of Tantivy AND + HNSW (sidecar) | 0.995 / 0.984 | 0.510 | 0% | 0.260 | 0.503 |
| **Cascade: Tantivy AND first, then stemmed hybrid** | **0.995 / 0.983** | **0.595** | 0% | **0.305** | **0.598** |
| Author-filtered dense (`from:` + semantic), target hit@10 | — | 0.78–0.80 | — | — | — |

## Embedding models (shared 10k sub-corpus, exact kNN, model-card prompts applied)

| Model | Dims | lex R@10 | para R@10 | para MRR | quote R@10 | topic nDCG@10 | Encode posts/s (2 threads) | Prompted query ms p50 |
|---|---|---|---|---|---|---|---|---|
| bge-small-en-v1.5 | 384 | 0.815 | 0.720 | 0.575 | 0.375 | 0.652 | 33.5 | 6.3–7.4 |
| snowflake-arctic-embed-m | 768 | 0.905 | 0.790 | 0.644 | 0.385 | 0.732 | 9.5 | 26–46 |
| embeddinggemma-300m | 768 | 0.855 | 0.905 | 0.733 | 0.485 | 0.757 | 11.0 | 42.4 (one run) |

Query latency is noisy on this shared CPU: the ranges are separate runs, and the prompt
prefix itself costs time (bge-small 4.4–4.7 ms without it, 6.3 ms with it, in one process).
fastembed 0.9 applies no query/document prompts (measured: identical vectors). Without
them arctic-embed-m scored 0.265 para R@10 and EmbeddingGemma 0.785. OpenAI and Gemini
embeddings were not measured: the OpenAI key in `.env.local` and in the production
Convex deployment returns 401, and no Gemini key exists.

## Engines (50k posts, 384-d float32 HNSW m=16/ef_c=100/ef=100, one CPU each)

| Engine | Index posts/s | On disk | Memory after queries | ANN R@10 | Lexical p50/p95 ms | Vector p50/p95 | Author-filtered vector | Hybrid p50/p95 |
|---|---|---|---|---|---|---|---|---|
| Tantivy (existing, HTTP) | ~23,500 | 18 MB | 45 MiB RSS | — | 0.8 / 1.9 (AND) | — | — | — |
| In-process HNSW (hnswlib) | 4,775 | 84 MB | in process | 0.914 | — | 0.26 / 0.35 | — | — |
| Qdrant 1.19.2 (gRPC) | 1,035 | 151 MB | 165 MiB | 0.961 | 1.8 / 3.0 (sparse OR) | 2.9 / 4.1 | 1.6 / 2.6 | 3.6 / 4.5 native RRF |
| ParadeDB 0.26.1 + pgvector 0.8.6 | 1,539 | 218 MB | 378 MiB | 0.955 | 1.4 / 4.2 AND, 1.7 / 5.7 OR | 2.0 / 2.6 | 2.5 / 8.8 | 4.4 / 9.1 one SQL |
| Elasticsearch 9.5.3, Basic | 1,391 | 90 MB | 983 MiB (512m heap) | 0.936 | 3.7 / 33.5 AND, 4.0 / 46.0 OR | 5.2 / 40.5 | 4.5 / 44.9 | native RRF: **HTTP 403** on Basic |

Qdrant's rate includes encoding the `Qdrant/bm25` sparse vectors (1.5 s of 48.3 s).
Add query embedding to every vector or hybrid latency: bge-small 4.9 ms p50 / 31 ms
p95 on this CPU. Every engine returned complete author-filtered results here
(recall 0.98–0.998 against exact filtered search); pgvector filters after the HNSW
scan, which this sample did not expose.

## Estimates (arithmetic, not measured)

- Full corpus, ~25 tokens/post ≈ 7.8M tokens: OpenAI text-embedding-3-small $0.16
  ($0.08 batch), 3-large $1.02, Gemini embedding-001 $1.17, Gemini embedding-2 $1.56.
  Query embedding at 1M queries/month × 8 tokens: $0.16–$1.60/month.
- Full corpus local encoding on this VM: bge-small ≈ 2.6 h, arctic-m ≈ 9 h,
  EmbeddingGemma ≈ 8 h of two cores.
- Vectors for 313k posts: 384-d float32 481 MB (int8 120 MB); 768-d 962 MB (int8
  240 MB); 1536-d 1.92 GB. HNSW graph adds roughly 10%.

## Corrections after review

- The published run kept duplicate copies of a post in directory order. `extract.py`
  and `sample.py` now keep the most recently received copy. On the same, unchanged
  archive that gives 132 posts a different quote link, and because quote pairs seed the
  sample, seed 7 now draws a different 50k sample (37,929 posts differ). The numbers
  above come from the earlier sample and were not rerun. Every system was measured on
  that one sample, so comparisons between systems hold; rerunning the documented steps
  will shift absolute values.
