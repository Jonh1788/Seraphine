#!/usr/bin/env bash
# Stop the Seraphine backend running on :8000.
# Usage: ./scripts/stop.sh
set -euo pipefail

PORT="${PORT:-8000}"

pids=$(lsof -ti:"$PORT" || true)
if [[ -z "$pids" ]]; then
  echo "no process on :$PORT"
  exit 0
fi

echo "killing pids on :$PORT -> $pids"
kill $pids || true
sleep 1

pids=$(lsof -ti:"$PORT" || true)
if [[ -n "$pids" ]]; then
  echo "force killing $pids"
  kill -9 $pids || true
fi

echo "stopped"
