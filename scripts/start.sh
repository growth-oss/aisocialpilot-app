#!/bin/bash
set -e

echo "  ✦ AI Social Pilot — Starting services..."

# Start virtual display (needed for headed browser automation)
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99
sleep 1
echo "  ✦ Virtual display started on :99"

# Start VNC server (localhost only — proxied through Express at /vnc/)
x11vnc -display :99 -nopw -listen localhost -xkb -forever -quiet &
sleep 1
echo "  ✦ VNC server started on :5900"

# Start noVNC websocket proxy (localhost only)
websockify --web /usr/share/novnc 6080 localhost:5900 &
echo "  ✦ noVNC proxy started on :6080"

# Start the Express admin server
exec node server/index.js
