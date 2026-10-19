import hashlib
import http.client
from http.server import HTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from semantic.contracts import (
    Manifest,
    POLICY,
    PREFIX,
    Request,
    authorized,
    canonical,
    credential,
)
from semantic.service import display_post, handler, strict_json
from semantic.telemetry import Telemetry

TOKEN = "0123456789abcdef" * 4


class DummySearch:
    def __init__(self):
        self.telemetry = Telemetry("a" * 64)
        self.fail = False

    def health(self):
        return {"ready": True, "pending": 1, "posts": 10}

    def search(self, request):
        if self.fail:
            raise RuntimeError("PRIVATE QUERY EMAIL TOKEN")
        return {"hits": [], "underfilled": True, "author": request.author}


class ServiceTests(unittest.TestCase):
    def test_display_text_bounds_count_codepoints_without_splitting_characters(self):
        for text, expected in (
            ("a" * 6000, "a" * 6000),
            ("a" * 6001, "a" * 6000),
            ("😀" * 6000, "😀" * 6000),
            ("😀" * 6001, "😀" * 6000),
            ("a" * 5999 + "😀", "a" * 5999 + "😀"),
        ):
            with self.subTest(length=len(text)):
                post = {"text": text, "links": []}
                self.assertEqual(display_post(post)["text"], expected)
                self.assertEqual(post["text"], text)

    def test_strict_fields_and_types(self):
        for value in (
            {},
            {"text": " "},
            {"text": "ok", "query": "x"},
            {"text": "x", "limit": True},
            {"text": "x", "limit": 0},
            {"text": "x", "limit": 101},
            {"text": "x", "author": "a b"},
            {"text": "x", "sinceMs": True},
            {"text": "x", "untilMs": -1},
            {"text": "x", "sinceMs": 10, "untilMs": 10},
            {"text": "x", "sinceMs": 1.5},
        ):
            with self.assertRaises(ValueError):
                Request.parse(value)
        self.assertEqual(
            Request.parse({"text": " x ", "author": "@Alice", "limit": 100}).author,
            "alice",
        )
        for raw in (b'{"text":"x","text":"y"}', b'{"text":NaN}', b"[]garbage"):
            with self.assertRaises(ValueError):
                strict_json(raw)

    def test_credentials(self):
        for token in ("", "a" * 64, "short", TOKEN + "\n"):
            with self.assertRaises(ValueError):
                credential(token)
        self.assertEqual(credential(TOKEN), TOKEN)
        self.assertFalse(authorized(None, TOKEN))
        self.assertFalse(authorized("Bearer wrong", TOKEN))
        self.assertTrue(authorized("Bearer " + TOKEN, TOKEN))

    def test_model_manifest_hash_mismatch_and_policy(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            files = {}
            for name in (
                "model_optimized.onnx",
                "tokenizer.json",
                "tokenizer_config.json",
                "config.json",
                "special_tokens_map.json",
            ):
                (path / name).write_bytes(b"artifact")
                files[name] = hashlib.sha256(b"artifact").hexdigest()
            manifest = path / "manifest.json"
            manifest.write_text(canonical({"policy": POLICY, "artifacts": files}))
            first = Manifest.load(manifest)
            self.assertEqual(first.data["policy"]["queryPrefix"], PREFIX)
            self.assertEqual(first.data["policy"]["truncation"], 512)
            (path / "tokenizer.json").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                Manifest.load(manifest)
            manifest.write_text(
                canonical({"policy": {**POLICY, "dimensions": 768}, "artifacts": files})
            )
            with self.assertRaises(ValueError):
                Manifest.load(manifest, verify=False)

    def test_telemetry_allowlist_and_nonproduction_disabled(self):
        with patch.dict(
            "os.environ",
            {
                "SEMANTIC_ENV": "development",
                "SEMANTIC_POSTHOG_KEY": "phc_private",
                "SEMANTIC_POSTHOG_HOST": "https://eu.i.posthog.com",
            },
            clear=True,
        ):
            telemetry = Telemetry("a" * 64)
            self.assertFalse(telemetry.enabled)
            event = telemetry.event(
                "semantic.error",
                "query",
                count=2,
                text="private",
                query="private",
                email="private",
                postId="private",
                author="private",
                token="private",
                error="private",
                durationMs="private",
            )
            self.assertNotIn("private", json.dumps(event))
            self.assertEqual(event["properties"]["count"], 2)
            with self.assertRaises(ValueError):
                telemetry.event("unknown", "query")
            with self.assertRaises(ValueError):
                telemetry.event("semantic.error", "private query")
            self.assertTrue(telemetry.queue.empty())
        with patch.dict(
            "os.environ",
            {
                "SEMANTIC_ENV": "production",
                "SEMANTIC_POSTHOG_KEY": "phc_private",
                "SEMANTIC_POSTHOG_HOST": "https://us.i.posthog.com",
            },
            clear=True,
        ):
            self.assertFalse(Telemetry("a" * 64).enabled)

    def test_http_auth_health_body_and_sanitized_errors(self):
        search = DummySearch()
        server = HTTPServer(("127.0.0.1", 0), handler(search, TOKEN))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:

            def request(method, path, body=None, auth=True, headers=None):
                connection = http.client.HTTPConnection(
                    *server.server_address, timeout=2
                )
                base = {"Content-Type": "application/json"}
                if auth:
                    base["Authorization"] = "Bearer " + TOKEN
                connection.request(method, path, body, {**base, **(headers or {})})
                response = connection.getresponse()
                status, data = response.status, response.read()
                connection.close()
                return status, json.loads(data)

            self.assertEqual(request("GET", "/health", auth=False)[0], 200)
            self.assertEqual(
                request("POST", "/semantic/v1/search", b'{"text":"x"}', auth=False)[0],
                401,
            )
            self.assertEqual(
                request("POST", "/semantic/v1/search", b'{"text":"x","limit":true}')[0],
                400,
            )
            self.assertEqual(
                request(
                    "POST",
                    "/semantic/v1/search",
                    b'{"text":"x"}',
                    headers={"Transfer-Encoding": "chunked"},
                )[0],
                400,
            )
            self.assertEqual(
                request(
                    "POST",
                    "/semantic/v1/search",
                    b'{"text":"x"}',
                    headers={"Content-Type": "text/plain"},
                )[0],
                400,
            )
            self.assertEqual(
                request("POST", "/semantic/v1/search", b'{"text":"x"}')[0], 200
            )
            self.assertEqual(request("POST", "/wrong", b"{}")[0], 404)
            self.assertEqual(
                request("PUT", "/semantic/v1/search", b"{}")[1],
                {"error": "invalid_request"},
            )
            search.fail = True
            status, data = request(
                "POST", "/semantic/v1/search", b'{"text":"secret query"}'
            )
            self.assertEqual(status, 503)
            self.assertEqual(data, {"error": "unavailable"})
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
