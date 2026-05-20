#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BRIDGE_PORT="${BRIDGE_PORT:-3099}"
BRIDGE_LAUNCH_LABEL="${BRIDGE_LAUNCH_LABEL:-local.bluebubbles-codex-bridge}"
LOG_DIR="${ROOT}/logs"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
mkdir -p "$LOG_DIR"

if [[ -z "$NPM_BIN" && -z "$NODE_BIN" ]]; then
  echo "node/npm was not found. PATH=${PATH}" >&2
  exit 1
fi

"${ROOT}/scripts/open-codex-debug.sh"

if lsof -nP -iTCP:"${BRIDGE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Bridge already appears to be listening on http://127.0.0.1:${BRIDGE_PORT}"
else
  if [[ "$(uname -s)" == "Darwin" && -n "$NODE_BIN" ]]; then
    launchctl remove "$BRIDGE_LAUNCH_LABEL" >/dev/null 2>&1 || true
    launchctl submit -l "$BRIDGE_LAUNCH_LABEL" -- /bin/zsh -lc \
      "cd '$ROOT' && echo \$\$ > '$LOG_DIR/bridge.pid' && exec '$NODE_BIN' src/server.js >> '$LOG_DIR/bridge.log' 2>&1"
    echo "Starting bridge server via launchctl on http://127.0.0.1:${BRIDGE_PORT}"
  else
    nohup "$NPM_BIN" start > "${LOG_DIR}/bridge.log" 2>&1 &
    echo $! > "${LOG_DIR}/bridge.pid"
    echo "Starting bridge server on http://127.0.0.1:${BRIDGE_PORT} (pid $(cat "${LOG_DIR}/bridge.pid"))"
  fi
fi

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
    echo "Bridge is ready: http://127.0.0.1:${BRIDGE_PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "Timed out waiting for bridge. Last log lines:" >&2
tail -50 "${LOG_DIR}/bridge.log" >&2 2>/dev/null || true
exit 1
