"""AND-first cascade from saved runs: the existing Tantivy results stay on top, then a
semantic or hybrid list fills the remaining slots. No engine is queried.

    python cascade.py
"""

import json

from common import path


def load(name):
    return json.load(open(path("runs", name + ".json")))["runs"]


tantivy = load("tantivy")
for name, tag in (("qdrant.hybrid", "qdrant"), ("paradedb.hybrid", "paradedb"),
                  ("dense.fastembed_BAAI_bge-small-en-v1.5", "dense")):
    other = load(name)
    runs = {s: [(a + [i for i in b if i not in set(a)])[:50] for a, b in zip(tantivy[s], other[s])] for s in tantivy}
    with open(path("runs", f"cascade.{tag}.json"), "w") as handle:
        json.dump({"system": f"cascade.tantivy_then_{tag}", "runs": runs}, handle)
print("ok")
