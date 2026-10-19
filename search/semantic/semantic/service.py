"""Separate single-threaded API and single-writer worker processes."""

import argparse
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import signal
import threading
import time
from .contracts import Manifest, Request, authorized, credential
from .embedding import Embedding, warmup
from .projection import Projection, counts, read_db
from .qdrant import Qdrant
from .telemetry import Telemetry


def display_post(post: dict) -> dict:
    """Adapt a normalized corpus post to the app's bounded display contract.

    Keep full stored/searchable text. Zod's string limits count code points,
    as Python slices do; ingest already bounds nested strings and collections.
    """
    result = {**post, "text": post["text"][:6000]}
    if "displayName" in result:
        result["displayName"] = result["displayName"][:100]
    if "links" in result:
        result["links"] = result["links"][:10]
    if "media" in result:
        # Ingest accepts positive u32 dimensions; the app caps display pixels.
        result["media"] = [
            {
                key: value
                for key, value in item.items()
                if key not in ("width", "height") or value <= 100_000
            }
            for item in result["media"]
        ]
    return result


class Search:
    def __init__(self, path, manifest, encoder, store, telemetry):
        self.path, self.manifest, self.encoder, self.store, self.telemetry = (
            path,
            manifest,
            encoder,
            store,
            telemetry,
        )

    def health(self) -> dict:
        marker = self.store.ensure(False)
        with closing(read_db(self.path, self.manifest.generation)) as db:
            saved = db.execute(
                "SELECT value FROM meta WHERE key='collection_marker'"
            ).fetchone()
            ready = saved is not None and saved[0] == marker
            result = counts(db)
            result.update(
                {
                    "ready": ready,
                    "model": self.manifest.data["policy"]["model"],
                    "generation": self.manifest.generation,
                    "coverageKind": "acknowledged",
                    "reconciledAtMs": self._reconciled(db),
                }
            )
            return result

    @staticmethod
    def _reconciled(db) -> int | None:
        row = db.execute("SELECT value FROM meta WHERE key='reconciled_ms'").fetchone()
        return int(row[0]) if row else None

    def search(self, request: Request) -> dict:
        started = time.monotonic()
        marker = self.store.ensure(False)
        embedding = self.encoder.query(request.text)
        embedded = time.monotonic()
        candidate_bound = min(1000, max(64, request.limit * 8))
        candidates = self.store.search(embedding, request, candidate_bound)
        retrieved = time.monotonic()
        hits = []
        seen = set()  # Bounded by the candidate limit, never corpus size.
        with closing(read_db(self.path, self.manifest.generation)) as db:
            db.execute("BEGIN")
            saved = db.execute(
                "SELECT value FROM meta WHERE key='collection_marker'"
            ).fetchone()
            if saved is None or saved[0] != marker:
                raise RuntimeError("Projection is not ready")
            coverage = counts(db)
            for candidate in candidates:
                post_id = candidate["payload"].get("tweetId")
                row = db.execute(
                    "SELECT * FROM posts WHERE id=?", (post_id,)
                ).fetchone()
                if (
                    row is None
                    or row["point"] != candidate["id"]
                    or candidate["payload"].get("pointId") != row["point"]
                    or candidate["payload"].get("revision")
                    != [row["provenance"], row["observed"], row["sha"], row["ordinal"]]
                    or candidate["payload"].get("model") != self.manifest.generation
                    or candidate["payload"].get("textHash") != row["text_hash"]
                    or post_id in seen
                ):
                    continue
                post = json.loads(row["post"])
                # Hydrated filters guard stale/malformed payloads too.
                created = post.get("createdAt")
                if request.author and post["author"] != request.author:
                    continue
                if request.since_ms is not None and (
                    created is None or created < request.since_ms
                ):
                    continue
                if request.until_ms is not None and (
                    created is None or created >= request.until_ms
                ):
                    continue
                hits.append({"post": display_post(post), "score": candidate["score"]})
                seen.add(post_id)
                if len(hits) == request.limit:
                    break
            db.rollback()
        timings = {
            "embeddingMs": (embedded - started) * 1000,
            "retrievalMs": (retrieved - embedded) * 1000,
        }
        underfilled = len(hits) < request.limit
        self.telemetry.event(
            "semantic.search",
            "query",
            count=len(hits),
            candidates=len(candidates),
            underfilled=underfilled,
            durationMs=(time.monotonic() - started) * 1000,
            **timings,
            **{k: coverage[k] for k in ("posts", "pending", "coverage", "queueLagMs")},
        )
        return {
            "hits": hits,
            "model": self.manifest.data["policy"]["model"],
            "generation": self.manifest.generation,
            "coverage": coverage,
            "coverageKind": "acknowledged",
            "underfilled": underfilled,
            "candidateBound": candidate_bound,
            "timings": timings,
        }


def strict_json(raw: bytes):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("Nonfinite number")

    return json.loads(raw, object_pairs_hook=unique, parse_constant=constant)


