#!/usr/bin/env bash
# Restart the Seraphine backend on :8000.
# Usage: ./scripts/restart.sh   (run from backend/)
# Set SERAPHINE_RELOAD=true in .env to enable hot reload.
set -euo pipefail

PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"

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
  echo "killing pids on :$PORT -> $pids"
  kill $pids || true
  sleep 1
  pids=$(lsof -ti:"$PORT" || true)
  if [[ -n "$pids" ]]; then
    echo "force killing $pids"
    kill -9 $pids || true
  fi
fi

echo "starting uvicorn on $HOST:$PORT ${RELOAD_FLAG:+(reload)}"
exec uv run uvicorn seraphine.main:app --host "$HOST" --port "$PORT" $RELOAD_FLAG "$@"
