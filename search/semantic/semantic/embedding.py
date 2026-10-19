"""One CPU ONNX thread per process; only warmup may download artifacts."""

from importlib.metadata import version
from pathlib import Path
import shutil
from .contracts import Manifest, MODEL, POLICY, PREFIX, canonical, digest, vector


class Embedding:
    def __init__(self, manifest: Manifest):
        for name, pinned in (("fastembed", "0.9.0"), ("onnxruntime", "1.31.0")):
            if version(name) != pinned:
                raise ValueError("Embedding dependency mismatch")
        from fastembed import TextEmbedding

        self.model = TextEmbedding(
            model_name=MODEL,
            threads=1,
            providers=["CPUExecutionProvider"],
            specific_model_path=str(manifest.root),
            local_files_only=True,
        )
        # This pinned implementation uses CLS + L2. Fix the declared token policy explicitly.
        self.model.model.tokenizer.enable_truncation(max_length=512, direction="right")

    def documents(self, texts: list[str]) -> list[list[float]]:
        return [
            vector(v.tolist())
            for v in self.model.embed(texts, batch_size=16, parallel=None)
        ]

    def query(self, text: str) -> list[float]:
        return self.documents([PREFIX + text])[0]


def warmup(destination: Path) -> Manifest:
    if destination.exists():
        return Manifest.load(destination / "manifest.json")
    from fastembed import TextEmbedding
    import tempfile

    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(
        dir=destination.parent, prefix=".model-warmup-"
    ) as temporary:
        temp = Path(temporary)
        model = TextEmbedding(
            model_name=MODEL,
            threads=1,
            providers=["CPUExecutionProvider"],
            cache_dir=str(temp / "cache"),
        )
        source = model.model._model_dir
        frozen = temp / "frozen"
        frozen.mkdir(mode=0o700)
        for name in (
            "model_optimized.onnx",
            "tokenizer.json",
            "tokenizer_config.json",
            "config.json",
            "special_tokens_map.json",
        ):
            shutil.copyfile(source / name, frozen / name)
        files = {p.name: digest(p) for p in frozen.iterdir() if p.is_file()}
        (frozen / "manifest.json").write_text(
            canonical({"policy": POLICY, "artifacts": files}) + "\n"
        )
        manifest = Manifest.load(frozen / "manifest.json")
        Embedding(manifest).query("warmup")
        for artifact in frozen.iterdir():
            artifact.chmod(0o400)
        frozen.rename(destination)
    return Manifest.load(destination / "manifest.json")