def handler(search: Search, token: str):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass  # Base handler logs paths and request contents; keep private data out.

        def reply(self, status, value):
            encoded = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(encoded)
            self.close_connection = True

        def send_error(self, code, message=None, explain=None):
            self.reply(code, {"error": "invalid_request"})

        def do_GET(self):
            if self.path != "/health":
                self.reply(404, {"error": "not_found"})
                return
            try:
                result = search.health()
                self.reply(200 if result["ready"] else 503, result)
            except Exception:
                self.reply(503, {"ready": False, "error": "not_ready"})

        def do_POST(self):
            if not authorized(self.headers.get("Authorization"), token):
                self.reply(401, {"error": "unauthorized"})
                return
            if self.path != "/semantic/v1/search":
                self.reply(404, {"error": "not_found"})
                return
            try:
                if len(self.headers.get_all("Authorization", [])) != 1:
                    raise ValueError("Duplicate auth")
                lengths = self.headers.get_all("Content-Length", [])
                if (
                    len(lengths) != 1
                    or not lengths[0].isascii()
                    or not lengths[0].isdecimal()
                ):
                    raise ValueError("Invalid length")
                length = int(lengths[0])
                if (
                    not 1 <= length <= 65536
                    or self.headers.get("Transfer-Encoding") is not None
                ):
                    raise ValueError("Invalid body")
                if (
                    self.headers.get("Content-Type", "").split(";")[0].strip().lower()
                    != "application/json"
                ):
                    raise ValueError("Invalid content type")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Partial body")
                request = Request.parse(strict_json(raw))
            except Exception:
                self.reply(400, {"error": "invalid_request"})
                return
            try:
                self.reply(200, search.search(request))
            except Exception:
                search.telemetry.event("semantic.error", "query", failures=1)
                self.reply(503, {"error": "unavailable"})

    return Handler


def worker(
    projection: Projection,
    archive: Path,
    exporter: Path,
    encoder,
    store,
    telemetry,
    stop: threading.Event,
    once: bool,
):
    scan = iter(projection.discover(archive))
    heartbeat = 0.0
    while not stop.is_set():
        row, delivered = None, 0
        started = time.monotonic()
        try:
            try:
                next(scan)
            except StopIteration:
                scan = iter(projection.discover(archive))
            row = projection.next_capture()
            if row:
                accepted = projection.ingest(row["sha"], Path(row["path"]), exporter)
                if not accepted:
                    telemetry.event("semantic.error", "ingest", failures=1)
            projection.reconcile(store)
            delivered = projection.deliver(encoder, store)
            telemetry.event(
                "semantic.index_batch",
                "delivery",
                count=delivered,
                durationMs=(time.monotonic() - started) * 1000,
            )
            if time.monotonic() - heartbeat >= 30:
                metrics = counts(projection.db)
                telemetry.event(
                    "semantic.heartbeat",
                    "worker",
                    **{
                        k: metrics[k]
                        for k in ("posts", "pending", "coverage", "queueLagMs")
                    },
                )
                heartbeat = time.monotonic()
        except Exception:
            telemetry.event("semantic.error", "worker", failures=1)
            if once:
                raise RuntimeError("Worker pass failed") from None
            stop.wait(2)
        if once:
            break
        if row is None and delivered == 0:
            stop.wait(1)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(
        description="Private semantic projection; no keyword or capture service mutations"
    )
    parser.add_argument(
        "command",
        choices=[
            "warmup",
            "init",
            "watch",
            "once",
            "serve",
            "status",
            "reconcile",
            "backup",
        ],
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path(os.environ.get("SEMANTIC_MODEL_DIR", "model")),
    )
    parser.add_argument(
        "--state",
        type=Path,
        default=Path(os.environ.get("SEMANTIC_STATE", "projection.sqlite")),
    )
    parser.add_argument(
        "--archive",
        type=Path,
        default=Path(os.environ.get("SEMANTIC_ARCHIVE", "archive")),
    )
    parser.add_argument(
        "--exporter",
        type=Path,
        default=Path(os.environ.get("SEMANTIC_EXPORTER", "xearch-export")),
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "warmup":
        manifest = warmup(args.model_dir)
        print(
            json.dumps(
                {"generation": manifest.generation, "collection": manifest.collection}
            )
        )
        return
    manifest = Manifest.load(args.model_dir / "manifest.json")
    if args.command == "status":
        with closing(read_db(args.state, manifest.generation)) as db:
            print(json.dumps({"generation": manifest.generation, **counts(db)}))
        return
    if args.command == "backup":
        if args.output is None:
            parser.error("backup requires --output")
        # SQLite backup supports a live writer and does not acquire its flock or mutate the source.
        with closing(read_db(args.state, manifest.generation)) as db:
            if args.output.exists():
                raise ValueError("Backup target already exists")
            with closing(__import__("sqlite3").connect(args.output)) as target:
                db.backup(target, pages=256)
        return
    key = credential(os.environ.get("QDRANT__SERVICE__API_KEY", ""))
    store = Qdrant(manifest, key)
    telemetry = Telemetry(manifest.generation)
    if args.command == "serve":
        token = credential(os.environ.get("SEMANTIC_READ_TOKEN", ""))
        if token == key:
            raise ValueError("Read token must differ from Qdrant admin key")
        store.ensure(False)
        with closing(read_db(args.state, manifest.generation)):
            pass
        search = Search(args.state, manifest, Embedding(manifest), store, telemetry)
        server = HTTPServer(("127.0.0.1", 4330), handler(search, token))
        server.serve_forever()
        return
    projection = Projection(args.state, manifest)
    try:
        projection.ensure_collection(store)
        if args.command == "init":
            return
        if args.command == "reconcile":
            # One bounded pass; repeat or let watch cycle until fully reconciled.
            projection.reconcile(store)
            print(json.dumps(counts(projection.db)))
            return
        encoder = Embedding(manifest)
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        worker(
            projection,
            args.archive,
            args.exporter,
            encoder,
            store,
            telemetry,
            stop,
            args.command == "once",
        )
    finally:
        projection.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"error":"semantic_command_failed"}', file=__import__("sys").stderr)
        raise SystemExit(1) from None
