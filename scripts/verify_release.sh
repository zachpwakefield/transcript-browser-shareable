#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
VENV_PYTHON="$ROOT/.venv/bin/python"
FULL_MANIFEST="$ROOT/data/builds/gencode_v45/manifest.json"
DETERMINISM_RECEIPT="$ROOT/data/builds/gencode_v45/determinism_receipt.json"

if ! command -v node >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm || true)"
  if [[ -n "$PNPM_BIN" ]]; then
    BUNDLED_NODE_BIN="$(CDPATH= cd -- "$(dirname -- "$PNPM_BIN")/../../node/bin" 2>/dev/null && pwd || true)"
    if [[ -x "$BUNDLED_NODE_BIN/node" ]]; then
      export PATH="$BUNDLED_NODE_BIN:$PATH"
    fi
  fi
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "Release gate requires the installed local runtime at $VENV_PYTHON" >&2
  exit 2
fi

"$PYTHON_BIN" -B -c '
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(f"Full-build manifest is missing: {path}")
manifest = json.loads(path.read_text(encoding="utf-8"))
if manifest.get("scope") != "full" or manifest.get("technical_preview") is not False:
    raise SystemExit("Release gate requires scope=full and technical_preview=false")
' "$FULL_MANIFEST"

"$PYTHON_BIN" -B -c '
import json, pathlib, sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
receipt_path = pathlib.Path(sys.argv[2])
if not receipt_path.is_file():
    raise SystemExit(f"Deterministic rebuild receipt is missing: {receipt_path}")
receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
if receipt.get("passed") is not True or not all(receipt.get("checks", {}).values()):
    raise SystemExit("Deterministic rebuild receipt contains a failed comparison")
for key, receipt_key in (("build_hash", "build_hash"), ("builder_version", "builder_version"), ("schema_version", "schema_version")):
    if manifest.get(key) != receipt.get(receipt_key):
        raise SystemExit(f"Determinism receipt does not match current manifest field {key}")
if manifest.get("counts") != receipt.get("row_counts"):
    raise SystemExit("Determinism receipt row counts do not match the current manifest")
if manifest.get("content_hashes") != receipt.get("canonical_table_hashes"):
    raise SystemExit("Determinism receipt table hashes do not match the current manifest")
print("Verified two-build determinism: {}".format(receipt["build_hash"]))
' "$FULL_MANIFEST" "$DETERMINISM_RECEIPT"

cd "$ROOT"
"$PYTHON_BIN" -B -m unittest discover -s tests -p 'test_*.py' -v
"$VENV_PYTHON" -B -m unittest discover -s backend/tests -p 'test_*.py' -v

cd "$ROOT/frontend"
CI=true pnpm test
CI=true pnpm run typecheck
CI=true pnpm run build

cd "$ROOT"
"$PYTHON_BIN" -B scripts/audit_offline_bundle.py
"$VENV_PYTHON" -B -c '
from pathlib import Path
from backend.app.main import create_app
app = create_app(
    project_root=Path.cwd(),
    full_database_verify=True,
    full_reference_verify=True,
)
package = app.state.runtime_package
if package.technical_preview:
    raise SystemExit("Normal startup unexpectedly selected a technical preview")
print(f"Verified full startup: {package.build_hash}")
'

"$PYTHON_BIN" -B -c '
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
ignored = {".venv", "node_modules", "__pycache__"}
pattern = re.compile(r" [2-9](?:\.|$)")
conflicts = []
for path in root.rglob("*"):
    relative = path.relative_to(root)
    if any(part in ignored for part in relative.parts):
        continue
    if any(pattern.search(part) for part in relative.parts):
        conflicts.append(str(relative))
if conflicts:
    raise SystemExit("FileProvider conflict copies remain:\n- " + "\n- ".join(conflicts))
print("No FileProvider conflict copies detected.")
' "$ROOT"

echo "Automated core release gate passed. Browser, performance, cross-engine, and human evidence remain separate checklist gates."
