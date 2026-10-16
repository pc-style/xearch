"""Index the sample into one engine, then time lexical, vector, filtered-vector and hybrid search.

    python engines.py es|qdrant|paradedb|tantivy [--keep]

Every engine gets the same rows and the same bge-small vectors, float32 HNSW with
m=16 / ef_construction=100 and search ef (num_candidates) 100, one CPU (docker --cpus=1).
Latency is client round trip over loopback HTTP/SQL from this process, sequential,
after 30 warm-up queries. Writes DATA/engines/<engine>.json and DATA/runs/<engine>.*.json.
The container and its data are removed afterwards unless --keep.
"""

import argparse
import json
import os
import subprocess
import time

import numpy as np
import requests

from common import load_sample, path, percentile, read_json, rrf

SLUG = "fastembed_BAAI_bge-small-en-v1.5"
SETS = ("lex", "para", "quote", "topic")
CPUS = "1"
TOKEN = "vecbench-local-throwaway-bearer-token-0123456789"
parser = argparse.ArgumentParser()
parser.add_argument("engine")
parser.add_argument("--keep", action="store_true")
parser.add_argument("--tantivy-bin", default="/home/exedev/xearch-worker/search/target/release/xearch-search")
args = parser.parse_args()

rows = load_sample()
by_id = {r["id"]: r for r in rows}
docs = np.load(path("emb", f"{SLUG}.docs.npy"))
qvec = np.load(path("emb", f"{SLUG}.queries.npy"))
q = read_json("queries.json")
flat = [(s, x) for s in SETS for x in q[s]]
DIMS = docs.shape[1]
root = path("engines", args.engine)
os.makedirs(root, exist_ok=True)
http = requests.Session()
report = {"engine": args.engine, "docs": len(rows), "dims": DIMS, "cpus": CPUS}


def sh(*cmd, check=True):
    return subprocess.run(cmd, capture_output=True, text=True, check=check).stdout.strip()


def wait(check, what, timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        try:
            if check():
                return time.time() - start
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"timed out waiting for {what}")


def container_mem():
    out = sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", f"vecbench-{args.engine}")
    return out.split("/")[0].strip()


def du(directory):
    """Bytes actually allocated on disk (preallocated/sparse files such as WALs and mmap
    segments otherwise inflate the apparent size)."""
    if not os.path.exists(directory):
        return 0
    return int(sh("sudo", "du", "-s", "--block-size=1", directory).split()[0])


def timed(fn, items, warm=30):
    for item in items[:warm]:
        fn(item)
    lat, out = [], []
    for item in items:
        t0 = time.perf_counter()
        out.append(fn(item))
        lat.append((time.perf_counter() - t0) * 1000)
    return out, {"p50": round(percentile(lat, 50), 2), "p95": round(percentile(lat, 95), 2),
                 "p99": round(percentile(lat, 99), 2), "n": len(lat)}


def save_run(name, rankings):
    split, i = {}, 0
    for s in SETS:
        split[s] = rankings[i : i + len(q[s])]
        i += len(q[s])
    with open(path("runs", f"{args.engine}.{name}.json"), "w") as handle:
        json.dump({"system": f"{args.engine}.{name}", "runs": split}, handle)


def filtered_quality(para, filtered):
    """Author-filtered top 10 against exact filtered search on the same vectors: how often the
    engine returns as many results as exist (an engine that filters after the ANN scan can come
    back short), recall@10 against the exact filtered top 10, and target hit rate."""
    ids = [r["id"] for r in rows]
    authors = np.array([r["author"] for r in rows])
    complete = recall = hit = 0.0
    for n, got in zip(para, filtered):
        target = flat[n][1]["target"]
        mask = np.where(authors == by_id[target]["author"])[0]
        best = mask[np.argsort(-(docs[mask] @ qvec[n]))[:10]]
        want = {ids[j] for j in best}
        complete += len(got) >= len(want)
        recall += len(set(got) & want) / len(want)
        hit += target in got
    k = len(para)
    return {"complete": round(complete / k, 3), "recall@10_vs_exact_filtered": round(recall / k, 3),
            "target_hit@10": round(hit / k, 3)}


