"""Draw the deterministic benchmark sample and a raw dump the Tantivy CLI imports.

    python3 -I sample.py ARCHIVE_DIR DATA_DIR [SIZE] [SEED]

Reads DATA_DIR/corpus.jsonl. Writes DATA_DIR/sample.jsonl (normalized rows)
and DATA_DIR/sample-dump.json ({"posts": [raw x.md posts]}). Quote pairs whose
both sides exist in the corpus are kept together so they can serve as
relatedness judgments. Never writes to ARCHIVE_DIR.
"""

import json
import os
import random
import sys

archive, data = sys.argv[1], sys.argv[2]
size = int(sys.argv[3]) if len(sys.argv) > 3 else 50_000
seed = int(sys.argv[4]) if len(sys.argv) > 4 else 7

rows = {}
with open(os.path.join(data, "corpus.jsonl"), encoding="utf8") as handle:
    for line in handle:
        row = json.loads(line)
        rows[row["id"]] = row

rng = random.Random(seed)
pairs = sorted(
    (r["id"], r["quoteId"]) for r in rows.values() if r["quoteId"] and r["quoteId"] in rows
)
rng.shuffle(pairs)
chosen = set()
for quoting, quoted in pairs[: size // 20]:
    chosen.update((quoting, quoted))
rest = sorted(set(rows) - chosen)
chosen.update(rng.sample(rest, size - len(chosen)))

raw = {}
for entry in os.scandir(archive):
    name = entry.name
    if not name.endswith(".json") or name.endswith(".receipt.json"):
        continue
    try:
        with open(entry.path, encoding="utf8") as handle:
            capture = json.load(handle)
    except (OSError, ValueError):
        continue
    for record in capture.get("records") or []:
        payload = record.get("payload") or {}
        for post in (payload.get("posts") or []) + [payload.get("post")]:
            if isinstance(post, dict) and str(post.get("id")) in chosen:
                raw[str(post["id"])] = post

ids = sorted(chosen)
with open(os.path.join(data, "sample.jsonl"), "w", encoding="utf8") as handle:
    for i in ids:
        handle.write(json.dumps(rows[i], ensure_ascii=False) + "\n")
with open(os.path.join(data, "sample-dump.json"), "w", encoding="utf8") as handle:
    json.dump({"posts": [raw[i] for i in ids if i in raw]}, handle, ensure_ascii=False)
print(json.dumps({"sample": len(ids), "raw": len(raw), "quote_pairs_in_corpus": len(pairs),
                  "quote_pairs_kept": min(len(pairs), size // 20)}))
