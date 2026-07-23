#!/usr/bin/env python3
"""Conservative pre-commit audit for a public source checkout."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache"}
PRIVATE_PATTERNS = [
    re.compile(r"(?<![A-Za-z0-9])/Users/[A-Za-z0-9._-]+/", re.I),
    re.compile(r"(?<![A-Za-z0-9])/home/[A-Za-z0-9._-]+/", re.I),
    re.compile(r"/usr/local/bin/", re.I),
    re.compile(r"/opt/homebrew/", re.I),
]
SECRET_PATTERN = re.compile(
    r"(?i)(?:api[_-]?key|client[_-]?secret|password|authorization)\s*[:=]\s*['\"][^'\"]+['\"]"
)
GENERATED_SUFFIXES = (".sqlite", ".sqlite-shm", ".sqlite-wal", ".fa", ".fai", ".gtf.gz", ".rds", ".RDS")


def iter_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        files.append(path)
    return files


def main() -> int:
    failures: list[str] = []
    for path in iter_files():
        relative = path.relative_to(ROOT).as_posix()
        # This checker necessarily contains the patterns it searches for.
        if relative == "scripts/verify_publication.py":
            continue
        if relative.startswith(("data/", "output/", "tmp/", "desktop_app/dist/")):
            if relative.startswith("data/builds/") and relative.endswith("README.md"):
                pass
            elif relative.startswith("data/") or relative.startswith(("output/", "tmp/", "desktop_app/dist/")):
                failures.append(f"generated/local artifact: {relative}")
                continue
        if relative.endswith(GENERATED_SUFFIXES):
            failures.append(f"generated scientific input: {relative}")
            continue
        if path.stat().st_size > 50 * 1024 * 1024:
            failures.append(f"unexpectedly large file: {relative}")
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            failures.append(f"cannot read {relative}: {error}")
            continue
        for pattern in PRIVATE_PATTERNS:
            if pattern.search(text):
                failures.append(f"private/local path pattern {pattern.pattern!r}: {relative}")
                break
        if SECRET_PATTERN.search(text):
            failures.append(f"credential-like assignment: {relative}")

    if failures:
        print("Publication audit failed:", file=sys.stderr)
        for item in sorted(set(failures)):
            print(f"- {item}", file=sys.stderr)
        return 1
    print("Publication audit passed: no private paths, credentials, or generated local artifacts found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
