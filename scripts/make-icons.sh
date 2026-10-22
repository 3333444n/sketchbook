#!/bin/sh
# Generate app icons from build/icon.svg (macOS only: uses sips + iconutil).
#   build/icon.png      1024x1024 (electron-builder source)
#   build/icon.icns     macOS app/document icon
#   resources/icon.png  512x512 (runtime window/dock icon)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/build/icon.svg"
PNG="$ROOT/build/icon.png"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"

"$ROOT/node_modules/.bin/electron" "$ROOT/scripts/render-icon.cjs" "$SVG" "$PNG"

for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$ROOT/build/icon.icns"
mkdir -p "$ROOT/resources"
sips -z 512 512 "$PNG" --out "$ROOT/resources/icon.png" >/dev/null
rm -rf "$(dirname "$ICONSET")"

echo "icons written: build/icon.png build/icon.icns resources/icon.png"
