#!/usr/bin/env bash
# Start the vMLX server with Qwen3.5 35B A3B 8bit + Flash MoE.
# Usage: ./scripts/start-vmlx.sh
set -euo pipefail

PORT="${VMLX_PORT:-1234}"
MODEL="${VMLX_MODEL:-/Users/jonh1788/.lmstudio/models/mlx-community/gemma-4-26b-a4b-it-5bit}"

# Fallback to 4bit if 5bit isn't downloaded yet
if [[ ! -d "$MODEL" ]]; then
  MODEL="/Users/jonh1788/.lmstudio/models/mlx-community/gemma-4-26b-a4b-it-4bit"
  echo "  NOTE: 5bit not downloaded yet — using 4bit fallback"
fi

TOOL_PARSER="gemma4"
REASONING_PARSER="gemma4"
# Flash MoE disabled — Gemma 4 26B 5bit fits comfortably in 36 GB RAM
# without streaming. Flash MoE added no measurable speedup and saved
# only ~0.4 GB. Re-enable only for larger models (35B+).
FLASH_MOE_FLAGS=()
# FLASH_MOE_FLAGS=(
#   --flash-moe
#   --flash-moe-slot-bank 128
#   --flash-moe-prefetch temporal
#   --flash-moe-io-split 6
# )

pids=$(lsof -ti:"$PORT" || true)
if [[ -n "$pids" ]]; then
  echo "ERROR: port $PORT already in use (pids: $pids). Run ./scripts/stop-vmlx.sh first." >&2
  exit 1
fi

echo "=================================="
echo "  vMLX"
echo "=================================="
echo "  Model:    $MODEL"
echo "  Parser:   $TOOL_PARSER"
echo "  Port:     $PORT"
echo "  API:      http://127.0.0.1:$PORT/v1/chat/completions"
echo "  Health:   http://127.0.0.1:$PORT/health"
echo "  Flash MoE: ${FLASH_MOE_FLAGS[@]+enabled}"
echo "=================================="
echo ""

exec vmlx serve "$MODEL" \
  --port "$PORT" \
  --tool-call-parser "$TOOL_PARSER" \
  --reasoning-parser "$REASONING_PARSER" \
  --enable-auto-tool-choice \
  --default-enable-thinking false \
  --default-repetition-penalty 1.1 \
  --continuous-batching \
  --enable-prefix-cache \
  --use-paged-cache \
  --max-cache-blocks 500 \
  --paged-cache-block-size 64 \
  --max-num-seqs 4 \
  --completion-batch-size 4 \
  --prefill-step-size 512 \
  --cache-memory-percent 0.15 \
  ${FLASH_MOE_FLAGS[@]+"${FLASH_MOE_FLAGS[@]}"} \
  "$@"