def run_modes(lex_and, lex_or, vec, vec_author, hybrid_native):
    """Each callable takes an index into `flat` and returns ranked ids."""
    idx = list(range(len(flat)))
    lat = {}
    results = {}
    for name, fn in (("lex_and", lex_and), ("lex_or", lex_or), ("vec", vec), ("hybrid", hybrid_native)):
        if fn is None:
            continue
        results[name], lat[name] = timed(fn, idx)
        save_run(name, results[name])
    if "hybrid" not in results and "lex_or" in results:
        save_run("hybrid_app", [rrf(a, b) for a, b in zip(results["lex_or"], results["vec"])])
    para = [i for i, (s, _) in enumerate(flat) if s == "para"]
    if vec_author:
        filtered, lat["vec_author"] = timed(vec_author, para, warm=10)
        report["filtered"] = filtered_quality(para, filtered)
    report["latency_ms"] = lat
    # ANN recall@10 against exact brute force on the same vectors.
    exact = np.argsort(-(qvec @ docs.T), axis=1)[:, :10]
    ids = [r["id"] for r in rows]
    hits = [len(set(results["vec"][n][:10]) & {ids[j] for j in exact[n]}) / 10 for n in idx]
    report["ann_recall@10_vs_exact"] = round(sum(hits) / len(hits), 4)


def fresh(data, image):
    """Empty an engine's data directory so a rerun indexes from scratch. The engines write
    as their own users (Postgres as 999), so remove it from inside the image as root."""
    parent, name = os.path.split(data)
    sh("docker", "run", "--rm", "--user", "0", "-v", f"{parent}:/r", "--entrypoint", "rm", image, "-rf", f"/r/{name}")


def docker_run(*opts, image):
    sh("docker", "rm", "-f", f"vecbench-{args.engine}", check=False)
    sh("docker", "run", "-d", "--name", f"vecbench-{args.engine}", f"--cpus={CPUS}", *opts, image)
    report["image"] = image


