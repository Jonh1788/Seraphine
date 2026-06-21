# Maestro — Agent Orchestration (Mac-local) — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Scope of this spec:** Phase 1 (the foundation). Phases 2–3 are sketched as the north star, not specified here.

## Vision / north star

Give Seraphine the ability to **observe and orchestrate Claude Code instances** running on the user's Mac. The eventual goal is **self-recursive improvement**: Seraphine launches and supervises Claude Code agents that build and improve her own codebase, under guardrails.

This subsystem runs **Mac-local** — inside the Tauri app's Rust core on the user's machine — **not** on the VPS backend (`sera.jonhdev.io`). It uses the local `claude` CLI (installed at `/Users/jonh1788/.local/bin/claude`).

Internal name: **Maestro** (provisional).

## Core model (aligned with the user)

- **Owned agents — full control.** Agents Seraphine launches are driven through the Claude Code **headless stream-json protocol**: she owns their stdin/stdout, can send turns, and can approve/deny tool-use (permission) requests on the user's behalf.
- **Observe everything — read-only.** Seraphine sees **all** `claude` sessions on the machine, including ones the user started in their own terminals, by listing processes (`pgrep claude`) and tailing the session transcript files (`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`). She does **not** type into terminals she didn't open.
- **Directed handover.** The user can point Seraphine at any observed session with a goal ("cuide dessa sessão, o objetivo é X"). Seraphine takes it over by spawning an **owned** agent — either **Resume** (`claude --resume <id>`, original paused/closed to avoid conflict) or **Fork** (a new owned agent seeded with the transcript + goal; original untouched). The UI offers **both per session; the user picks each time.**
- **Permission policy** is how "responding on my behalf when I authorize" works (see §4).

## Chosen approach: A — Rust drives the headless Claude CLI

The Tauri **Rust** core spawns and supervises `claude` processes directly via `std::process::Command` / `tokio::process` (reusing the existing `src-tauri/src/mac_tools.rs` pattern), using:

```
claude --print --output-format stream-json --input-format stream-json [--resume <session-id>] [--permission-mode <mode>] ...
```

Rust reads the agent's stdout JSON event stream → forwards to the React webview via Tauri events; Rust writes JSON to the agent's stdin for new turns and permission responses. No Node runtime / sidecar is added (rejected approach B). Observability (transcript tailing) is included for free (folded-in approach C).

> The Claude **Agent SDK** is essentially a wrapper over this same headless transport; driving the CLI directly from Rust is the most native fit for a Tauri/Rust app and avoids bundling Node.

## Architecture (Phase 1 components)

### Rust — Agent Supervisor (`src-tauri/src/agents/`)
`#[tauri::command]` functions, registered in `lib.rs::invoke_handler`:
- `list_sessions()` → observed + owned sessions with metadata.
- `spawn_agent({ cwd, goal, permission_mode })` → start an owned headless agent.
- `send_to_agent({ agent_id, text })` → send a user turn.
- `respond_permission({ agent_id, request_id, allow })` → approve/deny a pending tool-use.
- `stop_agent({ agent_id })`.
- `resume_session({ session_id, goal, permission_mode })` / `fork_session({ session_id, goal, permission_mode })` → handover.

Internals: a registry (`agent_id` → { pid, session_id, cwd, status, stdin handle, child }). Each owned agent gets a tokio task reading its stdout, parsing stream-json events, and emitting Tauri events to the webview (`maestro://agent/<id>/event`). Status enum: `running | waiting_permission | idle | done | crashed`.

### Rust — Observer (read-only)
- Poll `pgrep -fl claude` to enumerate running `claude` PIDs, their cwd and start time.
- Watch `~/.claude/projects/<cwd-slug>/*.jsonl` (file-watcher) to surface each session's activity (messages, tool calls) regardless of who started it.
- Correlate PID ↔ session id ↔ cwd. Emit the session list + transcript deltas to the UI.

