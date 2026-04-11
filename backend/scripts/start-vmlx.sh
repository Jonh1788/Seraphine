#!/usr/bin/env bash
# Start the vMLX server with Gemma 4 26B.
# Usage: ./scripts/start-vmlx.sh
set -euo pipefail

PORT="${VMLX_PORT:-1234}"
MODEL="${VMLX_MODEL:-/Users/jonh1788/.lmstudio/models/mlx-community/gemma-4-26b-a4b-it-4bit}"
# Speculative decoding draft model (optional, same-tokenizer required)
DRAFT_MODEL="${VMLX_DRAFT:-/Users/jonh1788/.lmstudio/models/mlx-community/gemma-3-270m-it-qat-4bit}"

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

# Speculative decoding is DISABLED: Gemma 3 draft model produced
# degenerate token loops ("<|tool_call>callcallcall...") when paired
# with Gemma 4, breaking tool calling completely. Re-enable only after
# finding a compatible draft model.
DRAFT_FLAGS=()
# if [[ -d "$DRAFT_MODEL" && "${VMLX_SPECULATIVE:-0}" == "1" ]]; then
#   DRAFT_FLAGS=(--speculative-model "$DRAFT_MODEL" --num-draft-tokens 3)
#   echo "  Draft:  $DRAFT_MODEL (speculative decoding enabled)"
# fi

exec vmlx serve "$MODEL" \
  --port "$PORT" \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --default-enable-thinking false \
  --continuous-batching \
  --enable-prefix-cache \
  --enable-disk-cache \
  "${DRAFT_FLAGS[@]}" \
  "$@"
