#!/usr/bin/env bash
# Replays a captured stream-json fixture as if it were `claude`.
# Usage: fake_agent.sh <fixture.jsonl> [--wait-stdin-after <N>]
# With --wait-stdin-after N, emits the first N lines, then blocks until
# one line arrives on stdin, then emits the rest (simulates a permission
# round-trip). Without it, emits all lines and exits 0.
set -euo pipefail
fixture="$1"; shift || true
wait_after=""
[ "${1:-}" = "--wait-stdin-after" ] && wait_after="$2"
i=0
# Read the fixture on FD 3 so the `read _ans` below blocks on the script's
# real stdin (FD 0 = the supervisor's permission response), instead of
# consuming the next fixture line.
while IFS= read -r line <&3; do
  i=$((i+1))
  printf '%s\n' "$line"
  if [ -n "$wait_after" ] && [ "$i" = "$wait_after" ]; then
    IFS= read -r _ans   # block for one stdin line (the permission response)
  fi
done 3< "$fixture"
