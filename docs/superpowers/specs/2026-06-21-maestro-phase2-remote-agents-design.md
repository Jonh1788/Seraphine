# Maestro Phase 2 — Remote Agents over SSH — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Builds on:** Phase 1 (merged to `main`) — `docs/superpowers/specs/2026-06-21-maestro-agent-orchestration-design.md`

## Vision / scope

Extend Maestro so Seraphine can **spawn/control AND observe** Claude Code agents on **remote hosts over SSH**, reusing the Phase 1 supervisor almost unchanged. The remote `claude` runs on the host; its stream-json flows back through the SSH pipe.

**In scope (Phase 2):**
- Remote spawn + full control (stream, send turn, permissions, stop) — the agent runs on the remote, identical stream-json protocol.
- Remote observability — list + tail the remote host's `~/.claude/projects/*/*.jsonl` sessions.
- Host discovery from `~/.ssh/config` (+ ad-hoc `user@host`) with a preflight check.

**Out of scope (later):** remote handover (resume/fork of a remote session), multi-hop / jump-host, a remote agent-daemon mode.

## Approach (chosen)

**Shell out to the system `ssh`**, reusing the user's existing SSH config, keys, and agent. No new Rust dependency, no auth management in-app. (Rejected: the `ssh2` crate — manages auth itself, loses ssh-agent/config convenience; a remote agent-daemon — more infra.) Use SSH connection multiplexing (`ControlMaster=auto ControlPersist=60s`) so the many small observability calls are fast.

**Prerequisite (host responsibility):** the remote host must have the `claude` CLI installed and authenticated. Maestro surfaces this via the preflight check; it does not install/auth `claude` remotely.

## Architecture

The Phase 1 module `apps/seraphine/frontend/src-tauri/src/agents/` is extended; no new top-level structure.

### Host discovery (`src/agents/ssh.rs`, new)
- `maestro_list_hosts() -> Vec<String>`: parse `~/.ssh/config` for `Host` entries, excluding patterns containing `*`/`?`. Returns the alias names.
- `maestro_check_host(host) -> HostStatus`: run `ssh -o ConnectTimeout=8 -o BatchMode=yes -T <host> 'command -v claude && claude --version'`; returns `{ reachable: bool, claude_version: Option<String>, error: Option<String> }`. `BatchMode=yes` fails fast instead of prompting for a password.

### Remote spawn (extend `spawn_inner` in `mod.rs`)
- `spawn_inner` (and `maestro_spawn_agent`) gain an optional `host: Option<String>`.
- **Local** (host `None`): unchanged (Phase 1).
- **Remote** (host `Some(h)`): the launched command is
  `ssh -T [-o ControlMaster=auto -o ControlPersist=60s] <h> -- sh -lc 'cd <cwd> && exec claude -p --output-format stream-json --input-format stream-json --permission-mode default --permission-prompt-tool stdio --setting-sources "" --verbose [extra_args]'`
  - `-T` disables pseudo-TTY so stdin/stdout pipe cleanly.
  - `sh -lc 'cd <cwd> && exec claude …'` sets the REMOTE cwd (the agent's repo on the host) and replaces the shell with `claude` so signals/exit propagate.
  - `<cwd>` is shell-quoted to be injection-safe.
  - The `initialize` handshake + the goal user turn are written to the ssh process's stdin exactly as for a local agent (ssh forwards them to the remote `claude`).
- The `AgentHandle` records `host: Option<String>` (and the cwd is the REMOTE cwd). The reader thread, registry, event emission, permission policy/round-trip are **unchanged** — the stream-json over the ssh pipe is byte-identical to local.

### Remote observer (extend `observer.rs`)
- `maestro_list_remote_sessions(host) -> Vec<SessionInfo>`: `ssh <host> 'ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null'` to enumerate, then read each session's cwd via `ssh <host> 'head -n 20 <path>'` parsed for the top-level `cwd` (fallback de-slug). `SessionInfo` gains `host: Option<String>`.
- `maestro_read_transcript` gains an optional `host`: when set, `ssh <host> 'tail -n <N> <path>'` instead of local `read_to_string`. Both paths parse the returned lines as JSON.
- All ssh calls use the shared multiplexed connection (ControlMaster) for speed.

### UI (`src/orchestrator/`)
- **New-agent form:** a host selector — "Local" plus the `maestro_list_hosts()` aliases plus a free `user@host` field. On selecting a remote host, run `maestro_check_host` and show a status pill (reachable + claude version, or the error). `spawnAgent` passes the host.
- **Remote sessions:** a per-host section (or a host filter on the session list) populated by `maestro_list_remote_sessions`. Lazy-loaded per host (only when expanded/selected) to avoid blocking on unreachable hosts.
- **Tagging:** every agent row and session row shows a host badge — `Local` or `<host>` — so local vs remote is always clear. Reuse the Phase 1 owned/observed badge alongside it.
- Bridge (`api.ts`) gains `listHosts`, `checkHost`, `listRemoteSessions`, and the `host` arg on `spawnAgent`/`readTranscript`.

## Error handling
- ssh unreachable / auth fails → `maestro_check_host` returns `reachable:false` + the stderr; the UI blocks spawn with a clear message. `BatchMode=yes` prevents hangs on password prompts.
- `claude` missing on the remote → preflight `command -v claude` empty → "claude não encontrado no host" setup message.
- Connection drop mid-agent → the ssh pipe closes → reader hits EOF → `maestro:agent-exit` (agent marked `crashed`), same as a local crash.
- Remote observability on an unreachable host → return an empty list + surface the error per host (don't fail the whole view).
- `ControlPersist=60s` keeps a warm master so transient calls don't reconnect repeatedly; a dead master is re-established on the next call.

## Testing
- **`fake_ssh.sh`** harness: a script that stands in for `ssh` — ignores connection flags/host, strips to the trailing command, and (for the agent path) execs the Phase 1 `fake_agent.sh` with a fixture; (for observability) emits canned `ls`/`tail` output. Point the supervisor at it via `MAESTRO_SSH_BIN`. This exercises the remote spawn + remote observer code paths with NO real ssh or API.
- Rust unit tests: `~/.ssh/config` parser (Host extraction, wildcard exclusion); remote-command construction (correct `ssh -T … sh -lc 'cd … && exec claude …'` with safe quoting).
- Frontend: host-selector + remote-session rendering with mocked bridge.

## Security notes
- Remote commands are constructed by Maestro with shell-quoted cwd; the goal/turns go over the stream-json stdin channel (not the shell command line), avoiding command injection via the goal.
- SSH auth is entirely the user's existing setup (keys/agent/config) — Maestro adds no credentials and stores none.
- The remote agent runs with the remote user's privileges; the same permission policy (ask/auto-reads/full-auto) governs its tool use over the identical stream-json control channel.

## Open items to pin during planning
1. Exact `ssh` multiplexing flags that work cleanly with a long-lived piped agent (ControlMaster + a streaming child) — validate that the agent's pipe isn't torn down by ControlPersist expiry while the agent is alive (likely needs the agent's own connection to NOT be the shared master, or a long ControlPersist).
2. Whether `sh -lc` vs `sh -c` is needed for `claude` to be on PATH on the remote (login shell loads PATH); confirm against the real host (CassinoAPI).
3. The `~/.ssh/config` parse edge cases (Include directives, Match blocks) — Phase 2 handles plain top-level `Host` lines; document the limitation.
