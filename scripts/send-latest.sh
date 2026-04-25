#!/usr/bin/env bash
set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-3099}"

curl -sS -X POST "http://127.0.0.1:${BRIDGE_PORT}/pending/latest/send" \
  -H "content-type: application/json" \
  --data '{"confirm":true}' | jq .
