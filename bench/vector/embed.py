"""Embed the sample and every eval query with one model.

    python embed.py fastembed:BAAI/bge-small-en-v1.5 [--limit N] [--threads 1]
    python embed.py openai:text-embedding-3-small[:DIMS]
    python embed.py gemini:gemini-embedding-001[:DIMS]   (needs GEMINI_API_KEY)

Writes DATA/emb/<slug>.docs.npy, .queries.npy (L2-normalized float32) and
<slug>.json with timings. Documents use passage encoding; queries use the
model's query encoding (instruction/prefix) where it has one.
"""

import argparse
import json
import os
import resource
import time

import numpy as np

from common import clean, load_sample, path, percentile, read_json

parser = argparse.ArgumentParser()
parser.add_argument("spec")
parser.add_argument("--limit", type=int, default=0)
parser.add_argument("--threads", type=int, default=1)
parser.add_argument("--batch", type=int, default=64)
args = parser.parse_args()

provider, _, rest = args.spec.partition(":")
model, _, dims = rest.partition(":") if provider != "fastembed" else (rest, "", "")
slug = args.spec.replace("/", "_").replace(":", "_")
rows = load_sample()
if args.limit:
    rows = rows[: args.limit]
docs = [clean(r["text"]) or r["text"] for r in rows]
q = read_json("queries.json")
queries = [x["q"] for k in ("lex", "para", "quote", "topic") for x in q[k]]


def normalize(m):
    m = np.asarray(m, dtype=np.float32)
    if dims:
        m = m[:, : int(dims)]
    return m / np.linalg.norm(m, axis=1, keepdims=True).clip(1e-12)


usage = {"tokens": 0}
start = time.perf_counter()
if provider == "fastembed":
    from fastembed import TextEmbedding

    encoder = TextEmbedding(model, threads=args.threads)
    loaded = time.perf_counter() - start

    def passages(texts):
        return list(encoder.passage_embed(texts, batch_size=args.batch))

    def query_one(text):
        return list(encoder.query_embed([text]))[0]

elif provider == "openai":
    from common import openai_client

    client = openai_client()
    loaded = 0.0
    extra = {"dimensions": int(dims)} if dims else {}

    def call(texts):
        response = client.embeddings.create(model=model, input=texts, **extra)
        usage["tokens"] += response.usage.total_tokens
        return [d.embedding for d in response.data]

    def passages(texts):
        out = []
        for i in range(0, len(texts), 512):
            out += call(texts[i : i + 512])
        return out

    def query_one(text):
        return call([text])[0]

elif provider == "gemini":
    import requests

    key = os.environ["GEMINI_API_KEY"]
    base = f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
    loaded = 0.0

    def call(texts, task):
        body = {"requests": [{"model": f"models/{model}", "content": {"parts": [{"text": t}]},
                              "taskType": task, **({"outputDimensionality": int(dims)} if dims else {})}
                             for t in texts]}
        response = requests.post(f"{base}:batchEmbedContents", json=body,
                                 headers={"x-goog-api-key": key}, timeout=120)
        response.raise_for_status()
        return [e["values"] for e in response.json()["embeddings"]]

    def passages(texts):
        out = []
        for i in range(0, len(texts), 100):
            out += call(texts[i : i + 100], "RETRIEVAL_DOCUMENT")
        return out

    def query_one(text):
        return call([text], "RETRIEVAL_QUERY")[0]

else:
    raise SystemExit("unknown provider " + provider)

# Batch similar lengths together so local models don't pad short posts to long ones,
# shrink batches for long posts (ONNX Runtime's arena grows with the largest batch shape),
# and checkpoint chunks so an interrupted run resumes.
order = sorted(range(len(docs)), key=lambda i: len(docs[i]))
parts = path("emb", f"{slug}.parts{args.limit or ''}")
os.makedirs(parts, exist_ok=True)
encoded, doc_secs = [], 0.0
for c in range(0, len(order), 2000):
    part = os.path.join(parts, f"{c:07d}.npy")
    texts = [docs[i] for i in order[c : c + 2000]]
    if os.path.exists(part):
        encoded += list(np.load(part))
        doc_secs += float(open(part + ".secs").read())
        continue
    longest = max(len(t) for t in texts)
    args.batch = 64 if longest < 300 else 16 if longest < 1200 else 4
    t0 = time.perf_counter()
    chunk = np.asarray(passages(texts), dtype=np.float32)
    secs = time.perf_counter() - t0
    np.save(part, chunk)
    open(part + ".secs", "w").write(str(secs))
    encoded += list(chunk)
    doc_secs += secs
doc_m = np.empty((len(docs), len(encoded[0])), dtype=np.float32)
doc_m[order] = np.asarray(encoded, dtype=np.float32)
doc_m = normalize(doc_m)

latencies, query_m = [], []
for text in queries:
    t1 = time.perf_counter()
    query_m.append(query_one(text))
    latencies.append((time.perf_counter() - t1) * 1000)
query_m = normalize(query_m)

os.makedirs(path("emb"), exist_ok=True)
suffix = f".n{args.limit}" if args.limit else ""
np.save(path("emb", f"{slug}{suffix}.docs.npy"), doc_m)
np.save(path("emb", f"{slug}{suffix}.queries.npy"), query_m)
report = {
    "spec": args.spec, "docs": len(docs), "queries": len(queries), "dims": int(doc_m.shape[1]),
    "threads": args.threads, "model_load_s": round(loaded, 2), "doc_embed_s": round(doc_secs, 1),
    "docs_per_s": round(len(docs) / doc_secs, 1),
    "query_ms_p50": round(percentile(latencies, 50), 1), "query_ms_p95": round(percentile(latencies, 95), 1),
    "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
    "api_tokens": usage["tokens"], "ids": [r["id"] for r in rows] if args.limit else None,
}
with open(path("emb", f"{slug}{suffix}.json"), "w") as handle:
    json.dump({k: v for k, v in report.items() if k != "ids"}, handle, indent=1)
print(json.dumps({k: v for k, v in report.items() if k != "ids"}))
