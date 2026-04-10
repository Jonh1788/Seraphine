#!/usr/bin/env bash
# Stop all Seraphine services.
# Usage: ./scripts/stop-all.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping Frontend (Vite)..."
pkill -f "vite" 2>/dev/null || echo "  no vite process"

echo "Stopping Backend..."
"$DIR/stop.sh" 2>/dev/null || true

echo "Stopping vMLX..."
"$DIR/stop-vmlx.sh" 2>/dev/null || true

echo "Stopping Cloudflare Tunnel..."
pkill -f "cloudflared tunnel run" 2>/dev/null || echo "  no tunnel process"

echo "Unloading Ollama models..."
curl -s -X POST http://127.0.0.1:11434/api/generate -d '{"model":"nomic-embed-text","keep_alive":0}' >/dev/null 2>&1 || true

echo "All stopped. (Ollama app still running — close manually if needed)"
