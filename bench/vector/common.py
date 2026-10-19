"""Shared helpers: corpus loading, OpenAI client, tokenization, metrics."""

import json
import math
import os
import re

DATA = os.environ.get("VECBENCH_DATA", os.path.expanduser("~/vecbench-data"))
ENV_FILE = os.environ.get("VECBENCH_ENV", os.path.expanduser("~/xearch/.env.local"))
TOKEN = re.compile(r"[^\W_]+", re.UNICODE)
URL = re.compile(r"https?://\S+")


def path(*parts):
    return os.path.join(DATA, *parts)


def load_sample():
    with open(path("sample.jsonl"), encoding="utf8") as handle:
        return [json.loads(line) for line in handle]


def clean(text):
    """Text as embedded: links removed, whitespace collapsed."""
    return " ".join(URL.sub(" ", text).split())


def plain(text):
    """Query text with the search service's operator syntax neutralized, so every engine
    gets the same free text: no field:value, @author, -exclusion, quotes or wildcards."""
    text = re.sub(r"[*~^\[\]\\\":()]", " ", text)
    text = re.sub(r"\b(OR|AND|NOT)\b", lambda m: m.group(0).lower(), text)
    words = [w.lstrip("-@") for w in text.split()]
    return " ".join(w for w in words if w)


def tokens(text):
    return [t.lower() for t in TOKEN.findall(text)]


def openai_client():
    """OPENAI_API_KEY / OPENAI_BASE_URL from the environment (any OpenAI-compatible
    endpoint), else the app's OPENAI_API_KEY from ENV_FILE."""
    from openai import OpenAI

    if os.environ.get("OPENAI_API_KEY"):
        return OpenAI()
    key = None
    with open(ENV_FILE) as handle:
        for line in handle:
            if line.startswith("OPENAI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    if not key:
        raise SystemExit("OPENAI_API_KEY missing from " + ENV_FILE)
    return OpenAI(api_key=key)


def read_json(name):
    with open(path(name), encoding="utf8") as handle:
        return json.load(handle)


def write_json(name, value):
    with open(path(name), "w", encoding="utf8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)


# Metrics. `ranked` is a list of ids, `relevant` maps id -> gain (known-item: {id: 1}).
def recall_at(ranked, relevant, k):
    hit = sum(1 for i in ranked[:k] if relevant.get(i, 0) > 0)
    total = sum(1 for g in relevant.values() if g > 0)
    return hit / total if total else 0.0


def mrr_at(ranked, relevant, k):
    for rank, i in enumerate(ranked[:k], 1):
        if relevant.get(i, 0) > 0:
            return 1.0 / rank
    return 0.0


def ndcg_at(ranked, relevant, k):
    dcg = sum((2 ** relevant.get(i, 0) - 1) / math.log2(r + 1) for r, i in enumerate(ranked[:k], 1))
    ideal = sorted(relevant.values(), reverse=True)[:k]
    idcg = sum((2**g - 1) / math.log2(r + 1) for r, g in enumerate(ideal, 1))
    return dcg / idcg if idcg else 0.0


def rrf(*rankings, k=60, depth=50):
    scores = {}
    for ranking in rankings:
        for rank, i in enumerate(ranking[:depth], 1):
            scores[i] = scores.get(i, 0.0) + 1.0 / (k + rank)
    return [i for i, _ in sorted(scores.items(), key=lambda kv: -kv[1])]


def percentile(values, p):
    values = sorted(values)
    if not values:
        return float("nan")
    index = min(len(values) - 1, max(0, math.ceil(p / 100 * len(values)) - 1))
    return values[index]
