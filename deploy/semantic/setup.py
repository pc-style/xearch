#!/usr/bin/env python3
"""Explicit provisioning only. Never start services, switch current, or overwrite env."""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = "1.19.2"
ARCHIVE_SHA = "34a788a09a4cb278b5c6d2af96d9a6db30c8c7e88ae3550455f7a4d425bb8d4b"
URL = f"https://github.com/qdrant/qdrant/releases/download/v{VERSION}/qdrant-x86_64-unknown-linux-gnu.tar.gz"
REPO = Path(__file__).resolve().parents[2]


def run(*args):
    subprocess.run(args, check=True)


def write_new(path, content):
    if path.exists():
        return False
    with path.open("x") as out:
        out.write(content)
    path.chmod(0o600)
    return True


def env_read(path):
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        if key in result:
            raise ValueError("Duplicate environment key")
        result[key] = value
    return result


def main():
    os.umask(0o077)
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("This binary pin requires Linux x86_64")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--release",
        type=Path,
        required=True,
        help="New immutable release directory; never current",
    )
    parser.add_argument(
        "--data", type=Path, default=Path.home() / "xearch-data/semantic"
    )
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument(
        "--model-dir",
        type=Path,
        help="Existing frozen model to reuse; default DATA/models/bge-small-v1",
    )
    args = parser.parse_args()
    if (
        not args.archive.is_dir()
        or args.release.exists()
        or args.release.name == "current"
    ):
        raise ValueError("Use an existing archive and a new release directory")
    # Paths are written to simple systemd env files; reject ambiguous syntax.
    for path in (args.release, args.data, args.archive):
        if (
            not path.is_absolute()
            or any(c.isspace() for c in str(path))
            or '"' in str(path)
            or "'" in str(path)
        ):
            raise ValueError("Use absolute paths without whitespace or quotes")
    for child in (
        "logs",
        "models",
        "generations",
        "qdrant/storage",
        "qdrant/snapshots",
        "backups",
    ):
        (args.data / child).mkdir(parents=True, exist_ok=True, mode=0o700)
    config = args.data / "qdrant.yaml"
    expected = (REPO / "deploy/semantic/qdrant.yaml").read_text()
    if config.exists() and config.read_text() != expected:
        raise ValueError(
            "Existing Qdrant config differs; review it without overwriting"
        )
    write_new(config, expected)
    qenv_path = args.data / "qdrant.env"
    write_new(
        qenv_path,
        "QDRANT__SERVICE__API_KEY="
        + secrets.token_urlsafe(48)
        + "\n"
        + f"QDRANT__STORAGE__STORAGE_PATH={args.data}/qdrant/storage\n"
        + f"QDRANT__STORAGE__SNAPSHOTS_PATH={args.data}/qdrant/snapshots\n",
    )
    qenv = env_read(qenv_path)
    if qenv_path.stat().st_mode & 0o077:
        raise ValueError("Qdrant environment must be owner-only")
    args.release.mkdir(parents=True, mode=0o700)
    runtime = args.release / "runtime"
    shutil.copytree(
        REPO / "search/semantic",
        runtime,
        ignore=shutil.ignore_patterns(
            ".venv", "__pycache__", "*.pyc", "model", "*.sqlite*"
        ),
    )
    binary_dir = args.release / "bin"
    binary_dir.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix="xearch-semantic-build-") as tmp:
        temp = Path(tmp)
        download = temp / "qdrant.tar.gz"
        urllib.request.urlretrieve(URL, download)
        with download.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != ARCHIVE_SHA:
                raise ValueError("Qdrant release checksum mismatch")
        with tarfile.open(download) as archive:
            archive.extractall(temp / "qdrant", filter="data")
        qbinary = temp / "qdrant/qdrant"
        shutil.copyfile(qbinary, binary_dir / "qdrant")
        (binary_dir / "qdrant").chmod(0o500)
        run(
            "cargo",
            "build",
            "--locked",
            "--release",
            "--manifest-path",
            str(REPO / "search/Cargo.toml"),
            "--target-dir",
            str(temp / "target"),
            "-p",
            "xearch-export",
        )
        shutil.copyfile(
            temp / "target/release/xearch-export", binary_dir / "xearch-export"
        )
        (binary_dir / "xearch-export").chmod(0o500)
    run("uv", "sync", "--frozen", "--no-dev", "--project", str(runtime))
    python = str(runtime / ".venv/bin/python")
    model_dir = args.model_dir or args.data / "models/bge-small-v1"
    run(python, "-m", "semantic.service", "warmup", "--model-dir", str(model_dir))
    manifest = json.loads((model_dir / "manifest.json").read_text())
    generation = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    env_path = args.data / "semantic.env"
    content = f"SEMANTIC_MODEL_DIR={model_dir}\nSEMANTIC_STATE={args.data}/generations/{generation}.sqlite\n"
    content += f"SEMANTIC_ARCHIVE={args.archive}\nSEMANTIC_EXPORTER={args.release}/bin/xearch-export\n"
    content += (
        "QDRANT__SERVICE__API_KEY=" + qenv.get("QDRANT__SERVICE__API_KEY", "") + "\n"
    )
    content += (
        "SEMANTIC_READ_TOKEN="
        + secrets.token_urlsafe(48)
        + "\nSEMANTIC_ENV=development\n"
    )
    content += "# Opt in only after project 283153 EU public key is configured:\n# SEMANTIC_POSTHOG_KEY=\n# SEMANTIC_POSTHOG_HOST=https://eu.i.posthog.com\n"
    if not write_new(env_path, content):
        existing = env_read(env_path)
        if existing.get("SEMANTIC_MODEL_DIR") != str(model_dir) or existing.get(
            "QDRANT__SERVICE__API_KEY"
        ) != qenv.get("QDRANT__SERVICE__API_KEY"):
            raise ValueError(
                "Existing semantic env differs; prepare a separate generation config for review"
            )
    if env_path.stat().st_mode & 0o077:
        raise ValueError("Semantic environment must be owner-only")
    # Validate without displaying credentials; use this frozen runtime's contract validator.
    code = "from semantic.contracts import credential; import os; a=credential(os.environ['QDRANT__SERVICE__API_KEY']); b=credential(os.environ['SEMANTIC_READ_TOKEN']); assert a!=b"
    subprocess.run(
        [python, "-c", code], check=True, env={**os.environ, **env_read(env_path)}
    )
    (args.release / "release.json").write_text(
        json.dumps(
            {
                "qdrantVersion": VERSION,
                "qdrantArchiveSha256": ARCHIVE_SHA,
                "generation": generation,
                "qdrantBinarySha256": hashlib.sha256(
                    (binary_dir / "qdrant").read_bytes()
                ).hexdigest(),
            },
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "preparedRelease": str(args.release),
                "generation": generation,
                "servicesStarted": False,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(
            "Setup failed; existing files were preserved. Inspect prerequisites and partial new release privately."
        )
        raise SystemExit(1) from None
