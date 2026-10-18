"""Frozen generation and strict private search transport."""

from dataclasses import dataclass
import hashlib
import hmac
import json
import math
from pathlib import Path
import re
from typing import Protocol

MODEL = "BAAI/bge-small-en-v1.5"
PREFIX = "Represent this sentence for searching relevant passages: "
POLICY = {
    "version": 1,
    "model": MODEL,
    "dimensions": 384,
    "queryPrefix": PREFIX,
    "normalization": "l2",
    "pooling": "cls",
    "truncation": 512,
    "normalizer": "search-ingest-v1",
    "textPolicy": "post-searchable-v1",
    "fastembed": "0.9.0",
    "onnxruntime": "1.31.0",
    "qdrantClient": "1.19.1",
}
SHA = re.compile(r"[0-9a-f]{64}")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


@dataclass(frozen=True)
class Manifest:
    data: dict
    generation: str
    root: Path

    @classmethod
    def load(cls, path: Path, verify: bool = True) -> "Manifest":
        data = json.loads(path.read_text())
        if set(data) != {"policy", "artifacts"} or canonical(
            data["policy"]
        ) != canonical(POLICY):
            raise ValueError("Unsupported model policy")
        files = data["artifacts"]
        required = {
            "model_optimized.onnx",
            "tokenizer.json",
            "tokenizer_config.json",
            "config.json",
            "special_tokens_map.json",
        }
        if not isinstance(files, dict) or not required.issubset(files):
            raise ValueError("Incomplete model manifest")
        for name, sha in files.items():
            if (
                not isinstance(name, str)
                or Path(name).is_absolute()
                or ".." in Path(name).parts
            ):
                raise ValueError("Invalid artifact path")
            if not isinstance(sha, str) or not SHA.fullmatch(sha):
                raise ValueError("Invalid artifact digest")
            if verify and digest(path.parent / name) != sha:
                raise ValueError("Model artifact mismatch")
        generation = hashlib.sha256(canonical(data).encode()).hexdigest()
        return cls(data, generation, path.parent)

    @property
    def collection(self) -> str:
        return "xearch_semantic_" + self.generation


@dataclass(frozen=True)
class Request:
    text: str
    limit: int = 20
    author: str | None = None
    since_ms: int | None = None
    until_ms: int | None = None

    @classmethod
    def parse(cls, data: object) -> "Request":
        if not isinstance(data, dict) or set(data) - {
            "text",
            "limit",
            "author",
            "sinceMs",
            "untilMs",
        }:
            raise ValueError("Invalid request fields")
        text = data.get("text")
        if not isinstance(text, str) or not text.strip() or len(text.encode()) > 16384:
            raise ValueError("Use nonempty text up to 16384 bytes")
        limit = data.get("limit", 20)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Use limit 1..100")
        author = data.get("author")
        if author is not None:
            if not isinstance(author, str) or not re.fullmatch(
                r"@?[A-Za-z0-9_]{1,15}", author
            ):
                raise ValueError("Invalid author")
            author = author.lstrip("@").lower()
        times = []
        for key in ("sinceMs", "untilMs"):
            value = data.get(key)
            if value is not None and (
                type(value) is not int or not 0 <= value <= 9223372036854775807
            ):
                raise ValueError("Invalid timestamp")
            times.append(value)
        since, until = times
        if since is not None and until is not None and since >= until:
            raise ValueError("Invalid date range")
        return cls(text.strip(), limit, author, since, until)


def credential(value: str) -> str:
    if (
        len(value) < 32
        or len(set(value)) < 12
        or not value.isascii()
        or any(c.isspace() for c in value)
    ):
        raise ValueError("Missing or weak credential")
    return value


def authorized(header: str | None, token: str) -> bool:
    return hmac.compare_digest((header or "").encode(), ("Bearer " + token).encode())


def vector(values: list[float]) -> list[float]:
    if len(values) != 384 or any(not math.isfinite(v) for v in values):
        raise ValueError("Invalid embedding")
    norm = math.sqrt(sum(v * v for v in values))
    if norm == 0:
        raise ValueError("Zero embedding")
    return [v / norm for v in values]


class Encoder(Protocol):
    def documents(self, texts: list[str]) -> list[list[float]]: ...
    def query(self, text: str) -> list[float]: ...


class VectorStore(Protocol):
    def ensure(self, create: bool = False) -> str: ...
    def retrieve(self, ids: list[str], vectors: bool = False) -> dict[str, dict]: ...
    def upsert(self, points: list[dict]) -> None: ...
    def delete(self, ids: list[str]) -> None: ...
    def scroll(
        self, offset: str | None, limit: int
    ) -> tuple[list[dict], str | None]: ...
    def search(
        self, embedding: list[float], request: Request, candidates: int
    ) -> list[dict]: ...