# --------------------------------------------------------------------------- Elasticsearch
def elasticsearch():
    base = "http://127.0.0.1:9290"
    data = os.path.join(root, "data")
    fresh(data, "docker.elastic.co/elasticsearch/elasticsearch:9.5.3")
    os.makedirs(data, exist_ok=True)
    os.chmod(data, 0o777)
    docker_run("-p", "127.0.0.1:9290:9200", "-m", "2g", "-v", f"{data}:/usr/share/elasticsearch/data",
               "-e", "discovery.type=single-node", "-e", "xpack.security.enabled=false",
               "-e", "ES_JAVA_OPTS=-Xms512m -Xmx512m", "-e", "xpack.ml.enabled=false",
               image="docker.elastic.co/elasticsearch/elasticsearch:9.5.3")
    report["startup_s"] = round(wait(lambda: http.get(base + "/_cluster/health").ok, "elasticsearch"), 1)
    http.get(base + "/_cluster/health?wait_for_status=yellow&timeout=60s")
    lic = wait(lambda: http.get(base + "/_license").json().get("license"), "es license")
    report["license"] = http.get(base + "/_license").json()["license"]["type"]
    mapping = {"settings": {"number_of_shards": 1, "number_of_replicas": 0, "refresh_interval": "-1"},
               "mappings": {"properties": {
                   "text": {"type": "text"}, "author": {"type": "keyword"},
                   "createdAt": {"type": "date", "format": "epoch_millis"}, "likes": {"type": "integer"},
                   "vec": {"type": "dense_vector", "dims": DIMS, "similarity": "cosine", "index": True,
                           "index_options": {"type": "hnsw", "m": 16, "ef_construction": 100}}}}}
    http.put(base + "/posts", json=mapping).raise_for_status()
    t0 = time.perf_counter()
    for start in range(0, len(rows), 1000):
        lines = []
        for r, v in zip(rows[start : start + 1000], docs[start : start + 1000]):
            lines.append(json.dumps({"index": {"_index": "posts", "_id": r["id"]}}))
            lines.append(json.dumps({"text": r["text"], "author": r["author"], "createdAt": r["createdAt"],
                                     "likes": r["likes"], "vec": v.round(6).tolist()}))
        res = http.post(base + "/_bulk", data="\n".join(lines) + "\n",
                        headers={"content-type": "application/x-ndjson"}).json()
        assert not res["errors"], res["items"][:1]
    bulk = time.perf_counter() - t0
    t1 = time.perf_counter()
    http.put(base + "/posts/_settings", json={"index": {"refresh_interval": "1s"}}).raise_for_status()
    http.post(base + "/posts/_refresh").raise_for_status()
    http.post(base + "/posts/_flush").raise_for_status()
    refresh = time.perf_counter() - t1
    report["index"] = {"bulk_s": round(bulk, 1), "refresh_flush_s": round(refresh, 1),
                       "docs_per_s": round(len(rows) / (bulk + refresh)),
                       "count": http.get(base + "/posts/_count").json()["count"],
                       "segments": len(http.get(base + "/_cat/segments/posts?format=json").json())}

    def search(body):
        res = http.post(base + "/posts/_search", json={**body, "_source": False})
        res.raise_for_status()
        return [h["_id"] for h in res.json()["hits"]["hits"]]

    def lex(op):
        return lambda n: search({"size": 50, "query": {"match": {"text": {"query": flat[n][1]["q"], "operator": op}}}})

    def knn(n, author=None):
        clause = {"field": "vec", "query_vector": qvec[n].tolist(), "k": 50 if not author else 10,
                  "num_candidates": 100}
        if author:
            clause["filter"] = {"term": {"author": author}}
        return search({"size": clause["k"], "knn": clause})

    rrf_body = lambda n: {"size": 50, "retriever": {"rrf": {"rank_window_size": 50, "rank_constant": 60, "retrievers": [
        {"standard": {"query": {"match": {"text": flat[n][1]["q"]}}}},
        {"knn": {"field": "vec", "query_vector": qvec[n].tolist(), "k": 50, "num_candidates": 100}}]}}}
    probe = http.post(base + "/posts/_search", json=rrf_body(0))
    report["native_rrf_on_basic"] = {"status": probe.status_code, "error": probe.json().get("error", {}).get("reason")}
    native = (lambda n: search(rrf_body(n))) if probe.ok else None
    run_modes(lex("and"), lex("or"), knn, lambda n: knn(n, by_id[flat[n][1]["target"]]["author"]), native)
    report["size_bytes"] = {"index_store": http.get(base + "/posts/_stats/store").json()["_all"]["primaries"]["store"]["size_in_bytes"],
                            "data_dir": du(data)}


