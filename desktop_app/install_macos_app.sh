#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SOURCE_DIR="$ROOT/desktop_app"
BUILT_APP="$SOURCE_DIR/dist/Transcript Browser.app"
INSTALLED_APP="$HOME/Applications/Transcript Browser.app"
DESKTOP_APP="$HOME/Desktop/Transcript Browser.app"

"$SOURCE_DIR/build_macos_app.sh"

MANIFEST="$BUILT_APP/Contents/Resources/Runtime-manifest.json"
ARCHIVE="$BUILT_APP/Contents/Resources/Runtime.zip"
RUNTIME_VERSION="$("$ROOT/.venv/bin/python" -B -c \
  'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["runtimeVersion"])' \
  "$MANIFEST")"
RUNTIME_ROOT="$HOME/Library/Application Support/Transcript Browser/Runtime"
CACHED_RUNTIME="$RUNTIME_ROOT/$RUNTIME_VERSION"
STAGING_RUNTIME="$RUNTIME_ROOT/.install-$RUNTIME_VERSION-$$"

cleanup() {
  rm -rf "$STAGING_RUNTIME"
}
trap cleanup EXIT

mkdir -p "$RUNTIME_ROOT"
rm -rf "$STAGING_RUNTIME"
/usr/bin/ditto -x -k "$ARCHIVE" "$STAGING_RUNTIME"

"$ROOT/.venv/bin/python" -B "$SOURCE_DIR/materialize_runtime_data.py" \
  "$ROOT" "$STAGING_RUNTIME" "$CACHED_RUNTIME"

rm -rf "$CACHED_RUNTIME"
mv "$STAGING_RUNTIME" "$CACHED_RUNTIME"
mkdir -p "$HOME/Applications"
rsync -a --delete "$BUILT_APP/" "$INSTALLED_APP/"
xattr -cr "$INSTALLED_APP"
codesign --verify --deep --strict "$INSTALLED_APP"
if [[ -L "$DESKTOP_APP" ]]; then
  rm "$DESKTOP_APP"
elif [[ -e "$DESKTOP_APP" ]]; then
  rm -rf "$DESKTOP_APP"
fi
ln -s "$INSTALLED_APP" "$DESKTOP_APP"

echo "Installed $INSTALLED_APP"
echo "Created clickable Desktop app $DESKTOP_APP"
echo "Prepared private runtime $CACHED_RUNTIME"
