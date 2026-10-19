#!/usr/bin/env python3
"""Run a semantic command using an owner-only env without printing credentials."""

import argparse
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env", type=Path, default=Path.home() / "xearch-data/semantic/semantic.env"
    )
    parser.add_argument(
        "--release", type=Path, default=Path.home() / "xearch-semantic/current"
    )
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.env.stat().st_mode & 0o077:
        raise ValueError("Environment must be owner-only")
    env = dict(os.environ)
    for line in args.env.read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            env[key] = value
    env.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "OMP_NUM_THREADS": "1",
        }
    )
    command = args.args
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        command = ["status"]
    return subprocess.run(
        [
            str(args.release / "runtime/.venv/bin/python"),
            "-m",
            "semantic.service",
            *command,
        ],
        cwd=args.release / "runtime",
        env=env,
    ).returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("Semantic command failed; inspect configuration privately.")
        raise SystemExit(1) from None
