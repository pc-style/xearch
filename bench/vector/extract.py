"""Extract unique posts from the read-only capture archive into a JSONL corpus.

    python3 -I extract.py ARCHIVE_DIR OUT_DIR

Writes OUT_DIR/corpus.jsonl (one normalized post per line, newest copy of each
id wins) and OUT_DIR/corpus.stats.json. Never writes to ARCHIVE_DIR.
"""

import json
import os
import re
import sys

archive, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

posts = {}
files = 0


def keep(post):
    if not isinstance(post, dict) or not post.get("id") or not post.get("text"):
        return
    author = (post.get("author") or {}).get("screen_name") or ""
    quote = post.get("quote") or {}
    row = {
        "id": str(post["id"]),
        "author": author.lower(),
        "text": post["text"],
        "createdAt": int(post.get("created_timestamp") or 0) * 1000,
        "likes": int(post.get("likes") or 0),
        "reposts": int(post.get("reposts") or post.get("retweets") or 0),
        "replies": int(post.get("replies") or 0),
        "lang": post.get("lang") or "",
        "replyTo": post.get("replying_to") or None,
        "quoteId": str(quote["id"]) if quote.get("id") else None,
    }
    posts[row["id"]] = row


for entry in os.scandir(archive):
    name = entry.name
    if not name.endswith(".json") or name.endswith(".receipt.json"):
        continue
    try:
        with open(entry.path, encoding="utf8") as handle:
            capture = json.load(handle)
    except (OSError, ValueError):
        continue
    files += 1
    for record in capture.get("records") or []:
        payload = record.get("payload") or {}
        for post in payload.get("posts") or []:
            keep(post)
        keep(payload.get("post"))

tokens = re.compile(r"\w+", re.UNICODE)
lengths = sorted(len(tokens.findall(p["text"])) for p in posts.values())
with open(os.path.join(out, "corpus.jsonl"), "w", encoding="utf8") as handle:
    for row in sorted(posts.values(), key=lambda r: r["id"]):
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")

langs = {}
for p in posts.values():
    langs[p["lang"]] = langs.get(p["lang"], 0) + 1
stats = {
    "captures": files,
    "posts": len(posts),
    "authors": len({p["author"] for p in posts.values()}),
    "words_p50": lengths[len(lengths) // 2] if lengths else 0,
    "words_p95": lengths[int(len(lengths) * 0.95)] if lengths else 0,
    "words_mean": round(sum(lengths) / max(1, len(lengths)), 1),
    "top_langs": sorted(langs.items(), key=lambda kv: -kv[1])[:8],
}
with open(os.path.join(out, "corpus.stats.json"), "w") as handle:
    json.dump(stats, handle, indent=2)
print(json.dumps(stats))
