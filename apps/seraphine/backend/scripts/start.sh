#!/usr/bin/env bash
# Seraphine one-shot startup.
#
# Delegates to seraphine.bootstrap, which reads .env and orchestrates:
#   · cloudflared tunnel (if SERAPHINE_CLOUDFLARED_TUNNEL_ID set)
#   · vMLX (if llm_backend=openai) OR kills it (if llm_backend=anthropic)
#   · Anthropic / ElevenLabs API reachability checks
#   · Ollama availability check (for embeddings)
#   · uvicorn on :8000 (foreground)
#
# Usage: ./scripts/start.sh
set -euo pipefail

PORT="${PORT:-8000}"
cd "$(dirname "$0")/.."

pids=$(lsof -ti:"$PORT" || true)
if [[ -n "$pids" ]]; then
  echo "ERROR: port $PORT already in use (pids: $pids). Run ./scripts/stop.sh first." >&2
  exit 1
fi

exec uv run python -m seraphine.bootstrap
