#!/usr/bin/env bash
# Build a clickable macOS app that opens the LILAK Web Portal — starting it first
# if it's not already running. Icon is rendered from the lilak logo.
#
#   ./deploy/make-mac-app.sh            # → ~/Desktop/LILAK Portal.app
#   APP_DEST=~/Applications ./deploy/make-mac-app.sh
set -euo pipefail

SM=$(cd "$(dirname "$0")/.." && pwd)                     # service_manager repo
LOGO="$SM/deploy/app-icon.svg"
DEST="${APP_DEST:-$HOME/Desktop}/LILAK Portal.app"
PORT="${PORTAL_PORT:-8025}"

rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"

# ── launcher (the app's executable) ───────────────────────────────────────────
cat > "$DEST/Contents/MacOS/lilak-portal" <<EOF
#!/bin/bash
URL="http://localhost:$PORT/projects"
HEALTH="http://localhost:$PORT/api/health"
if ! /usr/bin/curl -sf -m 2 "\$HEALTH" >/dev/null 2>&1; then
  # Port may be held by a crashed reloader that no longer serves (health fails but
  # the socket is bound) — a fresh run.sh would then die with "Address already in
  # use" and the app would look "not responding". Clear any such stale listener.
  STALE=\$(/usr/sbin/lsof -ti :$PORT -sTCP:LISTEN 2>/dev/null)
  [ -n "\$STALE" ] && kill -9 \$STALE 2>/dev/null
  /usr/bin/nohup "$SM/run.sh" > /tmp/lilak-portal.log 2>&1 &
  for _ in \$(seq 1 40); do
    sleep 0.5
    /usr/bin/curl -sf -m 2 "\$HEALTH" >/dev/null 2>&1 && break
  done
fi
/usr/bin/open "\$URL"
EOF
chmod +x "$DEST/Contents/MacOS/lilak-portal"

# ── Info.plist ────────────────────────────────────────────────────────────────
cat > "$DEST/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>LILAK Portal</string>
  <key>CFBundleDisplayName</key><string>LILAK Portal</string>
  <key>CFBundleIdentifier</key><string>kr.lilak.webportal.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>lilak-portal</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF

# ── icon (lilak logo → .icns) ─────────────────────────────────────────────────
if command -v rsvg-convert >/dev/null && [ -f "$LOGO" ]; then
  TMP=$(mktemp -d)
  ISET="$TMP/app.iconset"; mkdir -p "$ISET"
  # the logo SVG carries its own (gray, rounded) background → render transparent.
  rsvg-convert -w 1024 -h 1024 --keep-aspect-ratio "$LOGO" -o "$TMP/base.png"
  for s in 16 32 64 128 256 512 1024; do
    sips -z $s $s "$TMP/base.png" --out "$ISET/icon_${s}x${s}.png" >/dev/null
  done
  # @2x variants
  cp "$ISET/icon_32x32.png"   "$ISET/icon_16x16@2x.png"
  cp "$ISET/icon_64x64.png"   "$ISET/icon_32x32@2x.png"
  cp "$ISET/icon_256x256.png" "$ISET/icon_128x128@2x.png"
  cp "$ISET/icon_512x512.png" "$ISET/icon_256x256@2x.png"
  cp "$ISET/icon_1024x1024.png" "$ISET/icon_512x512@2x.png"
  rm -f "$ISET/icon_64x64.png" "$ISET/icon_1024x1024.png"
  iconutil -c icns "$ISET" -o "$DEST/Contents/Resources/app.icns"
  rm -rf "$TMP"
  echo "✓ icon built from $LOGO"
else
  echo "… no rsvg-convert/logo — app gets the default icon"
fi

# refresh LaunchServices so Finder shows the new icon
/usr/bin/touch "$DEST"
echo "✓ created: $DEST"
echo "  double-click it, or drag it to the Dock."
