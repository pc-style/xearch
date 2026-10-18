"""Opt-in isolated Qdrant 1.19.2 integration; never use production port 6333."""

import os
from pathlib import Path
import tempfile
import unittest
import uuid
from semantic.contracts import Manifest, POLICY, Request
from semantic.projection import Projection
from semantic.qdrant import Qdrant
from test_projection import FakeEncoder


@unittest.skipUnless(
    os.environ.get("QDRANT_TEST_URL"), "set an isolated QDRANT_TEST_URL"
)
class QdrantIntegration(unittest.TestCase):
    def test_actual_filter_indexes_reuse_recovery_and_readback(self):
        url = os.environ["QDRANT_TEST_URL"]
        if url.endswith(":6333"):
            self.fail("Production Qdrant port is forbidden for integration tests")
        manifest = Manifest(
            {"policy": POLICY, "artifacts": {}}, uuid.uuid4().hex * 2, Path("unused")
        )
        store = Qdrant(manifest, os.environ["QDRANT_TEST_KEY"], url=url)
        with tempfile.TemporaryDirectory() as tmp:
            projection = Projection(Path(tmp) / "state.sqlite", manifest)
            try:
                projection.ensure_collection(store)
                with projection.db:
                    projection.db.execute(
                        "INSERT INTO captures(sha,path) VALUES(?,?)",
                        ("a" * 64, "unused"),
                    )
                event = {
                    "type": "post",
                    "version": 1,
                    "ordinal": 0,
                    "observedAtMs": 100,
                    "searchable": "durable jobs",
                    "post": {
                        "tweetId": "1",
                        "text": "durable jobs",
                        "author": "alice",
                        "createdAt": 50,
                    },
                }
                receipt = {
                    "type": "receipt",
                    "version": 1,
                    "accepted": 1,
                    "rejected": 0,
                    "normalizer": "search-ingest-v1",
                    "textPolicy": "post-searchable-v1",
                }
                projection.publish(
                    "a" * 64, projection.stage("a" * 64, iter([event, receipt]))
                )
                encoder = FakeEncoder()
                self.assertEqual(projection.deliver(encoder, store), 1)
                self.assertEqual(projection.reconcile(store), 0)
                self.assertEqual(
                    len(
                        store.search(
                            encoder.query("x"),
                            Request("x", author="alice", since_ms=50, until_ms=51),
                            10,
                        )
                    ),
                    1,
                )
                self.assertEqual(
                    store.search(encoder.query("x"), Request("x", author="bob"), 10), []
                )
                self.assertEqual(
                    store.search(encoder.query("x"), Request("x", since_ms=51), 10), []
                )
                old_marker = store.ensure()
                store.client.delete_collection(
                    store.name
                )  # Only this random isolated test collection.
                projection.ensure_collection(store)
                self.assertNotEqual(old_marker, store.ensure())
                self.assertEqual(
                    projection.db.execute("SELECT pending FROM posts").fetchone()[0], 1
                )
                self.assertEqual(projection.deliver(encoder, store), 1)
            finally:
                projection.close()
                store.client.delete_collection(store.name)
