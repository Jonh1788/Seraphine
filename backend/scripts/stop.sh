#!/usr/bin/env bash
# Stop everything Seraphine's start.sh launched: backend (uvicorn),
# frontend (Vite), local vMLX, and cloudflared tunnel.
#
# Usage: ./scripts/stop.sh
set -euo pipefail

stop_port() {
  local label="$1"
  local port="$2"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    echo "  · $label on :$port — not running"
    return
  fi
  echo "  · $label on :$port — killing $pids"
  kill $pids 2>/dev/null || true
  sleep 1
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "    force kill $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}

stop_pattern() {
  local label="$1"
  local pattern="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    echo "  · $label — not running"
    return
  fi
  echo "  · $label — killing $(echo $pids | tr '\n' ' ')"
  echo "$pids" | xargs kill 2>/dev/null || true
  sleep 1
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "    force kill $(echo $pids | tr '\n' ' ')"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

echo "Stopping Seraphine stack:"
stop_port     "backend (uvicorn)" 8000
stop_port     "frontend (Vite)"   5173
stop_pattern  "vMLX (local LLM)"  "vmlx serve"
stop_pattern  "cloudflared"       "cloudflared tunnel"
stop_pattern  "caffeinate (keep-awake)" "caffeinate -i -w"
echo "done"
