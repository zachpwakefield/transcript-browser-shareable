#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v R >/dev/null 2>&1 || { echo "R is required; install the pinned R release first." >&2; exit 1; }
exec R CMD INSTALL "$ROOT/spliceimpactr/SpliceImpactR"
