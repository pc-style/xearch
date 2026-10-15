"""Print the measured engine and embedding numbers as markdown tables.

    python report.py
"""

import glob
import json
import os

from common import path


def load(pattern):
    return [json.load(open(f)) for f in sorted(glob.glob(path(*pattern)))]


print("| model | dims | docs/s | threads | query ms p50/p95 | peak RSS MB |")
print("|---|---|---|---|---|---|")
for e in load(("emb", "*.json")):
    if e.get("docs", 0) < 10000:
        continue
    print(f"| {e['spec']} | {e['dims']} | {e['docs_per_s']} | {e['threads']} | "
          f"{e['query_ms_p50']}/{e['query_ms_p95']} | {e['peak_rss_mb']} |")

print()
print("| engine | index docs/s | size MB | memory | ANN R@10 | lex AND p50/p95 | lex OR p50/p95 | vec p50/p95 | "
      "vec+author p50/p95 | hybrid p50/p95 |")
print("|---|---|---|---|---|---|---|---|---|---|")
for e in load(("engines", "*.json")):
    lat = e.get("latency_ms", {})
    cell = lambda k: f"{lat[k]['p50']:.1f}/{lat[k]['p95']:.1f}" if k in lat else "—"
    size = e.get("size_bytes", {})
    mb = max((v for v in size.values() if isinstance(v, int)), default=0) / 1e6
    if "index_file_bytes" in e:
        mb = e["index_file_bytes"] / 1e6
    memory = e.get("container_mem_after_queries") or (f"{e['rss_kb'] // 1024}MiB RSS" if "rss_kb" in e else "in-process")
    rate = (e.get("index") or {}).get("docs_per_s") or e.get("docs_per_s", "—")
    print(f"| {e['engine']} | {rate} | {mb:.0f} | {memory} | {e.get('ann_recall@10_vs_exact', '—')} | "
          f"{cell('lex_and')} | {cell('lex_or')} | {cell('vec')} | {cell('vec_author')} | {cell('hybrid')} |")
