#!/usr/bin/env bash
# Start the vMLX server with Gemma 4 26B.
# Usage: ./scripts/start-vmlx.sh
set -euo pipefail

PORT="${VMLX_PORT:-1234}"
MODEL="${VMLX_MODEL:-/Users/jonh1788/.lmstudio/models/dealignai/Gemma-4-26B-A4B-JANG_4M-CRACK}"

pids=$(lsof -ti:"$PORT" || true)
if [[ -n "$pids" ]]; then
  echo "ERROR: port $PORT already in use (pids: $pids). Run ./scripts/stop-vmlx.sh first." >&2
  exit 1
fi

echo "=================================="
echo "  vMLX — Gemma 4 26B"
echo "=================================="
echo "  Model:  $MODEL"
echo "  Port:   $PORT"
echo "  API:    http://127.0.0.1:$PORT/v1/chat/completions"
echo "  Health: http://127.0.0.1:$PORT/health"
echo "=================================="
echo ""

exec vmlx serve "$MODEL" \
  --port "$PORT" \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --default-enable-thinking false \
  "$@"