### React — Maestro dashboard (`src/orchestrator/`)
New nav-rail view. Reuses the Obsidian `obs-*` layer.
- **Session list:** owned + observed sessions; each shows status, cwd, and current activity (last transcript event). Owned vs observed clearly distinguished.
- **Detail panel:** live event stream for the selected agent (assistant text, tool calls, results); controls — send message, approve/deny a pending permission, stop.
- **New agent:** pick a repo/cwd + write a goal + choose permission mode → `spawn_agent`.
- **Handover ("Cuidar desta"):** on an observed session → choose **Resume** or **Fork** + a goal → `resume_session`/`fork_session`.
- **Permission-mode selector** per agent.

### Seraphine's brain (Phase 1 scope)
Decisions (goals, borderline approvals, what to tell an agent) are **user-driven** in Phase 1, with simple policy rules for auto-approval. An LLM-driven "Seraphine decides" mode and full autonomy are deferred to Phase 3.

## 4. Permission policy ("responding on my behalf")

Per agent/session, the user selects a mode:
- **Perguntar tudo** — every tool-use escalates to the user.
- **Auto-aprovar leituras** — read-only ops (read/ls/grep/etc.) auto-approved; writes/shell escalate.
- **Autonomia total** — auto-approve everything (use with care).
- *(future, Phase 3)* **Seraphine decide** — her LLM adjudicates borderline requests.

Destructive operations default to **ask**. When a request escalates, the UI surfaces it; the user approves/denies → `respond_permission` writes the decision back to the agent's stdin. The exact headless permission transport (CLI `--permission-mode` / `--permission-prompt-tool` MCP tool vs. the stream-json `control_request`/`can_use_tool` messages) is **pinned during the implementation plan**, validated against the installed `claude` version.

## 5. Scope — Phase 1

**In:** observability of all sessions (process list + transcript tail); spawn + control of owned headless agents (stream, send turn, stop); permission policy + approval UI; handover (Resume/Fork). **Mac-local only.**

**Out (YAGNI now):**
- **Phase 2:** remote agents over SSH (`ssh <host> claude ...`, same supervisor protocol).
- **Phase 3 (north star):** autonomous self-improvement loop — Seraphine launches agents against her own repo with strong guardrails (worktree/sandbox isolation + review gates), plus optional "Seraphine decides" permission mode.
- Manager→worker recursion and DAG pipelines (revisit in 2/3).

## 6. Error handling

- Agent crash/non-zero exit → mark `crashed`, surface exit code + last output.
- `claude` missing or incompatible version → detect at startup; show a clear setup error.
- Permission request timeout → default **deny** + notify.
- Resume conflict (original session still live) → **Resume** pauses/closes the original with a user warning; **Fork** avoids the conflict entirely.
- Malformed transcript / stream-json lines → skip the line, keep going.

## 7. Testing

- **Fake-agent harness:** a shell script that emits canned stream-json on stdout and reads stdin — lets us test the Rust supervisor (spawn, parse, send, permission round-trip, stop) and the React dashboard **without** real API calls or cost.
- Rust unit tests: registry lifecycle, stream-json parsing, permission decision policy.
- Frontend: dashboard component tests with mocked Tauri events.

## 8. Security / guardrails

This subsystem runs arbitrary code with the user's privileges. Guardrails:
- Destructive ops default to **ask**; **Autonomia total** is opt-in per session.
- Phase 3 self-improvement requires isolation (git worktree/sandbox) + a review gate before changes land.
- Agents inherit the user's environment; no new privilege escalation is introduced beyond what `claude` already has locally.

## Open items to pin during planning

1. Exact headless permission transport for the installed `claude` version (flags vs. stream control messages).
2. Transcript path/slug encoding for `~/.claude/projects/` (derive and verify against a live session).
3. Resume semantics: does `--resume <id>` reliably continue a session started by another process, and how to safely pause/close the original.
