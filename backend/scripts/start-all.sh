#!/usr/bin/env bash
# Start all Seraphine services: Ollama + vMLX + Backend + Frontend.
# Usage: ./scripts/start-all.sh
# Stop:  ./scripts/stop-all.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# ------------------------------------------------------------------
# 1. Ollama (embedding model for memory)
# ------------------------------------------------------------------
echo "=== Starting Ollama ==="
if pgrep -x ollama >/dev/null 2>&1; then
  echo "  Ollama already running."
else
  open -a Ollama
  echo "  Ollama.app launched, waiting..."
  for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      break
    fi
    sleep 1
    printf "."
  done
  echo ""
fi

# Pre-load the embedding model so it's warm for the backend
echo "  Loading nomic-embed-text..."
curl -s -X POST http://127.0.0.1:11434/api/generate -d '{"model":"nomic-embed-text","keep_alive":-1,"prompt":".","options":{"num_predict":1}}' >/dev/null 2>&1 || true
echo "  Ollama ready (nomic-embed-text loaded)."

# ------------------------------------------------------------------
# 2. vMLX (LLM — Gemma 4 26B)
# ------------------------------------------------------------------
echo ""
echo "=== Starting vMLX (Gemma 4 26B) ==="
"$DIR/start-vmlx.sh" &
VMLX_PID=$!

echo "  Waiting for vMLX to load model (~30s)..."
for i in $(seq 1 60); do
  if curl -s http://127.0.0.1:1234/health >/dev/null 2>&1; then
    echo "  vMLX ready!"
    break
  fi
  sleep 1
  printf "."
done
echo ""

# Unload gemma4:e4b from Ollama if loaded (free ~11GB RAM for vMLX)
echo "  Unloading gemma4:e4b from Ollama (if loaded)..."
curl -s -X POST http://127.0.0.1:11434/api/generate -d '{"model":"gemma4:e4b","keep_alive":0}' >/dev/null 2>&1 || true

# ------------------------------------------------------------------
# 3. Seraphine Backend
# ------------------------------------------------------------------
echo ""
echo "=== Starting Seraphine Backend ==="
"$DIR/start.sh" &
BACK_PID=$!
sleep 3

# ------------------------------------------------------------------
# 4. Frontend (Vite)
# ------------------------------------------------------------------
echo ""
echo "=== Starting Frontend (Vite) ==="
cd "$DIR/../../frontend"
pnpm dev &
FRONT_PID=$!

# ------------------------------------------------------------------
# 5. WhatsApp Bridge
# ------------------------------------------------------------------
echo ""
echo "=== Starting WhatsApp Bridge ==="
WA_DIR="$DIR/../../services/whatsapp-bridge"
if lsof -ti:3001 >/dev/null 2>&1; then
  echo "  WhatsApp bridge already running on :3001"
  WA_PID=""
else
  cd "$WA_DIR"
  rm -f .wwebjs_auth/session/SingletonLock 2>/dev/null
  node dist/index.js &
  WA_PID=$!
  echo "  WhatsApp bridge starting (PID $WA_PID)..."
  sleep 5
fi

# ------------------------------------------------------------------
# 6. Cloudflare Tunnel (sera.jonhdev.io)
# ------------------------------------------------------------------
TUNNEL_PID=""
if pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
  echo ""
  echo "=== Cloudflare Tunnel already running ==="
else
  echo ""
  echo "=== Starting Cloudflare Tunnel (sera.jonhdev.io) ==="
  cloudflared tunnel run seraphine &
  TUNNEL_PID=$!
  sleep 3
  echo "  Tunnel started (PID $TUNNEL_PID)"
fi

echo ""
echo "=================================="
echo "  All services started!"
echo "=================================="
echo "  Ollama:   http://127.0.0.1:11434 (nomic-embed-text)"
echo "  vMLX:     http://127.0.0.1:1234  (PID $VMLX_PID)"
echo "  Backend:  http://0.0.0.0:8000    (PID $BACK_PID)"
echo "  Frontend: http://0.0.0.0:5173    (PID $FRONT_PID)"
echo "  WhatsApp: http://127.0.0.1:3001  (PID ${WA_PID:-already})"
echo "  Tunnel:   https://sera.jonhdev.io"
for ip in $(ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' | grep -v '127.0.0.1'); do
  echo "  Rede:     http://$ip:5173"
done
echo "=================================="
echo ""
echo "Press Ctrl+C to stop all."

trap "kill $VMLX_PID $BACK_PID $FRONT_PID $WA_PID $TUNNEL_PID 2>/dev/null; exit" INT TERM
wait
