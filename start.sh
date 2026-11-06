#!/bin/bash
set -e

echo "[Init] Starting Xvfb virtual display on :99..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

sleep 2

echo "[Init] Xvfb started (PID: $XVFB_PID). Launching Node generator on port ${PORT:-3001}..."
exec node generator.js

