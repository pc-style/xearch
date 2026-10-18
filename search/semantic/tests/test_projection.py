import copy
import hashlib
from pathlib import Path
import random
import tempfile
import unittest

from semantic.contracts import Manifest, POLICY, Request, canonical
from semantic.projection import PAGE, Projection, counts, read_db
from semantic.service import Search
from semantic.telemetry import Telemetry


class FakeEncoder:
    def __init__(self):
        self.calls = []

    def documents(self, texts):
        self.calls.extend(texts)
        return [[1.0] + [0.0] * 383 for _ in texts]

    def query(self, text):
        return [1.0] + [0.0] * 383


class FakeStore:
    def __init__(self):
        self.points = {}
        self.marker = "first"
        self.available = True
        self.fail_ack = False
        self.delayed = None
        self.deleted = []
        self.before_write = None
        self.max_page = 0

    def ensure(self, create=False):
        if not self.available:
            if not create:
                raise ValueError("missing")
            self.marker += "reset"
            self.points.clear()
            self.available = True
        return self.marker

    def retrieve(self, ids, vectors=False):
        self.max_page = max(self.max_page, len(ids))
        return {i: copy.deepcopy(self.points[i]) for i in ids if i in self.points}

    def upsert(self, points):
        self.max_page = max(self.max_page, len(points))
        if self.before_write:
            action, self.before_write = self.before_write, None
            action()
        if self.delayed is not None:
            self.delayed.extend(copy.deepcopy(points))
            raise TimeoutError("ambiguous")
        self.points.update({p["id"]: copy.deepcopy(p) for p in points})
        if self.fail_ack:
            self.fail_ack = False
            raise TimeoutError("lost ack")

    def delete(self, ids):
        self.deleted.extend(ids)
        for point in ids:
            self.points.pop(point, None)

    def scroll(self, offset, limit):
        keys = sorted(k for k in self.points if not offset or k > offset)[:limit]
        return [copy.deepcopy(self.points[k]) for k in keys], keys[-1] if len(
            keys
        ) == limit else None

    def search(self, embedding, request, candidates):
        return [
            {**copy.deepcopy(p), "score": 0.9}
            for p in list(self.points.values())[:candidates]
        ]


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.manifest = Manifest(
            {"policy": POLICY, "artifacts": {}}, "a" * 64, self.root
        )
        self.path = self.root / "state.sqlite"
        self.projection = Projection(self.path, self.manifest)
        self.encoder, self.store = FakeEncoder(), FakeStore()
        self.search = Search(
            self.path,
            self.manifest,
            self.encoder,
            self.store,
            Telemetry(self.manifest.generation),
        )

    def tearDown(self):
        self.projection.close()
        self.temp.cleanup()

    def capture(self, sha, events):
        with self.projection.db:
            self.projection.db.execute(
                "INSERT OR IGNORE INTO captures(sha,path) VALUES(?,?)", (sha, "unused")
            )
        receipt = self.projection.stage(
            sha,
            iter(
                events
                + [
                    {
                        "type": "receipt",
                        "version": 1,
                        "accepted": len(events),
                        "rejected": 0,
                        "normalizer": "search-ingest-v1",
                        "textPolicy": "post-searchable-v1",
                    }
                ]
            ),
        )
        self.projection.publish(sha, receipt)

    @staticmethod
    def event(text="hello", time=100, ordinal=0, post_id="1", **metadata):
        return {
            "type": "post",
            "version": 1,
            "ordinal": ordinal,
            "observedAtMs": time,
            "searchable": text,
            "post": {
                "tweetId": post_id,
                "author": "alice",
                "text": text,
                "createdAt": 10,
                **metadata,
            },
        }

    def row(self, post_id="1"):
        return self.projection.db.execute(
            "SELECT * FROM posts WHERE id=?", (post_id,)
        ).fetchone()

    def test_random_replay_order_and_legacy_never_displaces_timestamp(self):
        inputs = [
            (str(i) * 64, self.event(text=str(i), time=None if i == 9 else i))
            for i in range(1, 10)
        ]
        random.Random(7).shuffle(inputs)
        for sha, event in inputs:
            self.capture(sha, [event])
        self.assertEqual(self.row()["searchable"], "8")
        self.assertEqual(counts(self.projection.db)["posts"], 1)

    def test_sha_and_ordinal_break_equal_timestamp_ties(self):
        self.capture(
            "b" * 64, [self.event("zero", ordinal=0), self.event("one", ordinal=1)]
        )
        self.capture("a" * 64, [self.event("older")])
        self.assertEqual(self.row()["searchable"], "one")

    def test_partial_eof_keeps_staging_private_and_restart_retryable(self):
        sha = "b" * 64
        with self.projection.db:
            self.projection.db.execute(
                "INSERT INTO captures(sha,path,status) VALUES(?,?,'staging')",
                (sha, "unused"),
            )
        with self.assertRaises(ValueError):
            self.projection.stage(
                sha,
                (self.event(ordinal=i, post_id=str(i + 1)) for i in range(PAGE + 1)),
            )
        self.assertEqual(counts(self.projection.db)["posts"], 0)
        self.assertEqual(counts(self.projection.db)["staged"], PAGE)
        self.projection.close()
        self.projection = Projection(self.path, self.manifest)
        self.assertEqual(
            self.projection.db.execute("SELECT status FROM captures").fetchone()[0],
            "failed",
        )

    def test_receipt_must_be_terminal_and_correct(self):
        good = {
            "type": "receipt",
            "version": 1,
            "accepted": 0,
            "rejected": 0,
            "normalizer": "search-ingest-v1",
            "textPolicy": "post-searchable-v1",
        }
        for events in (
            [good, self.event()],
            [{**good, "accepted": 1}],
            [{**good, "normalizer": "other"}],
        ):
            with self.assertRaises(ValueError):
                self.projection.stage("a" * 64, iter(events))
        self.assertEqual(counts(self.projection.db)["posts"], 0)

    def test_metadata_reuses_vector_without_inference(self):
        self.capture("a" * 64, [self.event()])
        self.projection.deliver(self.encoder, self.store)
        first = self.row()["point"]
        self.capture("b" * 64, [self.event(time=101, likes=5)])
        self.projection.deliver(self.encoder, self.store)
        self.assertEqual(self.encoder.calls, ["hello"])
        self.assertNotEqual(first, self.row()["point"])
        self.assertEqual(self.store.deleted, [first])
        self.assertEqual(
            self.search.search(Request("x", 1))["hits"][0]["post"]["likes"], 5
        )

    def test_text_edit_and_lost_ack_retry_reuses_exact_vector(self):
        self.capture("a" * 64, [self.event()])
        self.store.fail_ack = True
        with self.assertRaises(TimeoutError):
            self.projection.deliver(self.encoder, self.store)
        self.assertEqual(self.row()["pending"], 1)
        self.projection.deliver(self.encoder, self.store)
        self.assertEqual(self.encoder.calls, ["hello"])
        self.capture("b" * 64, [self.event("edited", 101)])
        self.projection.deliver(self.encoder, self.store)
        self.assertEqual(self.encoder.calls, ["hello", "edited"])

    def test_ack_cannot_clear_newer_revision_during_delivery(self):
        self.capture("a" * 64, [self.event()])
        old = self.row()["point"]
        self.store.before_write = lambda: self.capture(
            "b" * 64, [self.event("new", 101)]
        )
        self.assertEqual(self.projection.deliver(self.encoder, self.store), 0)
        self.assertEqual(self.row()["pending"], 1)
        self.assertIn(old, self.store.points)
        self.assertEqual(self.search.search(Request("x", 1))["hits"], [])
        self.projection.deliver(self.encoder, self.store)
        self.assertNotIn(old, self.store.points)

    def test_ambiguous_late_old_write_cannot_overwrite_new_and_gc_is_exact(self):
        self.capture("a" * 64, [self.event()])
        old = self.row()["point"]
        self.store.delayed = []
        with self.assertRaises(TimeoutError):
            self.projection.deliver(self.encoder, self.store)
        delayed, self.store.delayed = self.store.delayed, None
        self.capture("b" * 64, [self.event("new", 101)])
        self.projection.deliver(self.encoder, self.store)
        current = self.row()["point"]
        self.store.upsert(delayed)
        result = self.search.search(Request("x", 2))
        self.assertEqual([hit["post"]["text"] for hit in result["hits"]], ["new"])
        self.assertTrue(result["underfilled"])
        self.projection.reconcile(self.store)
        self.assertNotIn(old, self.store.points)
        self.assertIn(current, self.store.points)
        self.assertNotIn(current, self.store.deleted)

    def test_collection_loss_and_same_marker_snapshot_restore_requeue(self):
        self.capture("a" * 64, [self.event()])
        self.projection.deliver(self.encoder, self.store)
        self.store.available = False
        with self.assertRaises(ValueError):
            self.search.health()
        self.projection.ensure_collection(self.store)
        self.assertEqual(self.row()["pending"], 1)
        self.projection.deliver(self.encoder, self.store)
        self.store.points.clear()  # Restore lost data but preserved collection marker.
        self.assertEqual(self.projection.reconcile(self.store), 1)
        self.assertEqual(self.row()["pending"], 1)
        self.projection.deliver(self.encoder, self.store)
        self.assertEqual(len(self.store.points), 1)

    def test_manifest_mismatch_and_writer_exclusion(self):
        with self.assertRaises(ValueError):
            Projection(self.path, self.manifest)
        other = Manifest(self.manifest.data, "b" * 64, self.root)
        with self.assertRaises(ValueError):
            read_db(self.path, other.generation)
        self.projection.close()
        with self.assertRaises(ValueError):
            Projection(self.path, other)
        self.projection = Projection(self.path, self.manifest)

    def test_delivery_and_reconciliation_pages_bound_memory(self):
        self.capture(
            "a" * 64,
            [self.event(ordinal=i, post_id=str(i + 1)) for i in range(PAGE * 3 + 1)],
        )
        self.assertEqual(self.projection.deliver(self.encoder, self.store), PAGE)
        for _ in range(6):
            self.projection.reconcile(self.store)
            self.projection.deliver(self.encoder, self.store)
        self.assertEqual(counts(self.projection.db)["pending"], 0)
        self.assertLessEqual(self.store.max_page, PAGE)

    def test_read_only_snapshot_and_backup_restore(self):
        self.capture("a" * 64, [self.event()])
        db = read_db(self.path, self.manifest.generation)
        with self.assertRaises(Exception):
            db.execute("DELETE FROM posts")
        db.close()
        target = self.root / "backup.sqlite"
        self.projection.backup(target)
        restored = read_db(target, self.manifest.generation)
        self.assertEqual(counts(restored)["posts"], 1)
        restored.close()

    def test_discovery_excludes_receipts_and_nonhash_files(self):
        archive = self.root / "archive"
        archive.mkdir()
        for name in [
            "a" * 64 + ".json",
            "b" * 64 + ".receipt.json",
            "anything.json",
            "C" * 64 + ".json",
        ]:
            (archive / name).write_text("{}")
        self.assertEqual(list(self.projection.discover(archive)), [1])
        self.assertEqual(
            self.projection.db.execute("SELECT count(*) FROM captures").fetchone()[0], 1
        )

    def test_hash_mismatch_is_visible_retryable_failure(self):
        source = self.root / ("a" * 64 + ".json")
        source.write_text("{}")
        self.assertFalse(self.projection.ingest("a" * 64, source, Path("unused")))
        state = self.projection.db.execute(
            "SELECT status,error FROM captures"
        ).fetchone()
        self.assertEqual(tuple(state), ("failed", "capture_failed"))

    def test_failed_capture_backs_off_without_starving_others(self):
        source = self.root / ("a" * 64 + ".json")
        source.write_text("{}")
        self.assertFalse(self.projection.ingest("a" * 64, source, Path("unused")))
        # Just failed: not offered again yet, and never ahead of new work.
        self.assertIsNone(self.projection.next_capture())
        with self.projection.db:
            self.projection.db.execute(
                "INSERT INTO captures(sha,path) VALUES(?,?)", ("b" * 64, "unused")
            )
        self.assertEqual(self.projection.next_capture()["sha"], "b" * 64)
        with self.projection.db:
            self.projection.db.execute("DELETE FROM captures WHERE sha=?", ("b" * 64,))
            # A minute after its first failure it is retried.
            self.projection.db.execute("UPDATE captures SET attempted_ms=attempted_ms-60000")
        self.assertEqual(self.projection.next_capture()["sha"], "a" * 64)
        with self.projection.db:
            self.projection.db.execute("UPDATE captures SET attempts=20")
        self.assertIsNone(self.projection.next_capture())
        with self.projection.db:
            # The wait never grows past an hour.
            self.projection.db.execute("UPDATE captures SET attempted_ms=attempted_ms-3540000")
        self.assertEqual(self.projection.next_capture()["sha"], "a" * 64)

    def test_export_process_partial_and_nonzero_receipts_do_not_publish(self):
        source = self.root / "capture.json"
        source.write_bytes(b"raw immutable source")
        sha = hashlib.sha256(source.read_bytes()).hexdigest()
        exporter = self.root / "exporter"
        event = canonical(self.event())
        receipt = canonical(
            {
                "type": "receipt",
                "version": 1,
                "accepted": 1,
                "rejected": 0,
                "normalizer": "search-ingest-v1",
                "textPolicy": "post-searchable-v1",
            }
        )
        for output, exit_code in (
            (event + "\n", 0),
            (event + "\n" + receipt + "\n", 1),
            (event, 0),
        ):
            exporter.write_text(
                "#!/usr/bin/env python3\nimport sys\nsys.stdout.write("
                + repr(output)
                + ")\nsys.exit("
                + str(exit_code)
                + ")\n"
            )
            exporter.chmod(0o700)
            self.assertFalse(self.projection.ingest(sha, source, exporter))
            self.assertEqual(counts(self.projection.db)["posts"], 0)
        exporter.write_text(
            "#!/usr/bin/env python3\nprint("
            + repr(event)
            + ")\nprint("
            + repr(receipt)
            + ")\n"
        )
        exporter.chmod(0o700)
        self.assertTrue(self.projection.ingest(sha, source, exporter))
        self.assertEqual(counts(self.projection.db)["posts"], 1)
        self.assertFalse(self.projection.ingest(sha, source, exporter))
