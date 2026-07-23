#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "${PYTHON:-python3}" "$ROOT/scripts/verify_publication.py"
