#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SOURCE_DIR="$ROOT/desktop_app"
OUTPUT_APP="${1:-$SOURCE_DIR/dist/Transcript Browser.app}"
STAGE="$(mktemp -d /private/tmp/transcript-browser-launcher.XXXXXX)"
STAGED_APP="$STAGE/Transcript Browser.app"
CONTENTS="$STAGED_APP/Contents"
trap 'rm -rf "$STAGE"' EXIT

rm -rf "$OUTPUT_APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$STAGE/ModuleCache"

xcrun swiftc \
  -O \
  -target arm64-apple-macosx12.0 \
  -module-cache-path "$STAGE/ModuleCache" \
  -framework AppKit \
  "$SOURCE_DIR/TranscriptBrowserLauncher.swift" \
  -o "$CONTENTS/MacOS/TranscriptBrowserLauncher"

cp "$SOURCE_DIR/Info.plist" "$CONTENTS/Info.plist"
"$ROOT/.venv/bin/python" -B "$SOURCE_DIR/make_icon.py" "$CONTENTS/Resources/AppIcon.icns"
"$ROOT/.venv/bin/python" -B "$SOURCE_DIR/package_runtime.py" "$ROOT" "$CONTENTS/Resources/Runtime.zip"
chmod +x "$CONTENTS/MacOS/TranscriptBrowserLauncher"

plutil -lint "$CONTENTS/Info.plist"
xattr -cr "$STAGED_APP"
codesign --force --deep --sign - "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"

mkdir -p "$(dirname -- "$OUTPUT_APP")"
ditto --norsrc --noextattr "$STAGED_APP" "$OUTPUT_APP"
verified=0
for _ in 1 2 3 4 5; do
  xattr -d com.apple.FinderInfo "$OUTPUT_APP" 2>/dev/null || :
  xattr -d 'com.apple.fileprovider.fpfs#P' "$OUTPUT_APP" 2>/dev/null || :
  if codesign --verify --deep --strict "$OUTPUT_APP" 2>/dev/null; then
    verified=1
    break
  fi
done
if [[ "$verified" != "1" ]]; then
  echo "Copied app could not be verified after clearing Desktop metadata." >&2
  exit 1
fi

echo "Built $OUTPUT_APP"