# --------------------------------------------------------------------------- Qdrant
def qdrant():
    from fastembed import SparseTextEmbedding

    base = "http://127.0.0.1:6390"
    data = os.path.join(root, "storage")
    fresh(data, "qdrant/qdrant:v1.19.2")
    os.makedirs(data, exist_ok=True)
    docker_run("-p", "127.0.0.1:6390:6333", "-p", "127.0.0.1:6391:6334", "-m", "1g", "-v", f"{data}:/qdrant/storage",
               image="qdrant/qdrant:v1.19.2")
    report["startup_s"] = round(wait(lambda: http.get(base + "/readyz").ok, "qdrant"), 1)
    bm25 = SparseTextEmbedding("Qdrant/bm25")
    t_sparse = time.perf_counter()
    sparse_docs = list(bm25.embed([r["text"] for r in rows], batch_size=256))
    sparse_secs = time.perf_counter() - t_sparse
    sparse_q = list(bm25.query_embed([x["q"] for _, x in flat]))
    http.put(base + "/collections/posts", json={
        "vectors": {"dense": {"size": DIMS, "distance": "Cosine", "hnsw_config": {"m": 16, "ef_construct": 100}}},
        "sparse_vectors": {"bm25": {"modifier": "idf"}}}).raise_for_status()
    for field, kind in (("author", "keyword"), ("createdAt", "integer")):
        http.put(base + "/collections/posts/index?wait=true",
                 json={"field_name": field, "field_schema": kind}).raise_for_status()
    t0 = time.perf_counter()
    for start in range(0, len(rows), 500):
        points = []
        for r, v, s in zip(rows[start : start + 500], docs[start : start + 500], sparse_docs[start : start + 500]):
            points.append({"id": int(r["id"]), "payload": {"author": r["author"], "createdAt": r["createdAt"],
                                                         "likes": r["likes"]},
                           "vector": {"dense": v.round(6).tolist(),
                                      "bm25": {"indices": s.indices.tolist(), "values": s.values.tolist()}}})
        http.put(base + "/collections/posts/points?wait=true", json={"points": points}).raise_for_status()
    upsert = time.perf_counter() - t0
    t1 = time.perf_counter()
    info = lambda: http.get(base + "/collections/posts").json()["result"]
    wait(lambda: info()["status"] == "green" and info().get("indexed_vectors_count", 0) >= len(rows) * 0.99,
         "qdrant hnsw", timeout=1800)
    hnsw = time.perf_counter() - t1
    report["index"] = {"sparse_encode_s": round(sparse_secs, 1), "upsert_s": round(upsert, 1),
                       "hnsw_wait_s": round(hnsw, 1), "docs_per_s": round(len(rows) / (sparse_secs + upsert + hnsw)),
                       "count": info()["points_count"], "segments": info()["segments_count"]}

    # Queries go over gRPC, as the Rust client would. Over REST, any response larger than
    # ~10 hits stalls ~45 ms on a delayed ACK (measured: server time 1.3 ms, client 48 ms).
    from qdrant_client import QdrantClient, models

    client = QdrantClient(host="127.0.0.1", port=6390, grpc_port=6391, prefer_grpc=True)

    def grpc_query(body):
        if isinstance(body["query"], dict) and "indices" in body["query"]:
            return models.SparseVector(**body["query"])
        return body["query"]

    def query(body):
        params = models.SearchParams(hnsw_ef=body["params"]["hnsw_ef"]) if "params" in body else None
        flt = None
        if "filter" in body:
            cond = body["filter"]["must"][0]
            flt = models.Filter(must=[models.FieldCondition(key=cond["key"],
                                                            match=models.MatchValue(value=cond["match"]["value"]))])
        if "prefetch" in body:
            prefetch = [models.Prefetch(query=grpc_query(p), using=p["using"], limit=p["limit"],
                                        params=models.SearchParams(hnsw_ef=p["params"]["hnsw_ef"]) if "params" in p else None)
                        for p in body["prefetch"]]
            res = client.query_points("posts", prefetch=prefetch, query=models.FusionQuery(fusion=models.Fusion.RRF),
                                      limit=body["limit"])
        else:
            res = client.query_points("posts", query=grpc_query(body), using=body["using"], limit=body["limit"],
                                      search_params=params, query_filter=flt)
        return [str(p.id) for p in res.points]

    def sparse(n):
        s = sparse_q[n]
        return {"indices": s.indices.tolist(), "values": s.values.tolist()}

    def dense(n, author=None):
        body = {"query": qvec[n].tolist(), "using": "dense", "limit": 50 if not author else 10,
                "params": {"hnsw_ef": 100}}
        if author:
            body["filter"] = {"must": [{"key": "author", "match": {"value": author}}]}
        return query(body)

    hybrid = lambda n: query({"prefetch": [{"query": sparse(n), "using": "bm25", "limit": 50},
                                           {"query": qvec[n].tolist(), "using": "dense", "limit": 50,
                                            "params": {"hnsw_ef": 100}}],
                              "query": {"fusion": "rrf"}, "limit": 50})
    run_modes(None, lambda n: query({"query": sparse(n), "using": "bm25", "limit": 50}), dense,
              lambda n: dense(n, by_id[flat[n][1]["target"]]["author"]), hybrid)
    report["size_bytes"] = {"data_dir": du(data)}


