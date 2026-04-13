#!/usr/bin/env bash
# Start Seraphine services based on services.json config.
# First run? Execute ./scripts/setup-services.sh to configure.
# Usage: ./scripts/start-all.sh
# Stop:  ./scripts/stop-all.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/services.json"

# Colors
BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
PURPLE="\033[35m"
RESET="\033[0m"

# ------------------------------------------------------------------
# Load config (or run setup if first time)
# ------------------------------------------------------------------
if [ ! -f "$CONFIG" ]; then
  echo -e "${YELLOW}No services.json found — running first-time setup...${RESET}"
  echo ""
  bash "$DIR/setup-services.sh"
fi

# Parse JSON (simple grep-based, no jq dependency)
svc_enabled() {
  local key="$1"
  grep -q "\"$key\".*true" "$CONFIG" 2>/dev/null
}

echo ""
echo -e "${PURPLE}${BOLD}  Seraphine — Starting Services${RESET}"
echo -e "${DIM}  Config: $CONFIG${RESET}"
echo ""

PIDS=""

# ------------------------------------------------------------------
# 1. Ollama (embedding model for memory)
# ------------------------------------------------------------------
if svc_enabled "ollama"; then
  echo -e "=== ${GREEN}Ollama${RESET} ==="
  if pgrep -x ollama >/dev/null 2>&1; then
    echo "  Already running."
  else
    open -a Ollama
    echo "  Launching Ollama.app..."
    for i in $(seq 1 30); do
      curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
      sleep 1; printf "."
    done
    echo ""
  fi
  echo "  Loading nomic-embed-text..."
  curl -s -X POST http://127.0.0.1:11434/api/generate \
    -d '{"model":"nomic-embed-text","keep_alive":-1,"prompt":".","options":{"num_predict":1}}' \
    >/dev/null 2>&1 || true
  echo -e "  ${GREEN}✓ Ready${RESET}"
else
  echo -e "=== ${DIM}Ollama — skipped${RESET} ==="
fi

# ------------------------------------------------------------------
# 2. vMLX (local LLM)
# ------------------------------------------------------------------
VMLX_PID=""
if svc_enabled "vmlx"; then
  LLM_BACKEND=$(grep '^SERAPHINE_LLM_BACKEND=' "$DIR/../.env" 2>/dev/null | cut -d= -f2 | tr -d ' "')
  if [ "$LLM_BACKEND" = "anthropic" ] || [ "$LLM_BACKEND" = "claude_max" ]; then
    echo ""
    echo -e "=== ${DIM}vMLX — skipped (backend=$LLM_BACKEND)${RESET} ==="
  else
    echo ""
    echo -e "=== ${GREEN}vMLX (Local LLM)${RESET} ==="
    "$DIR/start-vmlx.sh" &
    VMLX_PID=$!
    echo "  Loading model (~30s)..."
    for i in $(seq 1 60); do
      curl -s http://127.0.0.1:1234/health >/dev/null 2>&1 && break
      sleep 1; printf "."
    done
    echo ""
    curl -s -X POST http://127.0.0.1:11434/api/generate \
      -d '{"model":"gemma4:e4b","keep_alive":0}' >/dev/null 2>&1 || true
    echo -e "  ${GREEN}✓ Ready${RESET}"
  fi
else
  echo ""
  echo -e "=== ${DIM}vMLX — skipped${RESET} ==="
fi

# ------------------------------------------------------------------
# 3. Backend (FastAPI)
# ------------------------------------------------------------------
BACK_PID=""
if svc_enabled "backend"; then
  echo ""
  echo -e "=== ${GREEN}Backend${RESET} ==="
  "$DIR/start.sh" &
  BACK_PID=$!
  sleep 3
  echo -e "  ${GREEN}✓ Starting${RESET}"
else
  echo ""
  echo -e "=== ${DIM}Backend — skipped${RESET} ==="
fi

