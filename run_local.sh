#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
VENV="$ROOT/.venv"
LOCK="$ROOT/requirements.lock"
PYTHON_BIN="${PYTHON:-python3}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating local Python environment at $VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi

LOCK_HASH="$($VENV/bin/python -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$LOCK")"
MARKER="$VENV/.transcript-browser-requirements.sha256"
INSTALLED_HASH=""
if [[ -f "$MARKER" ]]; then
  INSTALLED_HASH="$(<"$MARKER")"
fi
if [[ "$INSTALLED_HASH" != "$LOCK_HASH" ]]; then
  echo "Installing pinned local-server dependencies"
  "$VENV/bin/python" -m pip install --disable-pip-version-check --no-deps --requirement "$LOCK"
  printf '%s\n' "$LOCK_HASH" > "$MARKER"
fi

cd "$ROOT"
exec "$VENV/bin/python" -m backend.app.cli "$@"