# --------------------------------------------------------------------------- ParadeDB
def paradedb():
    import psycopg

    data = os.path.join(root, "pgdata")
    fresh(data, "paradedb/paradedb:0.26.1-pg17")
    docker_run("-p", "127.0.0.1:5490:5432", "-m", "1g", "--shm-size=256m", "-e", "POSTGRES_PASSWORD=bench",
               "-e", "PGDATA=/var/lib/postgresql/data/pgdata", "-v", f"{data}:/var/lib/postgresql/data/pgdata",
               image="paradedb/paradedb:0.26.1-pg17")
    dsn = "host=127.0.0.1 port=5490 user=postgres password=bench dbname=postgres"
    report["startup_s"] = round(wait(lambda: psycopg.connect(dsn, connect_timeout=2).close() is None, "postgres"), 1)
    time.sleep(3)  # the image restarts postgres once after init
    wait(lambda: psycopg.connect(dsn, connect_timeout=2).close() is None, "postgres")
    db = psycopg.connect(dsn, autocommit=True)
    db.execute("CREATE EXTENSION IF NOT EXISTS pg_search")
    db.execute("CREATE EXTENSION IF NOT EXISTS vector")
    report["versions"] = dict(db.execute("SELECT extname, extversion FROM pg_extension").fetchall())
    db.execute("DROP TABLE IF EXISTS posts")
    db.execute(f"CREATE TABLE posts (id text PRIMARY KEY, author text, body text, created_at bigint, "
               f"likes int, emb vector({DIMS}))")
    t0 = time.perf_counter()
    with db.cursor().copy("COPY posts (id, author, body, created_at, likes, emb) FROM STDIN") as copy:
        for r, v in zip(rows, docs):
            copy.write_row((r["id"], r["author"], r["text"], r["createdAt"], r["likes"],
                            "[" + ",".join(f"{x:.6f}" for x in v) + "]"))
    load = time.perf_counter() - t0
    t1 = time.perf_counter()
    db.execute("CREATE INDEX posts_bm25 ON posts USING bm25 (id, body, author, created_at) WITH (key_field='id')")
    bm25_s = time.perf_counter() - t1
    t2 = time.perf_counter()
    db.execute("SET maintenance_work_mem = '256MB'")
    db.execute("SET max_parallel_maintenance_workers = 0")
    db.execute("CREATE INDEX posts_hnsw ON posts USING hnsw (emb vector_cosine_ops) WITH (m = 16, ef_construction = 100)")
    hnsw_s = time.perf_counter() - t2
    db.execute("CREATE INDEX posts_author ON posts (author)")
    db.execute("ANALYZE posts")
    db.execute("SET hnsw.ef_search = 100")
    report["index"] = {"copy_s": round(load, 1), "bm25_index_s": round(bm25_s, 1), "hnsw_index_s": round(hnsw_s, 1),
                       "docs_per_s": round(len(rows) / (load + bm25_s + hnsw_s))}

    def ids(sql, params):
        return [r[0] for r in db.execute(sql, params).fetchall()]

    def lex(op):
        sql = f"SELECT id FROM posts WHERE body {op} %s ORDER BY pdb.score(id) DESC LIMIT 50"
        return lambda n: ids(sql, (flat[n][1]["q"],))

    vec_sql = "SELECT id FROM posts ORDER BY emb <=> %s::vector LIMIT %s"
    vec_author_sql = "SELECT id FROM posts WHERE author = %s ORDER BY emb <=> %s::vector LIMIT 10"
    lit = lambda n: "[" + ",".join(f"{x:.6f}" for x in qvec[n]) + "]"
    hybrid_sql = """
      WITH lex AS (SELECT id, row_number() OVER (ORDER BY pdb.score(id) DESC) AS r
                   FROM posts WHERE body ||| %(q)s ORDER BY pdb.score(id) DESC LIMIT 50),
           sem AS (SELECT id, row_number() OVER (ORDER BY emb <=> %(v)s::vector) AS r
                   FROM posts ORDER BY emb <=> %(v)s::vector LIMIT 50)
      SELECT id FROM (SELECT id, 1.0/(60+r) s FROM lex UNION ALL SELECT id, 1.0/(60+r) s FROM sem) u
      GROUP BY id ORDER BY sum(s) DESC LIMIT 50"""
    run_modes(lex("&&&"), lex("|||"), lambda n: ids(vec_sql, (lit(n), 50)),
              lambda n: ids(vec_author_sql, (by_id[flat[n][1]["target"]]["author"], lit(n))),
              lambda n: ids(hybrid_sql, {"q": flat[n][1]["q"], "v": lit(n)}))
    # pgvector 0.8 can keep scanning the graph until the filter is satisfied.
    db.execute("SET hnsw.iterative_scan = relaxed_order")
    para = [i for i, (s, _) in enumerate(flat) if s == "para"]
    got, report["latency_ms"]["vec_author_iterative"] = timed(
        lambda n: ids(vec_author_sql, (by_id[flat[n][1]["target"]]["author"], lit(n))), para, warm=10)
    report["filtered_iterative"] = filtered_quality(para, got)
    db.execute("SET hnsw.iterative_scan = off")
    sizes = dict(db.execute("""SELECT c.relname, pg_relation_size(c.oid) FROM pg_class c
                               WHERE c.relname IN ('posts','posts_bm25','posts_hnsw','posts_pkey','posts_author')""").fetchall())
    sizes["toast_and_all"] = db.execute("SELECT pg_total_relation_size('posts')").fetchone()[0]
    report["size_bytes"] = sizes
    report["explain_vec_author"] = [r[0] for r in db.execute(
        "EXPLAIN " + vec_author_sql.replace("%s::vector", f"'{lit(0)}'::vector").replace("%s", "'theo'")).fetchall()][:6]