# ------------------------------------------------------------------
# 4. Frontend (Vite)
# ------------------------------------------------------------------
FRONT_PID=""
if svc_enabled "frontend"; then
  echo ""
  echo -e "=== ${GREEN}Frontend (Vite)${RESET} ==="
  cd "$DIR/../../frontend"
  pnpm dev &
  FRONT_PID=$!
  echo -e "  ${GREEN}✓ Starting${RESET}"
else
  echo ""
  echo -e "=== ${DIM}Frontend — skipped${RESET} ==="
fi

# ------------------------------------------------------------------
# 5. WhatsApp Bridge
# ------------------------------------------------------------------
WA_PID=""
if svc_enabled "whatsapp"; then
  echo ""
  echo -e "=== ${GREEN}WhatsApp Bridge${RESET} ==="
  WA_DIR="$DIR/../../services/whatsapp-bridge"
  if lsof -ti:3001 >/dev/null 2>&1; then
    echo "  Already running on :3001"
  else
    cd "$WA_DIR"
    rm -f .wwebjs_auth/session/SingletonLock 2>/dev/null
    node dist/index.js &
    WA_PID=$!
    sleep 5
    echo -e "  ${GREEN}✓ Starting (PID $WA_PID)${RESET}"
  fi
else
  echo ""
  echo -e "=== ${DIM}WhatsApp — skipped${RESET} ==="
fi

# ------------------------------------------------------------------
# 6. Cloudflare Tunnel
# ------------------------------------------------------------------
TUNNEL_PID=""
if svc_enabled "tunnel"; then
  if pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
    echo ""
    echo -e "=== ${GREEN}Cloudflare Tunnel${RESET} — already running ==="
  else
    echo ""
    echo -e "=== ${GREEN}Cloudflare Tunnel${RESET} ==="
    cloudflared tunnel run seraphine &
    TUNNEL_PID=$!
    sleep 3
    echo -e "  ${GREEN}✓ Started${RESET}"
  fi
else
  echo ""
  echo -e "=== ${DIM}Tunnel — skipped${RESET} ==="
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo -e "${PURPLE}${BOLD}══════════════════════════════════════${RESET}"
echo -e "${PURPLE}${BOLD}  Seraphine — Services Running${RESET}"
echo -e "${PURPLE}${BOLD}══════════════════════════════════════${RESET}"
svc_enabled "ollama"    && echo -e "  ${GREEN}●${RESET} Ollama    http://127.0.0.1:11434"
svc_enabled "vmlx"      && [ -n "$VMLX_PID" ] && echo -e "  ${GREEN}●${RESET} vMLX      http://127.0.0.1:1234 (PID $VMLX_PID)"
svc_enabled "backend"   && echo -e "  ${GREEN}●${RESET} Backend   http://0.0.0.0:8000 (PID ${BACK_PID:-?})"
svc_enabled "frontend"  && echo -e "  ${GREEN}●${RESET} Frontend  http://0.0.0.0:5173 (PID ${FRONT_PID:-?})"
svc_enabled "whatsapp"  && echo -e "  ${GREEN}●${RESET} WhatsApp  http://127.0.0.1:3001 (PID ${WA_PID:-running})"
svc_enabled "tunnel"    && echo -e "  ${GREEN}●${RESET} Tunnel    https://sera.jonhdev.io"
for ip in $(ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' | grep -v '127.0.0.1'); do
  echo -e "  ${DIM}Rede: http://$ip:5173${RESET}"
done
echo -e "${PURPLE}${BOLD}══════════════════════════════════════${RESET}"
echo ""
echo -e "${DIM}Press Ctrl+C to stop all. Edit: scripts/services.json${RESET}"
echo ""

# Cleanup trap
cleanup() {
  [ -n "$VMLX_PID" ] && kill "$VMLX_PID" 2>/dev/null
  [ -n "$BACK_PID" ] && kill "$BACK_PID" 2>/dev/null
  [ -n "$FRONT_PID" ] && kill "$FRONT_PID" 2>/dev/null
  [ -n "$WA_PID" ] && kill "$WA_PID" 2>/dev/null
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM
wait
