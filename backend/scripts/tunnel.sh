#!/usr/bin/env bash
# Expose Seraphine at https://sera.jonhdev.io via Cloudflare Tunnel.
# Usage: ./scripts/tunnel.sh
set -euo pipefail

echo "=================================="
echo "  Seraphine — Cloudflare Tunnel"
echo "  https://sera.jonhdev.io"
echo "=================================="

exec cloudflared tunnel run seraphine