# --------------------------------------------------------------------------- Tantivy (existing) over HTTP
def tantivy():
    index = path("tantivy", "index")
    env = {**os.environ, "SEARCH_SERVICE_TOKEN": TOKEN, "SEARCH_LOCAL_SIGNING_KEY": TOKEN[::-1] + "-signing"}
    server = subprocess.Popen([args.tantivy_bin, "--index", index, "serve", "--listen", "127.0.0.1:4390"],
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        report["startup_s"] = round(wait(lambda: http.get("http://127.0.0.1:4390/health").ok, "tantivy"), 1)
        headers = {"authorization": f"Bearer {TOKEN}"}

        def lex(n):
            res = http.post("http://127.0.0.1:4390/search", headers=headers,
                            json={"version": 1, "query": flat[n][1]["q"], "sort": "relevance", "limit": 20})
            res.raise_for_status()
            return [r["tweetId"] for r in res.json()["rows"]]

        idx = list(range(len(flat)))
        results, lat = timed(lex, idx)
        save_run("lex_and", results)
        report["latency_ms"] = {"lex_and": lat}
        report["rss_kb"] = int(sh("ps", "-o", "rss=", "-p", str(server.pid)))
        report["size_bytes"] = {"index_dir": du(index)}
    finally:
        server.terminate()
        server.wait()


try:
    {"es": elasticsearch, "qdrant": qdrant, "paradedb": paradedb, "tantivy": tantivy}[args.engine]()
    if args.engine != "tantivy":
        report["container_mem_after_queries"] = container_mem()
finally:
    if args.engine != "tantivy" and not args.keep:
        sh("docker", "rm", "-f", f"vecbench-{args.engine}", check=False)
    with open(path("engines", f"{args.engine}.json"), "w") as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps(report, indent=1)[:3000])
