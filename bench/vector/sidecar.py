"""In-process HNSW next to Tantivy: the "keep the Rust service, add a vector index" option.

    python sidecar.py [SLUG]

hnswlib (C++, the same HNSW algorithm Rust crates such as usearch/hnsw_rs implement)
with m=16, ef_construction=100, ef=100, one thread. Measures build time, saved index
size, query latency and ANN recall@10 against exact search, and also int8 storage via
scalar quantization arithmetic. Writes DATA/engines/sidecar.json and runs/sidecar.vec.json.
"""

import json
import os
import sys
import time

import hnswlib
import numpy as np

from common import load_sample, path, percentile, read_json, rrf

SLUG = sys.argv[1] if len(sys.argv) > 1 else "fastembed_BAAI_bge-small-en-v1.5"
SETS = ("lex", "para", "quote", "topic")
ids = [r["id"] for r in load_sample()]
docs = np.load(path("emb", f"{SLUG}.docs.npy"))
queries = np.load(path("emb", f"{SLUG}.queries.npy"))
q = read_json("queries.json")

index = hnswlib.Index(space="cosine", dim=docs.shape[1])
index.init_index(max_elements=len(docs), M=16, ef_construction=100)
index.set_num_threads(1)
t0 = time.perf_counter()
index.add_items(docs, np.arange(len(docs)))
build = time.perf_counter() - t0
index.set_ef(100)
file = path("engines", "sidecar.hnsw")
index.save_index(file)

lat, ranked = [], []
for v in queries:
    t1 = time.perf_counter()
    labels, _ = index.knn_query(v, k=50)
    lat.append((time.perf_counter() - t1) * 1000)
    ranked.append([ids[i] for i in labels[0]])
exact = np.argsort(-(queries @ docs.T), axis=1)[:, :10]
recall = np.mean([len(set(ranked[n][:10]) & {ids[j] for j in exact[n]}) / 10 for n in range(len(queries))])

split, i = {}, 0
for s in SETS:
    split[s] = ranked[i : i + len(q[s])]
    i += len(q[s])
json.dump({"system": "sidecar.vec", "runs": split}, open(path("runs", "sidecar.vec.json"), "w"))
tantivy = json.load(open(path("runs", "tantivy.json")))["runs"]
json.dump({"system": "sidecar.hybrid_tantivy_and", "runs": {s: [rrf(a, b) for a, b in zip(tantivy[s], split[s])]
                                                            for s in SETS}},
          open(path("runs", "sidecar.hybrid_tantivy_and.json"), "w"))
report = {"engine": "sidecar-hnswlib", "slug": SLUG, "docs": len(docs), "dims": docs.shape[1],
          "build_s": round(build, 1), "docs_per_s": round(len(docs) / build),
          "index_file_bytes": os.path.getsize(file),
          "float32_vectors_bytes": docs.nbytes, "int8_vectors_bytes": docs.size,
          "latency_ms": {"vec": {"p50": round(percentile(lat, 50), 3), "p95": round(percentile(lat, 95), 3)}},
          "ann_recall@10_vs_exact": round(float(recall), 4)}
json.dump(report, open(path("engines", "sidecar.json"), "w"), indent=1)
print(json.dumps(report))
