#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${ROOT}/logs/bridge.pid"
BRIDGE_LAUNCH_LABEL="${BRIDGE_LAUNCH_LABEL:-local.bluebubbles-codex-bridge}"

if [[ "$(uname -s)" == "Darwin" ]]; then
  launchctl remove "$BRIDGE_LAUNCH_LABEL" >/dev/null 2>&1 || true
fi

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID"
    echo "Stopped bridge pid ${PID}"
  fi
  rm -f "$PID_FILE"
fi

PORT="${BRIDGE_PORT:-3099}"
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "A process is still listening on ${PORT}:"
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
fi
