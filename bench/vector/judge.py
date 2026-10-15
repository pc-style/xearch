"""Grade the pooled top-10 of every run for each topic query with an LLM judge.

    python judge.py [MODEL]

Pools the top 10 ids from every DATA/runs/*.json for each topic query, asks the
judge for 0 (not relevant) / 1 (partly) / 2 (relevant) per post, and writes
DATA/judgments.json {query index: {id: grade}}. Existing grades are reused, so
adding a run only judges the new posts. The judge never sees which system
returned a post, and posts are shuffled.
"""

import glob
import json
import os
import random
import sys

from common import clean, load_sample, openai_client, path, read_json, write_json

MODEL = sys.argv[1] if len(sys.argv) > 1 else "claude-sonnet-5-5"
rows = {r["id"]: r for r in load_sample()}
topics = read_json("queries.json")["topic"]
judged = read_json("judgments.json") if os.path.exists(path("judgments.json")) else {}
pools = {str(n): set() for n in range(len(topics))}
for file in glob.glob(path("runs", "*.json")):
    run = json.load(open(file))["runs"].get("topic") or []
    for n, ranked in enumerate(run):
        pools[str(n)].update(ranked[:10])

client = openai_client()
INSTRUCTIONS = (
    "You judge search results for a site that searches X (Twitter) posts. Given a search query and numbered "
    "posts, grade each post: 2 = clearly about what the searcher wants, 1 = related or partially useful, "
    "0 = not relevant. Judge topical relevance only, not quality or popularity. "
    'Return JSON {"grades": {"<number>": 0|1|2, ...}} covering every number.'
)
rng = random.Random(5)
asked = 0
for n, topic in enumerate(topics):
    key = str(n)
    done = judged.setdefault(key, {})
    todo = sorted(i for i in pools[key] if i not in done)
    rng.shuffle(todo)
    for start in range(0, len(todo), 40):
        batch = todo[start : start + 40]
        listing = "\n\n".join(f"{k + 1}. {clean(rows[i]['text'])[:500]}" for k, i in enumerate(batch))
        response = client.chat.completions.create(
            model=MODEL, response_format={"type": "json_object"},
            messages=[{"role": "system", "content": INSTRUCTIONS},
                      {"role": "user", "content": f"Query: {topic['q']}\n\nPosts:\n{listing}"}])
        text = response.choices[0].message.content.strip()
        text = text[text.find("{") : text.rfind("}") + 1]
        grades = json.loads(text)["grades"]
        for k, i in enumerate(batch):
            done[i] = int(grades.get(str(k + 1), 0))
        asked += len(batch)
    write_json("judgments.json", judged)
print("judged", asked, "new posts with", MODEL)
