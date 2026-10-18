"""Pinned Qdrant adapter: immutable points, exact-ID GC, wait=true writes."""

from importlib.metadata import version
import uuid
from .contracts import Manifest, Request, credential


class Qdrant:
    def __init__(
        self, manifest: Manifest, key: str, *, url: str = "http://127.0.0.1:6333"
    ):
        from urllib.parse import urlparse

        parsed = urlparse(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or parsed.username
            or parsed.password
            or parsed.path
        ):
            raise ValueError("Qdrant must use loopback")
        if version("qdrant-client") != "1.19.1":
            raise ValueError("Qdrant client mismatch")
        from qdrant_client import QdrantClient

        self.client = QdrantClient(
            url=url,
            api_key=credential(key),
            timeout=10,
            prefer_grpc=False,
            check_compatibility=False,
        )
        if self.client.info().version != "1.19.2":
            raise ValueError("Qdrant server mismatch")
        self.manifest, self.name = manifest, manifest.collection

    def ensure(self, create: bool = False) -> str:
        from qdrant_client import models as m

        if not self.client.collection_exists(self.name):
            if not create:
                raise ValueError("Collection missing")
            self.client.create_collection(
                self.name,
                vectors_config=m.VectorParams(
                    size=384, distance=m.Distance.COSINE, on_disk=True
                ),
                shard_number=1,
                on_disk_payload=True,
                hnsw_config=m.HnswConfigDiff(on_disk=True, max_indexing_threads=1),
                optimizers_config=m.OptimizersConfigDiff(
                    max_optimization_threads=1, default_segment_number=2
                ),
                metadata={
                    "generation": self.manifest.generation,
                    "instance": str(uuid.uuid4()),
                },
            )
        info = self.client.get_collection(self.name)
        config = info.config
        metadata = config.metadata or {}
        vectors = config.params.vectors
        if (
            metadata.get("generation") != self.manifest.generation
            or not metadata.get("instance")
            or not isinstance(vectors, m.VectorParams)
            or vectors.size != 384
            or vectors.distance != m.Distance.COSINE
            or vectors.on_disk is not True
            or config.params.on_disk_payload is not True
            or config.params.shard_number != 1
            or config.hnsw_config.on_disk is not True
            or config.hnsw_config.max_indexing_threads != 1
            or config.optimizer_config.max_optimization_threads != 1
        ):
            raise ValueError("Collection configuration mismatch")
        for name, schema in (
            ("author", m.KeywordIndexParams(type="keyword", on_disk=True)),
            ("createdAt", m.IntegerIndexParams(type="integer", on_disk=True)),
        ):
            if name not in info.payload_schema:
                if not create:
                    raise ValueError("Collection filter index missing")
                self.client.create_payload_index(
                    self.name, name, field_schema=schema, wait=True
                )
            elif info.payload_schema[name].data_type != schema.type:
                raise ValueError("Collection filter index mismatch")
        # Read back metadata even after creation; never accept the write response as identity.
        return self.client.get_collection(self.name).config.metadata["instance"]

    def retrieve(self, ids: list[str], vectors: bool = False) -> dict[str, dict]:
        if not ids:
            return {}
        return {
            str(p.id): {"id": str(p.id), "payload": p.payload or {}, "vector": p.vector}
            for p in self.client.retrieve(
                self.name, ids, with_payload=True, with_vectors=vectors
            )
        }

    def upsert(self, points: list[dict]) -> None:
        from qdrant_client.models import PointStruct

        self.client.upsert(self.name, [PointStruct(**p) for p in points], wait=True)

    def delete(self, ids: list[str]) -> None:
        from qdrant_client.models import PointIdsList

        self.client.delete(self.name, PointIdsList(points=ids), wait=True)

    def scroll(self, offset: str | None, limit: int) -> tuple[list[dict], str | None]:
        points, next_offset = self.client.scroll(
            self.name, offset=offset, limit=limit, with_payload=True, with_vectors=False
        )
        return [{"id": str(p.id), "payload": p.payload or {}} for p in points], str(
            next_offset
        ) if next_offset else None

    def search(
        self, embedding: list[float], request: Request, candidates: int
    ) -> list[dict]:
        from qdrant_client import models as m

        conditions = []
        if request.author:
            conditions.append(
                m.FieldCondition(key="author", match=m.MatchValue(value=request.author))
            )
        if request.since_ms is not None or request.until_ms is not None:
            conditions.append(
                m.FieldCondition(
                    key="createdAt",
                    range=m.Range(gte=request.since_ms, lt=request.until_ms),
                )
            )
        response = self.client.query_points(
            self.name,
            query=embedding,
            query_filter=m.Filter(must=conditions) if conditions else None,
            search_params=m.SearchParams(hnsw_ef=256),
            limit=candidates,
            with_payload=True,
            with_vectors=False,
        )
        return [
            {"id": str(p.id), "payload": p.payload or {}, "score": p.score}
            for p in response.points
        ]
