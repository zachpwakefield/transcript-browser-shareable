#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -eq 0 || "$1" == --* ]]; then
  cat >&2 <<'USAGE'
Usage: ./scripts/build_annotations.sh CACHE_DIR --reference-fasta PATH [builder options]

CACHE_DIR must contain the GENCODE v45 GTF/FASTA files and the seven RDS
protein-feature tables.  PATH is the local Ensembl GRCh38.p14 FASTA; its .fai
index must be next to it.  Both paths are intentionally supplied by the caller
so this script never embeds a workstation-specific location.
USAGE
  exit 2
fi
CACHE_DIR="$1"
shift

cd "$PROJECT_ROOT"
exec "${PYTHON:-python3}" -m backend.builder.build \
  --source "$CACHE_DIR" \
  --output-root "$PROJECT_ROOT/data/builds" \
  "$@"
