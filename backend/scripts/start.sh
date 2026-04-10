#!/usr/bin/env bash
# Start the Seraphine backend on :8000 (foreground).
# Usage: ./scripts/start.sh          (foreground)
#        ./scripts/start.sh &        (background)
# Set SERAPHINE_RELOAD=true in .env to enable hot reload.
set -euo pipefail

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

cd "$(dirname "$0")/.."

# Source .env if present so SERAPHINE_RELOAD is available.
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

RELOAD_FLAG=""
if [[ "${SERAPHINE_RELOAD:-false}" == "true" ]]; then
  RELOAD_FLAG="--reload"
fi

pids=$(lsof -ti:"$PORT" || true)
if [[ -n "$pids" ]]; then
  echo "ERROR: port $PORT already in use (pids: $pids). Run ./scripts/stop.sh first." >&2
  exit 1
fi

# Print accessible URLs
echo "=================================="
echo "  Seraphine Backend"
echo "=================================="
echo "  Local:   http://127.0.0.1:$PORT"
# List all non-loopback IPv4 addresses on the machine
for ip in $(ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' | grep -v '127.0.0.1'); do
  echo "  Rede:    http://$ip:$PORT"
done
echo "  Health:  http://127.0.0.1:$PORT/health"
echo "  WS:      ws://<ip>:$PORT/ws/conversation"
echo "  Memory:  http://127.0.0.1:$PORT/memory/facts"
echo "=================================="
echo ""

exec uv run uvicorn seraphine.main:app --host "$HOST" --port "$PORT" $RELOAD_FLAG "$@"
