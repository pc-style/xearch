"""Score every run in DATA/runs against queries.json (+ judgments.json for topic).

    python evaluate.py [--md]

Known-item sets (lex, para, quote): Recall@10 and MRR@10 of the one target, and the
share of queries with zero results. For quote, the quoting post itself is removed
from the ranking. Topic: nDCG@10 and P@10 from graded LLM judgments (0/1/2);
unjudged results count as 0.
"""

import glob
import json
import os
import sys

from common import mrr_at, ndcg_at, path, read_json, recall_at

q = read_json("queries.json")
judged = read_json("judgments.json") if os.path.exists(path("judgments.json")) else {}
rows = []
for file in sorted(glob.glob(path("runs", "*.json"))):
    run = json.load(open(file))
    out = {"system": run["system"]}
    for s in ("lex", "para", "quote"):
        rankings = run["runs"].get(s)
        if not rankings:
            continue
        r10 = m10 = zero = 0.0
        for item, ranked in zip(q[s], rankings):
            ranked = [i for i in ranked if i != item.get("source")]
            rel = {item["target"]: 1}
            r10 += recall_at(ranked, rel, 10)
            m10 += mrr_at(ranked, rel, 10)
            zero += not ranked
        n = len(q[s])
        out[f"{s}_R@10"] = round(r10 / n, 3)
        out[f"{s}_MRR"] = round(m10 / n, 3)
        out[f"{s}_zero"] = round(zero / n, 3)
    if judged and run["runs"].get("topic"):
        nd = p10 = 0.0
        for n, ranked in enumerate(run["runs"]["topic"]):
            gains = judged.get(str(n), {})
            nd += ndcg_at(ranked, gains, 10)
            p10 += sum(1 for i in ranked[:10] if gains.get(i, 0) > 0) / 10
        out["topic_nDCG@10"] = round(nd / len(q["topic"]), 3)
        out["topic_P@10"] = round(p10 / len(q["topic"]), 3)
    rows.append(out)

if "--md" in sys.argv:
    keys = [k for k in rows[0] if k != "system"] if rows else []
    keys = sorted({k for r in rows for k in r if k != "system"}, key=lambda k: (k.split("_")[0], k))
    print("| system | " + " | ".join(keys) + " |")
    print("|---|" + "---|" * len(keys))
    for r in rows:
        print(f"| {r['system']} | " + " | ".join(str(r.get(k, "")) for k in keys) + " |")
else:
    for r in rows:
        print(json.dumps(r))
