"""Compare embedding models on a shared 10k sub-corpus (exact kNN, known-item sets + judged topics).

    python models.py subset                       # write DATA/subset.json (deterministic)
    python models.py embed fastembed:MODEL        # embed the subset with one model
    python models.py score                        # table over every embedded model

The subset holds every eval target, quote source and judged topic post, padded with
random sample posts to 10,000, so all models face the same distractors. bge-small
vectors are sliced from the full-sample run rather than re-encoded. Larger local
models would take hours per 50k on this VM; that is why this comparison is smaller.
"""

import json
import os
import random
import sys
import time

import numpy as np

from common import clean, load_sample, mrr_at, ndcg_at, path, percentile, read_json, recall_at

rows = load_sample()
ids = [r["id"] for r in rows]
q = read_json("queries.json")
SETS = ("lex", "para", "quote", "topic")
queries = [x["q"] for s in SETS for x in q[s]]
cmd = sys.argv[1]

if cmd == "subset":
    judged = read_json("judgments.json")
    keep = {x["target"] for s in ("lex", "para", "quote") for x in q[s]}
    keep |= {x["source"] for x in q["quote"]}
    keep |= {i for grades in judged.values() for i, g in grades.items() if g > 0}
    rest = sorted(set(ids) - keep)
    keep |= set(random.Random(3).sample(rest, 10000 - len(keep)))
    json.dump(sorted(keep), open(path("subset.json"), "w"))
    print(len(keep), "posts in subset")
    sys.exit(0)

subset = json.load(open(path("subset.json")))
position = {i: n for n, i in enumerate(ids)}
rows_sub = [rows[position[i]] for i in subset]

if cmd == "embed":
    from fastembed import TextEmbedding

    spec = sys.argv[2]
    slug = spec.replace("/", "_").replace(":", "_")
    model = TextEmbedding(spec.split(":", 1)[1], threads=2)
    texts = [clean(r["text"]) or r["text"] for r in rows_sub]
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    out = np.empty((len(texts), 0), dtype=np.float32)
    t0 = time.perf_counter()
    chunks = []
    for c in range(0, len(order), 1000):
        part = [texts[i] for i in order[c : c + 1000]]
        longest = max(len(t) for t in part)
        chunks += list(model.passage_embed(part, batch_size=64 if longest < 300 else 16 if longest < 1200 else 4))
    secs = time.perf_counter() - t0
    docs = np.empty((len(texts), len(chunks[0])), dtype=np.float32)
    docs[order] = np.asarray(chunks, dtype=np.float32)
    lat, qv = [], []
    for text in queries:
        t1 = time.perf_counter()
        qv.append(list(model.query_embed([text]))[0])
        lat.append((time.perf_counter() - t1) * 1000)
    norm = lambda m: m / np.linalg.norm(m, axis=1, keepdims=True)
    np.save(path("emb", f"sub.{slug}.docs.npy"), norm(docs))
    np.save(path("emb", f"sub.{slug}.queries.npy"), norm(np.asarray(qv, dtype=np.float32)))
    json.dump({"spec": spec, "docs": len(texts), "dims": docs.shape[1], "threads": 2,
               "docs_per_s": round(len(texts) / secs, 1), "query_ms_p50": round(percentile(lat, 50), 1),
               "query_ms_p95": round(percentile(lat, 95), 1)}, open(path("emb", f"sub.{slug}.json"), "w"))
    print(slug, round(len(texts) / secs, 1), "docs/s")
    sys.exit(0)

# score
judged = read_json("judgments.json")
full = "fastembed_BAAI_bge-small-en-v1.5"
if not os.path.exists(path("emb", f"sub.{full}.docs.npy")):
    np.save(path("emb", f"sub.{full}.docs.npy"), np.load(path("emb", f"{full}.docs.npy"))[[position[i] for i in subset]])
    np.save(path("emb", f"sub.{full}.queries.npy"), np.load(path("emb", f"{full}.queries.npy")))
print("| model | dims | lex R@10 | para R@10 | para MRR | quote R@10 | topic nDCG@10* | docs/s (2 thr) | query ms p50 |")
print("|---|---|---|---|---|---|---|---|---|")
for file in sorted(f for f in os.listdir(path("emb")) if f.startswith("sub.") and f.endswith(".docs.npy")):
    slug = file[4:-9]
    docs = np.load(path("emb", file))
    qv = np.load(path("emb", f"sub.{slug}.queries.npy"))
    ranked = [[subset[j] for j in np.argsort(-(docs @ v))[:11]] for v in qv]
    out, n = {}, 0
    for s in SETS:
        out[s] = ranked[n : n + len(q[s])]
        n += len(q[s])
    def known(s):
        r = m = 0.0
        for item, ranks in zip(q[s], out[s]):
            ranks = [i for i in ranks if i != item.get("source")][:10]
            r += recall_at(ranks, {item["target"]: 1}, 10)
            m += mrr_at(ranks, {item["target"]: 1}, 10)
        return r / len(q[s]), m / len(q[s])
    topic = sum(ndcg_at(ranks, judged.get(str(k), {}), 10) for k, ranks in enumerate(out["topic"])) / len(q["topic"])
    meta = json.load(open(path("emb", f"sub.{slug}.json"))) if os.path.exists(path("emb", f"sub.{slug}.json")) else {}
    print(f"| {slug} | {docs.shape[1]} | {known('lex')[0]:.3f} | {known('para')[0]:.3f} | {known('para')[1]:.3f} | "
          f"{known('quote')[0]:.3f} | {topic:.3f} | {meta.get('docs_per_s', '33.5 (50k run)')} | "
          f"{meta.get('query_ms_p50', 4.9)} |")
print("* topic judgments were pooled from bge-small-based runs; unjudged posts from other models count as 0.")
