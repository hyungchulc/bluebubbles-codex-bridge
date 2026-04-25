#!/usr/bin/env bash
set -euo pipefail

PORT="${CODEX_REMOTE_DEBUG_PORT:-9229}"
CODEX_APP_PATH="${CODEX_APP_PATH:-/Applications/Codex.app}"
ORIGIN="http://127.0.0.1:${PORT}"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Codex remote debugging already appears to be listening on ${ORIGIN}"
  exit 0
fi

open -g -n -a "${CODEX_APP_PATH}" --args \
  "--remote-debugging-port=${PORT}" \
  "--remote-allow-origins=${ORIGIN}"

echo "Launching Codex with remote debugging on ${ORIGIN}"
for _ in $(seq 1 30); do
  if curl -fsS "${ORIGIN}/json/version" >/dev/null 2>&1; then
    echo "Codex remote debugging is ready: ${ORIGIN}"
    exit 0
  fi
  sleep 0.5
done

echo "Timed out waiting for Codex remote debugging on ${ORIGIN}" >&2
exit 1
