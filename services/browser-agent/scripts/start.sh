#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pip install -r requirements.txt -q
playwright install chromium 2>/dev/null || true
exec uvicorn main:app --host 0.0.0.0 --port "${BROWSER_PORT:-3002}"
