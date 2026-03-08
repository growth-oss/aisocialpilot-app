#!/bin/bash
set -e

echo "  ✦ AI Social Pilot — Starting services..."

# Start virtual display (needed for headed browser automation)
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99
sleep 1
echo "  ✦ Virtual display started on :99"

# Start VNC server (localhost only — proxied through Express at /vnc/)
x11vnc -display :99 -nopw -listen localhost -xkb -forever -shared -quiet &
sleep 1
echo "  ✦ VNC server started on :5900"

# Find noVNC web directory (path differs by Ubuntu version / install method)
NOVNC_DIR=""
for d in /usr/share/novnc /usr/share/novnc/utils/novnc /opt/novnc /usr/local/novnc; do
  if [ -f "$d/vnc.html" ] || [ -f "$d/vnc_lite.html" ]; then
    NOVNC_DIR="$d"
    break
  fi
done

if [ -z "$NOVNC_DIR" ]; then
  echo "  ⚠ noVNC web files not found — live browser view unavailable"
  websockify 6080 localhost:5900 &
else
  echo "  ✦ noVNC found at $NOVNC_DIR"
  # Ensure vnc.html exists (some installs only have vnc_lite.html)
  [ ! -f "$NOVNC_DIR/vnc.html" ] && [ -f "$NOVNC_DIR/vnc_lite.html" ] && \
    cp "$NOVNC_DIR/vnc_lite.html" "$NOVNC_DIR/vnc.html"
  websockify --web "$NOVNC_DIR" 6080 localhost:5900 &
fi
echo "  ✦ noVNC proxy started on :6080"

# Pre-initialize Claude Code config — always overwrite to ensure correct bypass settings
mkdir -p /root/.claude
cat > /root/.claude/settings.json << 'SETTINGS_EOF'
{
  "autoUpdaterStatus": "disabled",
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true,
  "dangerouslySkipPermissionsAcknowledged": true,
  "skipPermissionsConfirmed": true,
  "permissionMode": "bypassPermissions"
}
SETTINGS_EOF
echo "  ✦ Claude Code config initialised"

# Start the Express admin server
exec node server/index.js
