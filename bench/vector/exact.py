"""Engine-independent runs: the existing Tantivy service, exact dense kNN per model, and RRF of the two.

    python exact.py --tantivy-bin BIN --tantivy-index DIR [--models slug ...]

Writes DATA/runs/tantivy.json, dense.<slug>.json, hybrid.<slug>.json. Each run maps
query set -> list of ranked id lists, in queries.json order. Exact kNN is brute force,
so it measures the model, not an ANN index.
"""

import argparse
import json
import os
import subprocess
import time

import numpy as np

from common import load_sample, path, percentile, read_json, rrf

SETS = ("lex", "para", "quote", "topic")
parser = argparse.ArgumentParser()
parser.add_argument("--tantivy-bin", required=True)
parser.add_argument("--tantivy-index", required=True)
parser.add_argument("--models", nargs="*", default=[])
args = parser.parse_args()

ids = [r["id"] for r in load_sample()]
q = read_json("queries.json")
flat = [(s, x["q"]) for s in SETS for x in q[s]]
os.makedirs(path("runs"), exist_ok=True)


def split(rankings):
    out, i = {}, 0
    for s in SETS:
        out[s] = rankings[i : i + len(q[s])]
        i += len(q[s])
    return out


def save(name, rankings, latency=None):
    with open(path("runs", f"{name}.json"), "w") as handle:
        json.dump({"system": name, "runs": split(rankings), "latency_ms": latency}, handle)


# Tantivy: the production binary, opened once, one query per stdin line (read-only).
lines = [" ".join(text.split()) for _, text in flat]
run = subprocess.run([args.tantivy_bin, "--index", args.tantivy_index, "query", "-", "--sort", "relevance", "--stats"],
                     input="\n".join(lines) + "\n", capture_output=True, text=True, check=True)
responses = [json.loads(line) for line in run.stdout.splitlines() if line.strip()]
assert len(responses) == len(flat), (len(responses), len(flat))
tantivy = [[row["tweetId"] for row in r.get("rows", [])] for r in responses]
backend = [r["stats"]["backend"]["totalUs"] / 1000 for r in responses[1:]]  # first includes index open
save("tantivy", tantivy, {"p50": percentile(backend, 50), "p95": percentile(backend, 95),
                          "note": "backend totalUs from --stats; excludes HTTP and the first query"})

for slug in args.models:
    docs = np.load(path("emb", f"{slug}.docs.npy"))
    queries = np.load(path("emb", f"{slug}.queries.npy"))
    assert docs.shape[0] == len(ids) and queries.shape[0] == len(flat)
    times, dense = [], []
    for vector in queries:
        t0 = time.perf_counter()
        scores = docs @ vector
        top = np.argpartition(-scores, 50)[:50]
        top = top[np.argsort(-scores[top])]
        times.append((time.perf_counter() - t0) * 1000)
        dense.append([ids[i] for i in top])
    save(f"dense.{slug}", dense, {"p50": percentile(times, 50), "p95": percentile(times, 95),
                                  "note": "numpy brute force over 50k, one thread"})
    save(f"hybrid.{slug}", [rrf(t, d) for t, d in zip(tantivy, dense)], None)
print("ok", len(flat), "queries;", sum(1 for t in tantivy if not t), "Tantivy zero-result")
