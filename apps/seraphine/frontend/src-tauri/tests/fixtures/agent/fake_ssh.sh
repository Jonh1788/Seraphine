#!/usr/bin/env bash
# Stands in for `ssh` in tests. Ignores all ssh flags + the host, and replays
# the basic_run fixture via fake_agent.sh — exercising the remote spawn path
# without a real ssh or claude.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
exec "$dir/fake_agent.sh" "$dir/basic_run.jsonl"
