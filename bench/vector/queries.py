"""Build the evaluation query sets from the sample (deterministic, seed 11).

    python queries.py [MODEL]

Writes DATA/queries.json:
  lex    known-item: the target post's three rarest words (no LLM)
  para   known-item: an LLM-written search that avoids the post's distinctive words
  quote  relatedness: a quoting post's own words -> the post it quotes (no LLM)
  topic  open topical searches, graded later by judge.py
"""

import json
import random
import re
import sys

from common import clean, load_sample, openai_client, plain, tokens, write_json

MODEL = next((a for a in sys.argv[1:] if not a.startswith("--")), "gpt-5.6-luna")
rng = random.Random(11)
rows = load_sample()
by_id = {r["id"]: r for r in rows}

df = {}
for r in rows:
    for t in set(tokens(r["text"])):
        df[t] = df.get(t, 0) + 1


def english(r):
    text = clean(re.sub(r"^(@\w+\s*)+", "", r["text"]))
    letters = [c for c in text if c.isalpha()]
    return (
        r["lang"] in ("en", "")
        and len(tokens(text)) >= 10
        and letters
        and sum(c.isascii() for c in letters) / len(letters) > 0.95
    )


eligible = sorted((r for r in rows if english(r)), key=lambda r: r["id"])
picked = rng.sample(eligible, 440)
known, topical = picked[:200], picked[200:240]

def body_words(text):
    """Words the search service indexes as ordinary terms: no @handles (reply mentions are
    not indexed, other handles are single tokens) and no links."""
    return set(tokens(re.sub(r"(?<![\w])@\w+", " ", clean(text))))


lex = []
for r in known:
    words = [t for t in body_words(r["text"]) if len(t) >= 3 and not t.isdigit()]
    words.sort(key=lambda t: (df.get(t, 0), t))
    lex.append({"q": " ".join(words[:3]), "target": r["id"]})

quote = []
pairs = sorted((r for r in rows if r["quoteId"] in by_id), key=lambda r: r["id"])
for r in rng.sample(pairs, min(len(pairs), 600)):
    q = clean(re.sub(r"(^|\s)@\w+", " ", r["text"]))
    if len(tokens(q)) >= 4 and english(by_id[r["quoteId"]]):
        quote.append({"q": q[:300], "target": r["quoteId"], "source": r["id"]})
    if len(quote) == 200:
        break

if "--lex-only" in sys.argv:  # rebuild the deterministic set, keep the LLM-written ones
    from common import read_json

    existing = read_json("queries.json")
    existing["lex"] = [{**x, "q": plain(x["q"])} for x in lex]
    write_json("queries.json", existing)
    print(f"rebuilt {len(lex)} lex queries")
    sys.exit(0)

client = openai_client()
PARA = (
    "For each numbered X post, write the search a person would type months later to find it again, "
    "from memory of what it was about. 3 to 8 words, lowercase, no quotes, no author names, no hashtags. "
    "Describe the topic in your own words: do not reuse the post's distinctive or rare words. "
    'Return JSON {"queries": [string, ...]} with exactly one query per post, in order.'
)
TOPIC = (
    "Each numbered X post suggests a subject people search for on a site that indexes tech and startup "
    "accounts. For each, write one realistic, general search query (2 to 7 words) about that subject that "
    "many different posts could answer, not a description of this specific post. Lowercase, no author names. "
    'Return JSON {"queries": [string, ...]} with exactly one query per post, in order.'
)


def ask(instructions, batch):
    listing = "\n\n".join(f"{n + 1}. {clean(r['text'])[:600]}" for n, r in enumerate(batch))
    response = client.chat.completions.create(
        model=MODEL,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": instructions}, {"role": "user", "content": listing}],
    )
    out = json.loads(response.choices[0].message.content)["queries"]
    if len(out) != len(batch):
        raise SystemExit(f"model returned {len(out)} queries for {len(batch)} posts")
    return [q.strip().lower() for q in out], response.usage


usage = {"prompt": 0, "completion": 0}
para = []
for i in range(0, len(known), 20):
    out, use = ask(PARA, known[i : i + 20])
    usage["prompt"] += use.prompt_tokens
    usage["completion"] += use.completion_tokens
    for r, q in zip(known[i : i + 20], out):
        overlap = set(tokens(q)) & set(tokens(r["text"]))
        para.append({"q": q, "target": r["id"], "overlap": sorted(overlap)})

topic = []
for i in range(0, len(topical), 20):
    out, use = ask(TOPIC, topical[i : i + 20])
    usage["prompt"] += use.prompt_tokens
    usage["completion"] += use.completion_tokens
    topic += [{"q": q, "seed": r["id"]} for r, q in zip(topical[i : i + 20], out)]

for item in lex + para + quote + topic:
    item["q"] = plain(item["q"])
write_json("queries.json", {"model": MODEL, "seed": 11, "usage": usage,
                            "lex": lex, "para": para, "quote": quote, "topic": topic})
print(json.dumps({k: len(v) for k, v in {"lex": lex, "para": para, "quote": quote, "topic": topic}.items()}),
      usage)
