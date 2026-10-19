"""Start and remove a checksummed isolated Qdrant for the integration suite."""

import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import tarfile
import hashlib

with tempfile.TemporaryDirectory(prefix="semantic-qdrant-test-") as root:
    path = Path(root)
    url = "https://github.com/qdrant/qdrant/releases/download/v1.19.2/qdrant-x86_64-unknown-linux-gnu.tar.gz"
    archive = path / "qdrant.tar.gz"
    urllib.request.urlretrieve(url, archive)
    with archive.open("rb") as f:
        assert (
            hashlib.file_digest(f, "sha256").hexdigest()
            == "34a788a09a4cb278b5c6d2af96d9a6db30c8c7e88ae3550455f7a4d425bb8d4b"
        )
    with tarfile.open(archive) as f:
        f.extractall(path, filter="data")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        grpc = s.getsockname()[1]
    key = secrets.token_urlsafe(48)
    config = path / "config.yaml"
    config.write_text(
        f"log_level: WARN\ntelemetry_disabled: true\nservice:\n  host: 127.0.0.1\n  http_port: {port}\n  grpc_port: {grpc}\n  api_key: {key}\nstorage:\n  storage_path: {path}/storage\n  snapshots_path: {path}/snapshots\n"
    )
    with (path / "server.log").open("w") as log:
        server = subprocess.Popen(
            [str(path / "qdrant"), "--config-path", str(config)],
            cwd=path,
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/healthz", timeout=0.2
                    ).close()
                    break
                except Exception:
                    if server.poll() is not None:
                        raise RuntimeError("isolated qdrant exited")
                    time.sleep(0.1)
            repo = Path(__file__).resolve().parents[3]
            env = {
                **os.environ,
                "PYTHONPATH": str(repo / "search/semantic"),
                "QDRANT_TEST_URL": f"http://127.0.0.1:{port}",
                "QDRANT_TEST_KEY": key,
            }
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "search/semantic/tests",
                    "-v",
                ],
                env=env,
                cwd=repo,
            )
            sys.exit(result.returncode)
        finally:
            server.terminate()
            server.wait(timeout=10)
