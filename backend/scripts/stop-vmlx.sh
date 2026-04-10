#!/usr/bin/env bash
# Stop the vMLX server.
# Usage: ./scripts/stop-vmlx.sh
set -euo pipefail

PORT="${VMLX_PORT:-1234}"

pids=$(lsof -ti:"$PORT" || true)
if [[ -z "$pids" ]]; then
  echo "no process on :$PORT"
  exit 0
fi

echo "killing vMLX on :$PORT -> $pids"
kill $pids || true
sleep 1

pids=$(lsof -ti:"$PORT" || true)
if [[ -n "$pids" ]]; then
  echo "force killing $pids"
  kill -9 $pids || true
fi

echo "stopped"
