# 044 — SSH Hosts & Sessions

## Context

User works across multiple VPSes (CassinoAPI, Slot). Current `run_shell`
is Mac-local. Need remote-aware shell with host registry, parallel
fan-out, and persistent tmux sessions.

## Scope

- Parse `~/.ssh/config`, auto-register hosts into `ssh_hosts` table.
- Tools: `ssh_run(host, command)`, `ssh_run_parallel(hosts, command)`,
  `ssh_tmux_attach(host, session)`, `ssh_copy(src_host, src, dst_host, dst)`.
- Proxy all via Mac (SSH keys stay local).
- `host_profile` table with per-host metadata (docker path, stack,
  runbook bindings).
