"""Production-only allowlisted metrics. No source strings or exception messages."""

import json
import os
import queue
import threading
import urllib.request

EVENTS = {
    "semantic.index_batch",
    "semantic.search",
    "semantic.error",
    "semantic.heartbeat",
}
STAGES = {"ingest", "delivery", "reconcile", "query", "startup", "worker"}
METRICS = {
    "count",
    "durationMs",
    "embeddingMs",
    "retrievalMs",
    "pending",
    "posts",
    "queueLagMs",
    "coverage",
    "underfilled",
    "candidates",
    "failures",
}


class Telemetry:
    def __init__(self, generation: str):
        self.generation = generation
        self.key = os.environ.get("SEMANTIC_POSTHOG_KEY", "")
        self.enabled = (
            os.environ.get("SEMANTIC_ENV") == "production"
            and self.key.startswith("phc_")
            and os.environ.get("SEMANTIC_POSTHOG_HOST") == "https://eu.i.posthog.com"
        )
        self.queue = queue.Queue(maxsize=32)
        if self.enabled:
            threading.Thread(target=self._send, daemon=True).start()

    def event(self, event: str, stage: str, **metrics) -> dict:
        if event not in EVENTS or stage not in STAGES:
            raise ValueError("Unrecognized telemetry event")
        properties = {
            "model": "BAAI/bge-small-en-v1.5",
            "generation": self.generation,
            "stage": stage,
        }
        properties.update(
            {
                k: v
                for k, v in metrics.items()
                if k in METRICS and type(v) in (int, float, bool)
            }
        )
        data = {
            "event": event,
            "properties": properties,
            "distinct_id": "xearch-semantic-runtime",
        }
        if self.enabled:
            try:
                self.queue.put_nowait(data)
            except queue.Full:
                pass  # Observability failure never blocks serving or durable publication.
        return data

    def _send(self) -> None:
        while True:
            data = self.queue.get()
            try:
                body = json.dumps(
                    {"api_key": self.key, **data}, allow_nan=False
                ).encode()
                request = urllib.request.Request(
                    "https://eu.i.posthog.com/capture/",
                    body,
                    {"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    response.read(1024)
            except Exception:
                pass
            finally:
                self.queue.task_done()
