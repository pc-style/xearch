"""SQLite owns publication and delivery. Qdrant is a disposable projection.

Each generation has its own DB + collection. One flock owner writes; API readers
pin a SQLite transaction while hydrating only current immutable point revisions.
"""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import uuid
from .contracts import Manifest, SHA, Encoder, VectorStore, canonical, digest

PAGE = 32
MAX_INPUT = 64 * 1024 * 1024
MAX_LINE = MAX_INPUT * 2 + 1024 * 1024
DELIVERY_FIELDS = """id,provenance,observed,sha,ordinal,searchable,text_hash,point,pending,
 delivered,delivered_hash,json_extract(post,'$.author') AS author,
 json_extract(post,'$.createdAt') AS created"""
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS captures(sha TEXT PRIMARY KEY, path TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'discovered', attempts INTEGER NOT NULL DEFAULT 0,
 accepted INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
 stage TEXT NOT NULL DEFAULT 'discovered', error TEXT, attempted_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS capture_work ON captures(status,attempted_ms,sha);
CREATE TABLE IF NOT EXISTS staging(sha TEXT NOT NULL, ordinal INTEGER NOT NULL,
 provenance INTEGER NOT NULL, observed INTEGER NOT NULL, post_id TEXT NOT NULL,
 post TEXT NOT NULL, searchable TEXT NOT NULL, text_hash TEXT NOT NULL,
 PRIMARY KEY(sha,ordinal));
CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, provenance INTEGER NOT NULL,
 observed INTEGER NOT NULL, sha TEXT NOT NULL, ordinal INTEGER NOT NULL,
 post TEXT NOT NULL, searchable TEXT NOT NULL, text_hash TEXT NOT NULL,
 point TEXT UNIQUE NOT NULL, pending INTEGER NOT NULL DEFAULT 1,
 delivered TEXT, delivered_hash TEXT, queued_ms INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, attempt_ms INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS delivery_queue ON posts(pending,attempt_ms,queued_ms,id);
CREATE INDEX IF NOT EXISTS queue_age ON posts(pending,queued_ms);
CREATE TABLE IF NOT EXISTS gc(point TEXT PRIMARY KEY, post_id TEXT NOT NULL);
"""


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def read_db(path: Path, generation: str) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    try:
        row = db.execute("SELECT value FROM meta WHERE key='generation'").fetchone()
        if row is None or row[0] != generation:
            raise ValueError("Projection generation mismatch")
    except Exception:
        db.close()
        raise
    return db


def counts(db: sqlite3.Connection) -> dict:
    total = db.execute("SELECT count(*) FROM posts").fetchone()[0]
    pending = db.execute("SELECT count(*) FROM posts WHERE pending=1").fetchone()[0]
    oldest = db.execute("SELECT min(queued_ms) FROM posts WHERE pending=1").fetchone()[
        0
    ]
    captures = dict(db.execute("SELECT status,count(*) FROM captures GROUP BY status"))
    return {
        "posts": total,
        "pending": pending,
        "acknowledged": total - pending,
        "coverage": (total - pending) / total if total else 0,
        "queueLagMs": max(0, now_ms() - oldest) if oldest else 0,
        "captures": captures,
        "staged": db.execute("SELECT count(*) FROM staging").fetchone()[0],
        "stages": dict(
            db.execute("SELECT stage,count(*) FROM captures GROUP BY stage")
        ),
        "scannedAtMs": metric_time(db, "scanned_ms"),
        "reconciledAtMs": metric_time(db, "reconciled_ms"),
    }


def metric_time(db: sqlite3.Connection, key: str) -> int | None:
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return int(row[0]) if row else None


class Projection:
    def __init__(self, path: Path, manifest: Manifest):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = (path.parent / (path.name + ".lock")).open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            self.lock.close()
            raise ValueError("Projection already has a writer") from None
        self.path, self.manifest = path, manifest
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA cache_size=-8192")
        self.db.executescript(SCHEMA)
        generation = self.meta("generation")
        if generation is not None and generation != manifest.generation:
            self.close()
            raise ValueError("Projection generation mismatch; use a new state path")
        with self.db:
            self.set_meta("generation", manifest.generation)
            self.set_meta("manifest", canonical(manifest.data))
            self.db.execute(
                "UPDATE captures SET status='failed',stage='interrupted',error='interrupted' WHERE status='staging'"
            )

    def close(self) -> None:
        self.db.close()
        self.lock.close()

    def meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def discover(self, archive: Path):
        """Streaming traversal: no directory list or all-ID cache. Yield each page."""

        def visit(directory: Path):
            with os.scandir(directory) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False):
                        yield from visit(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False) and entry.name.endswith(
                        ".json"
                    ):
                        sha = entry.name.removesuffix(".json")
                        if SHA.fullmatch(sha):
                            yield sha, entry.path

        page = []
        for source in visit(archive):
            page.append(source)
            if len(page) == PAGE:
                with self.db:
                    self.db.executemany(
                        "INSERT OR IGNORE INTO captures(sha,path) VALUES(?,?)", page
                    )
                yield len(page)
                page.clear()
        if page:
            with self.db:
                self.db.executemany(
                    "INSERT OR IGNORE INTO captures(sha,path) VALUES(?,?)", page
                )
            yield len(page)
        with self.db:
            self.set_meta("scanned_ms", str(now_ms()))

    def next_capture(self) -> sqlite3.Row | None:
        """Oldest attempt first, so one bad capture never starves the rest.

        A failed capture waits a minute after its first failure, doubling per
        attempt up to an hour: it stays visible and retried, but a malformed
        file is not re-exported every pass forever.
        """
        return self.db.execute(
            """SELECT sha,path FROM captures WHERE status!='complete'
            AND (status!='failed' OR attempted_ms + min(3600000, 60000 << min(attempts - 1, 6)) <= ?)
            ORDER BY attempted_ms,sha LIMIT 1""",
            (now_ms(),),
        ).fetchone()

    def ingest(self, sha: str, source: Path, exporter: Path) -> bool:
        row = self.db.execute(
            "SELECT status FROM captures WHERE sha=?", (sha,)
        ).fetchone()
        if row and row[0] == "complete":
            return False
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO captures(sha,path) VALUES(?,?)",
                (sha, str(source)),
            )
            self.db.execute("DELETE FROM staging WHERE sha=?", (sha,))
            self.db.execute(
                "UPDATE captures SET status='staging',stage='hash',error=NULL,attempts=attempts+1,attempted_ms=? WHERE sha=?",
                (now_ms(), sha),
            )
        process = None
        try:
            if (
                not SHA.fullmatch(sha)
                or source.stat().st_size > MAX_INPUT
                or digest(source) != sha
            ):
                raise ValueError("checksum")
            with self.db:
                self.db.execute(
                    "UPDATE captures SET stage='export' WHERE sha=?", (sha,)
                )
            process = subprocess.Popen(
                [str(exporter), str(source)],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            assert process.stdout is not None

            def events():
                while line := process.stdout.readline(MAX_LINE + 1):
                    if len(line) > MAX_LINE or not line.endswith(b"\n"):
                        raise ValueError("export_protocol")
                    yield json.loads(line)

            receipt = self.stage(sha, events())
            if process.wait() != 0 or digest(source) != sha:
                raise ValueError("export_failed")
            self.publish(sha, receipt)
            return True
        except Exception:
            if process and process.poll() is None:
                process.terminate()
                process.wait()
            with self.db:
                self.db.execute(
                    "UPDATE captures SET status='failed',stage='failed',error='capture_failed' WHERE sha=?",
                    (sha,),
                )
            return False
        finally:
            if process and process.stdout:
                process.stdout.close()

    def stage(self, sha: str, events) -> dict:
        """Staging commits are checkpoints, never visible publication."""
        batch = []
        last = -1
        accepted = 0
        receipt = None
        for event in events:
            if (
                not isinstance(event, dict)
                or type(event.get("version")) is not int
                or event.get("version") != 1
                or receipt is not None
            ):
                raise ValueError("export_protocol")
            if event.get("type") == "receipt":
                if (
                    event.get("normalizer") != "search-ingest-v1"
                    or event.get("textPolicy") != "post-searchable-v1"
                    or type(event.get("accepted")) is not int
                    or event["accepted"] != accepted
                    or type(event.get("rejected")) is not int
                    or event["rejected"] < 0
                ):
                    raise ValueError("export_receipt")
                receipt = event
                continue
            if event.get("type") != "post":
                raise ValueError("export_protocol")
            ordinal, observed = event.get("ordinal"), event.get("observedAtMs")
            if type(ordinal) is not int or not last < ordinal <= 9223372036854775807:
                raise ValueError("export_ordinal")
            if observed is not None and (
                type(observed) is not int or not 0 <= observed <= 9223372036854775807
            ):
                raise ValueError("export_timestamp")
            post, text = event.get("post"), event.get("searchable")
            if not isinstance(post, dict) or not isinstance(text, str):
                raise ValueError("export_post")
            post_id = post.get("tweetId")
            if (
                not isinstance(post_id, str)
                or not re_id(post_id)
                or not isinstance(post.get("author"), str)
            ):
                raise ValueError("export_post")
            text_hash = hashlib.sha256(text.encode()).hexdigest()
            batch.append(
                (
                    sha,
                    ordinal,
                    int(observed is not None),
                    observed or 0,
                    post_id,
                    canonical(post),
                    text,
                    text_hash,
                )
            )
            last, accepted = ordinal, accepted + 1
            if len(batch) == PAGE:
                with self.db:
                    self.db.executemany(
                        "INSERT INTO staging VALUES(?,?,?,?,?,?,?,?)", batch
                    )
                batch.clear()
        if receipt is None:
            raise ValueError("missing_receipt")
        with self.db:
            self.db.executemany("INSERT INTO staging VALUES(?,?,?,?,?,?,?,?)", batch)
            self.db.execute("UPDATE captures SET stage='staged' WHERE sha=?", (sha,))
        return receipt

    def publish(self, sha: str, receipt: dict) -> None:
        # One transaction publishes the entire capture, with paged reads inside it.
        with self.db:
            after = -1
            while True:
                rows = self.db.execute(
                    "SELECT * FROM staging WHERE sha=? AND ordinal>? ORDER BY ordinal LIMIT ?",
                    (sha, after, PAGE),
                ).fetchall()
                if not rows:
                    break
                for row in rows:
                    after = row["ordinal"]
                    old = self.db.execute(
                        "SELECT * FROM posts WHERE id=?", (row["post_id"],)
                    ).fetchone()
                    revision = (row["provenance"], row["observed"], sha, row["ordinal"])
                    if old and revision <= (
                        old["provenance"],
                        old["observed"],
                        old["sha"],
                        old["ordinal"],
                    ):
                        continue
                    point = str(
                        uuid.uuid5(
                            uuid.NAMESPACE_URL,
                            canonical(
                                [self.manifest.generation, row["post_id"], revision]
                            ),
                        )
                    )
                    if old:
                        self.db.execute(
                            "INSERT OR IGNORE INTO gc VALUES(?,?)",
                            (old["point"], old["id"]),
                        )
                    self.db.execute(
                        """INSERT INTO posts(id,provenance,observed,sha,ordinal,post,searchable,text_hash,point,queued_ms)
                     VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                     provenance=excluded.provenance,observed=excluded.observed,sha=excluded.sha,ordinal=excluded.ordinal,
                     post=excluded.post,searchable=excluded.searchable,text_hash=excluded.text_hash,point=excluded.point,
                     pending=1,queued_ms=excluded.queued_ms,attempt_ms=0,attempts=0,error=NULL""",
                        (
                            row["post_id"],
                            *revision,
                            row["post"],
                            row["searchable"],
                            row["text_hash"],
                            point,
                            now_ms(),
                        ),
                    )
            self.db.execute(
                "UPDATE captures SET status='complete',stage='complete',error=NULL,accepted=?,rejected=? WHERE sha=?",
                (receipt["accepted"], receipt["rejected"], sha),
            )
            self.db.execute("DELETE FROM staging WHERE sha=?", (sha,))

    def ensure_collection(self, store: VectorStore, create: bool = True) -> str:
        marker = store.ensure(create)
        if self.meta("collection_marker") != marker:
            with self.db:
                self.db.execute(
                    "UPDATE posts SET pending=1,delivered=NULL,delivered_hash=NULL,error=NULL"
                )
                self.set_meta("collection_marker", marker)
                self.set_meta("reconcile_after", "")
                self.set_meta("scroll_after", "")
        return marker

    def payload(self, row: sqlite3.Row) -> dict:
        if "author" in row.keys():
            author, created = row["author"], row["created"]
        else:
            post = json.loads(row["post"])
            author, created = post["author"], post.get("createdAt")
        payload = {
            "tweetId": row["id"],
            "pointId": row["point"],
            "revision": [
                row["provenance"],
                row["observed"],
                row["sha"],
                row["ordinal"],
            ],
            "author": author,
            "textHash": row["text_hash"],
            "model": self.manifest.generation,
        }
        if created is not None:
            payload["createdAt"] = created
        return payload

    def deliver(self, encoder: Encoder, store: VectorStore, limit: int = PAGE) -> int:
        self.ensure_collection(store)
        rows = self.db.execute(
            f"SELECT {DELIVERY_FIELDS} FROM posts WHERE pending=1 ORDER BY attempt_ms,queued_ms,id LIMIT ?",
            (limit,),
        ).fetchall()
        if not rows:
            return 0
        with self.db:
            self.db.executemany(
                "UPDATE posts SET attempts=attempts+1,attempt_ms=?,error='delivery_inflight' WHERE id=? AND point=?",
                [(now_ms(), row["id"], row["point"]) for row in rows],
            )
        points = []
        infer_rows = []

        def reusable(row) -> str | None:
            return row["delivered"] if row["delivered_hash"] == row["text_hash"] else None

        # One readback for the page: its exact points, plus any delivered
        # vector whose text is unchanged (metadata-only updates skip inference).
        wanted = {row["point"] for row in rows} | {
            reuse for row in rows if (reuse := reusable(row))
        }
        existing = store.retrieve(sorted(wanted), vectors=True)
        for row in rows:
            reuse = reusable(row)
            candidate = existing.get(row["point"]) or (
                existing.get(reuse) if reuse else None
            )
            if (
                candidate
                and candidate["payload"].get("textHash") == row["text_hash"]
                and candidate["payload"].get("model") == self.manifest.generation
                and candidate.get("vector")
            ):
                points.append(
                    {
                        "id": row["point"],
                        "vector": candidate["vector"],
                        "payload": self.payload(row),
                    }
                )
            else:
                infer_rows.append(row)
        if infer_rows:
            vectors = encoder.documents([row["searchable"] for row in infer_rows])
            if len(vectors) != len(infer_rows):
                raise ValueError("Embedding count mismatch")
            points.extend(
                {"id": row["point"], "vector": embedding, "payload": self.payload(row)}
                for row, embedding in zip(infer_rows, vectors, strict=True)
            )
        # Ambiguous failures leave work pending; immutable IDs fence late requests.
        store.upsert(points)
        acknowledged = 0
        with self.db:
            for row in rows:
                changed = self.db.execute(
                    "UPDATE posts SET pending=0,delivered=point,delivered_hash=text_hash,error=NULL WHERE id=? AND point=?",
                    (row["id"], row["point"]),
                ).rowcount
                acknowledged += changed
                if row["delivered"] and row["delivered"] != row["point"]:
                    self.db.execute(
                        "INSERT OR IGNORE INTO gc VALUES(?,?)",
                        (row["delivered"], row["id"]),
                    )
        self.collect(store, limit)
        return acknowledged

    def collect(self, store: VectorStore, limit: int = PAGE) -> int:
        rows = self.db.execute(
            """SELECT gc.point FROM gc LEFT JOIN posts ON posts.id=gc.post_id
          WHERE posts.id IS NULL OR (posts.pending=0 AND posts.delivered=posts.point AND gc.point!=posts.point)
          ORDER BY gc.point LIMIT ?""",
            (limit,),
        ).fetchall()
        ids = [row[0] for row in rows]
        if ids:
            store.delete(ids)
            with self.db:
                self.db.executemany(
                    "DELETE FROM gc WHERE point=?", [(point,) for point in ids]
                )
        return len(ids)

    def reconcile(self, store: VectorStore, limit: int = PAGE) -> int:
        """Bounded cyclic point readback plus bounded orphan scroll; persists progress."""
        self.ensure_collection(store)
        after = self.meta("reconcile_after") or ""
        rows = self.db.execute(
            f"SELECT {DELIVERY_FIELDS} FROM posts WHERE id>? ORDER BY id LIMIT ?",
            (after, limit),
        ).fetchall()
        found = store.retrieve([row["point"] for row in rows]) if rows else {}
        missing = 0
        with self.db:
            for row in rows:
                candidate = found.get(row["point"])
                if not candidate or candidate["payload"] != self.payload(row):
                    self.db.execute(
                        "UPDATE posts SET pending=1,error='reconcile_missing' WHERE id=? AND point=?",
                        (row["id"], row["point"]),
                    )
                    missing += 1
            self.set_meta("reconcile_after", rows[-1]["id"] if rows else "")
            if not rows:
                self.set_meta("reconciled_ms", str(now_ms()))
        points, offset = store.scroll(self.meta("scroll_after") or None, limit)
        with self.db:
            for point in points:
                post_id = point["payload"].get("tweetId", "")
                current = self.db.execute(
                    "SELECT point FROM posts WHERE id=?", (post_id,)
                ).fetchone()
                if not current or current[0] != point["id"]:
                    self.db.execute(
                        "INSERT OR IGNORE INTO gc VALUES(?,?)", (point["id"], post_id)
                    )
            self.set_meta("scroll_after", offset or "")
        self.collect(store, limit)
        return missing

    def backup(self, target: Path) -> None:
        if target.exists():
            raise ValueError("Backup target already exists")
        with sqlite3.connect(target) as backup:
            self.db.backup(backup, pages=256)
        os.chmod(target, 0o600)


def re_id(value: str) -> bool:
    return (
        1 <= len(value) <= 20
        and value.isascii()
        and value.isdecimal()
        and value[0] != "0"
        and int(value) <= 18446744073709551615
    )
