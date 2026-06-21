# Maestro — Agent Orchestration (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Seraphine (Tauri/Rust on the Mac) observe every local Claude Code session and spawn/control her own headless agents, with a permission policy and resume/fork handover, surfaced in a React dashboard.

**Architecture:** The Tauri Rust core drives `claude` headless processes over the bidirectional stream-json protocol (`-p --output-format stream-json --input-format stream-json`), keeps a registry of owned agents, and emits their events to the webview via `tauri::Emitter`. A read-only observer enumerates all sessions (`pgrep` + `~/.claude/projects/*/*.jsonl`). A React view (`src/orchestrator/`) renders the fleet and controls. A fake-agent shell harness replays captured real fixtures so the supervisor is testable with no API cost.

**Tech Stack:** Rust (std `process::Command` + threads, `serde_json`, `tauri::{AppHandle, Emitter, Manager}`), Tauri 2, React/TS (`@tauri-apps/api/core` `invoke`, `@tauri-apps/api/event` `listen`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-21-maestro-agent-orchestration-design.md`

**Conventions (verified in repo):**
- Rust commands: `#[tauri::command] pub fn name(...) -> Result<T, String>`, desktop-gated, registered in `src-tauri/src/lib.rs` desktop `invoke_handler`. Events: `use tauri::Emitter; app.emit("evt", payload)` (see `src-tauri/src/mic.rs`).
- Frontend: `invoke` from `@tauri-apps/api/core`; `listen` + `UnlistenFn` from `@tauri-apps/api/event` (see `src/audio/tauriVpio.ts`). New views: add to `ActiveView` union (`src/stores/uiStore.ts:3`), a nav item + render branch in `src/AppLayout.tsx`, reuse the global `obs-*` layer + a per-feature `src/orchestrator/obsidian.css`.
- Transcript path: `~/.claude/projects/<slug>/<session-id>.jsonl`, where `<slug>` is the absolute cwd with every `/` replaced by `-` (e.g. `/Users/jonh1788/Dev/Ars-Animus` → `-Users-jonh1788-Dev-Ars-Animus`).
- Tauri config: this build runs against the prod backend; nothing here touches the VPS.

---

## Milestone 0 — Fixtures & fake-agent harness (TDD foundation)

Capture the *real* claude stream-json shapes once, then replay them in tests so the supervisor is exercised without API cost. Resolves spec open-items #1–#3 empirically.

### Task 0.1: Capture real stream-json fixtures

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/tests/fixtures/agent/basic_run.jsonl`
- Create: `apps/seraphine/frontend/src-tauri/tests/fixtures/agent/permission_request.jsonl`
- Create: `apps/seraphine/frontend/src-tauri/tests/fixtures/agent/README.md`

- [ ] **Step 1: Capture a basic non-permission run** (manual, one-time)

Run in a throwaway dir (real API call, tiny):
```bash
cd "$(mktemp -d)" && git init -q
claude -p --output-format stream-json --input-format stream-json --verbose \
  <<< '{"type":"user","message":{"role":"user","content":"Reply with exactly: pong"}}' \
  > basic_run.jsonl
cat basic_run.jsonl
```
Copy the file to `src-tauri/tests/fixtures/agent/basic_run.jsonl`.

- [ ] **Step 2: Capture a permission request**

Run a prompt that forces a tool/permission under `default` mode:
```bash
cd "$(mktemp -d)" && git init -q
claude -p --output-format stream-json --input-format stream-json --permission-mode default --verbose \
  <<< '{"type":"user","message":{"role":"user","content":"Create a file notes.txt containing hello"}}' \
  > permission_request.jsonl
cat permission_request.jsonl
```
Copy to `src-tauri/tests/fixtures/agent/permission_request.jsonl`.

- [ ] **Step 3: Document the observed shapes**

In `README.md`, record (from the captured files) the exact JSON for: the `system/init` line, an `assistant` message line, the `result` line, and the permission/`control_request` line (note its `type`, `subtype`, `request_id` field name, and tool name location). This is the source of truth for the parser in M1/M2.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/tests/fixtures/agent/
git commit -m "test(maestro): capture real claude stream-json fixtures"
```

### Task 0.2: Fake-agent replay script

A script that replays a fixture line-by-line on stdout (so tests don't call the API), and—when given a `--interactive` flag—waits for one stdin line before emitting the post-permission lines.

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_agent.sh`

- [ ] **Step 1: Write the script**

```bash
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
while IFS= read -r line; do
  i=$((i+1))
  printf '%s\n' "$line"
  if [ -n "$wait_after" ] && [ "$i" = "$wait_after" ]; then
    IFS= read -r _ans   # block for one stdin line (the permission response)
  fi
done < "$fixture"
```

- [ ] **Step 2: Make it executable + smoke-test**

```bash
chmod +x apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_agent.sh
apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_agent.sh \
  apps/seraphine/frontend/src-tauri/tests/fixtures/agent/basic_run.jsonl | head -2
```
Expected: prints the first two fixture lines.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_agent.sh
git commit -m "test(maestro): fake-agent replay harness"
```

---

## Milestone 1 — Rust supervisor core (spawn, stream, registry, stop)

New module `src-tauri/src/agents/`. The agent binary path is configurable so tests point it at `fake_agent.sh`.

### Task 1.1: Module skeleton + event/struct types

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`
- Create: `apps/seraphine/frontend/src-tauri/src/agents/proto.rs`
- Modify: `apps/seraphine/frontend/src-tauri/src/lib.rs` (add `mod agents;` near other `mod` decls)

- [ ] **Step 1: Write `proto.rs` (parse one stream-json line into a tagged event)**

```rust
//! Parsing of claude's --output-format stream-json lines into events the
//! frontend consumes. We forward the raw JSON and tag the kinds we act on.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEventKind {
    Init { session_id: Option<String> },
    Assistant,
    Result,
    PermissionRequest { request_id: String, tool: String },
    Other,
}

/// Classify a parsed stream-json line. `request_id`/tool extraction follows
/// the shapes recorded in tests/fixtures/agent/README.md (Task 0.1 Step 3).
pub fn classify(v: &Value) -> AgentEventKind {
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            AgentEventKind::Init {
                session_id: v.get("session_id").and_then(Value::as_str).map(String::from),
            }
        }
        Some("assistant") => AgentEventKind::Assistant,
        Some("result") => AgentEventKind::Result,
        Some("control_request") => {
            let req = v.get("request") .unwrap_or(v);
            let request_id = v.get("request_id").and_then(Value::as_str)
                .or_else(|| req.get("request_id").and_then(Value::as_str))
                .unwrap_or("").to_string();
            let tool = req.get("tool_name").and_then(Value::as_str)
                .or_else(|| req.get("name").and_then(Value::as_str))
                .unwrap_or("").to_string();
            AgentEventKind::PermissionRequest { request_id, tool }
        }
        _ => AgentEventKind::Other,
    }
}
```

> If Task 0.1 Step 3 recorded different field names/paths for the permission line, adjust the `control_request` arm to match the captured shape before moving on.

- [ ] **Step 2: Write the failing test for `classify`**

In `proto.rs`, append:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_init_and_assistant_and_permission() {
        assert_eq!(
            classify(&json!({"type":"system","subtype":"init","session_id":"abc"})),
            AgentEventKind::Init { session_id: Some("abc".into()) }
        );
        assert_eq!(classify(&json!({"type":"assistant","message":{}})), AgentEventKind::Assistant);
        let perm = classify(&json!({"type":"control_request","request_id":"r1","request":{"tool_name":"Write"}}));
        assert_eq!(perm, AgentEventKind::PermissionRequest { request_id: "r1".into(), tool: "Write".into() });
    }
}
```

- [ ] **Step 3: Run it (fails until module compiles)**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::proto 2>&1 | tail -5`
Expected: compile error (`agents` not declared) — add `mod agents;` to `lib.rs` and `pub mod proto;` to `agents/mod.rs` (Step 4), then it should pass.

- [ ] **Step 4: Wire the module**

`agents/mod.rs`:
```rust
#![cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod proto;
```
`lib.rs`: add `mod agents;` beside the other top-level `mod` declarations.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::proto -- --nocapture 2>&1 | tail -8`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/ apps/seraphine/frontend/src-tauri/src/lib.rs
git commit -m "feat(maestro): stream-json event classifier"
```

### Task 1.2: Registry + spawn + stream-to-event + stop

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Add the registry, spawn, stop, and a configurable binary**

```rust
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::agents::proto::{classify, AgentEventKind};

struct AgentHandle { child: Child, stdin: Option<ChildStdin>, session_id: Option<String>, cwd: String }
static REGISTRY: OnceLock<Mutex<HashMap<String, AgentHandle>>> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(1);
fn registry() -> &'static Mutex<HashMap<String, AgentHandle>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Binary used to launch agents. Overridable for tests via env.
fn claude_bin() -> String { std::env::var("MAESTRO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()) }

#[derive(Serialize, Clone)]
struct AgentEvent { agent_id: String, kind: AgentEventKind, raw: Value }

/// Spawn an owned headless agent. `extra_args` lets resume/fork reuse this.
fn spawn_inner(app: &AppHandle, cwd: &str, goal: &str, permission_mode: &str, extra_args: &[String]) -> Result<String, String> {
    let agent_id = format!("agent-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
    let mut cmd = Command::new(claude_bin());
    // In tests MAESTRO_CLAUDE_BIN points at fake_agent.sh which takes a fixture path.
    if claude_bin().ends_with(".sh") {
        cmd.arg(std::env::var("MAESTRO_FAKE_FIXTURE").unwrap_or_default());
    } else {
        cmd.args(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
                  "--permission-mode", permission_mode]);
        for a in extra_args { cmd.arg(a); }
    }
    cmd.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    // Seed the goal as the first stream-json user message (real claude only).
    if !claude_bin().ends_with(".sh") {
        if let Some(si) = child.stdin.as_mut() {
            let msg = serde_json::json!({"type":"user","message":{"role":"user","content":goal}});
            let _ = writeln!(si, "{}", msg);
        }
    }
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    // Reader thread → emit events.
    let app2 = app.clone();
    let id2 = agent_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            let v: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
            let kind = classify(&v);
            let _ = app2.emit("maestro:agent-event", AgentEvent { agent_id: id2.clone(), kind, raw: v });
        }
        let _ = app2.emit("maestro:agent-exit", id2.clone());
    });
    registry().lock().unwrap().insert(agent_id.clone(),
        AgentHandle { child, stdin, session_id: None, cwd: cwd.to_string() });
    Ok(agent_id)
}

#[tauri::command]
pub fn maestro_spawn_agent(app: AppHandle, cwd: String, goal: String, permission_mode: String) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, &[])
}

#[tauri::command]
pub fn maestro_stop_agent(agent_id: String) -> Result<(), String> {
    if let Some(mut h) = registry().lock().unwrap().remove(&agent_id) {
        let _ = h.child.kill();
    }
    Ok(())
}
```

- [ ] **Step 2: Write the failing integration test (uses the fake agent)**

Create `apps/seraphine/frontend/src-tauri/tests/supervisor.rs`:
```rust
// Integration: spawn the fake agent, assert it streams a parseable result line.
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn fake_agent_streams_lines() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let mut c = Command::new(format!("{dir}/tests/fixtures/agent/fake_agent.sh"))
        .arg(format!("{dir}/tests/fixtures/agent/basic_run.jsonl"))
        .stdout(Stdio::piped()).spawn().unwrap();
    let out = c.stdout.take().unwrap();
    let lines: Vec<String> = BufReader::new(out).lines().map_while(Result::ok).collect();
    c.wait().unwrap();
    assert!(lines.iter().any(|l| l.contains("\"type\":\"result\"")), "expected a result line");
}
```

- [ ] **Step 3: Run it to verify it fails, then passes**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test --test supervisor 2>&1 | tail -8`
Expected: PASS (this validates the harness; it fails only if `basic_run.jsonl` lacks a `result` line — fix the fixture).

- [ ] **Step 4: Compile-check the new commands**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -15`
Expected: builds (commands not yet registered is fine).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs apps/seraphine/frontend/src-tauri/tests/supervisor.rs
git commit -m "feat(maestro): agent registry, spawn, stop, stream→event"
```

### Task 1.3: `maestro_send_to_agent`

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Implement**

```rust
#[tauri::command]
pub fn maestro_send_to_agent(agent_id: String, text: String) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let h = reg.get_mut(&agent_id).ok_or("unknown agent")?;
    let si = h.stdin.as_mut().ok_or("agent stdin closed")?;
    let msg = serde_json::json!({"type":"user","message":{"role":"user","content":text}});
    writeln!(si, "{}", msg).map_err(|e| format!("write failed: {e}"))?;
    si.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): send user turn to agent stdin"
```

---

## Milestone 2 — Permission round-trip + policy

### Task 2.1: Permission policy decision (pure, TDD)

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/src/agents/policy.rs`
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs` (add `pub mod policy;`)

- [ ] **Step 1: Write the failing test**

Create `policy.rs`:
```rust
//! Permission policy: given a mode and a tool name, decide auto-allow,
//! auto-deny, or escalate-to-user.
#[derive(Debug, PartialEq)]
pub enum Decision { Allow, Deny, Escalate }

#[derive(Clone, Copy)]
pub enum Mode { AskAll, AutoReads, FullAuto }

const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead"];

pub fn decide(mode: Mode, tool: &str) -> Decision {
    match mode {
        Mode::FullAuto => Decision::Allow,
        Mode::AskAll => Decision::Escalate,
        Mode::AutoReads => if READ_TOOLS.contains(&tool) { Decision::Allow } else { Decision::Escalate },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_behave() {
        assert_eq!(decide(Mode::FullAuto, "Bash"), Decision::Allow);
        assert_eq!(decide(Mode::AskAll, "Read"), Decision::Escalate);
        assert_eq!(decide(Mode::AutoReads, "Read"), Decision::Allow);
        assert_eq!(decide(Mode::AutoReads, "Write"), Decision::Escalate);
    }
}
```

- [ ] **Step 2: Run it**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::policy 2>&1 | tail -6`
Expected: PASS after adding `pub mod policy;` to `agents/mod.rs`.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/policy.rs apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): permission policy decision"
```

### Task 2.2: `maestro_respond_permission` + auto-decision in the reader thread

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Store the agent's mode + a `respond_permission` command**

In `AgentHandle` add `mode: policy::Mode` (set from the `permission_mode` string in `spawn_inner` via a `parse_mode` helper). Add:
```rust
fn parse_mode(s: &str) -> policy::Mode {
    match s { "full_auto" | "bypassPermissions" => policy::Mode::FullAuto,
              "auto_reads" => policy::Mode::AutoReads, _ => policy::Mode::AskAll }
}

fn write_permission_response(si: &mut ChildStdin, request_id: &str, allow: bool) -> Result<(), String> {
    // control_response shape per tests/fixtures/agent/README.md (Task 0.1).
    let resp = serde_json::json!({
        "type":"control_response",
        "response":{"request_id":request_id,"subtype": if allow {"success"} else {"error"},
                    "allow": allow}
    });
    writeln!(si, "{}", resp).map_err(|e| format!("write failed: {e}"))?;
    si.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn maestro_respond_permission(agent_id: String, request_id: String, allow: bool) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let h = reg.get_mut(&agent_id).ok_or("unknown agent")?;
    let si = h.stdin.as_mut().ok_or("agent stdin closed")?;
    write_permission_response(si, &request_id, allow)
}
```

> Adjust `write_permission_response`'s JSON to the exact `control_response` shape recorded in Task 0.1 Step 3 before testing against real claude.

- [ ] **Step 2: Auto-respond in the reader thread for non-escalated decisions**

In the reader thread, when `kind` is `PermissionRequest { request_id, tool }`, look up the agent's `mode`, call `policy::decide`; on `Allow`/`Deny` write the response immediately (re-lock registry to get stdin); on `Escalate` just emit the event (the UI handles it). Emit the event in all cases so the UI shows what happened.

- [ ] **Step 3: Build**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): permission response + auto-decision by policy"
```

---

## Milestone 3 — Observer (read-only, all sessions)

### Task 3.1: Transcript slug + session listing (TDD on the pure parts)

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/src/agents/observer.rs`
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs` (`pub mod observer;`)

- [ ] **Step 1: Write the slug helper + test**

```rust
use std::path::PathBuf;
use serde::Serialize;

/// `~/.claude/projects/<slug>/` for a given absolute cwd: every `/` → `-`.
pub fn project_slug(cwd: &str) -> String { cwd.replace('/', "-") }

pub fn projects_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".claude/projects")
}

#[derive(Serialize, Clone)]
pub struct SessionInfo { pub session_id: String, pub cwd: String, pub last_modified_ms: u64 }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slug_replaces_slashes() {
        assert_eq!(project_slug("/Users/x/Dev/Ars-Animus"), "-Users-x-Dev-Ars-Animus");
    }
}
```

- [ ] **Step 2: Run the test**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::observer 2>&1 | tail -6`
Expected: PASS after registering the module.

- [ ] **Step 3: Implement `maestro_list_sessions`** (scan `projects_dir()`, list `*.jsonl` with mtime; cwd recovered by reversing the slug of the parent dir — read the first transcript line's `cwd` field when present, else fall back to de-slugging)

```rust
#[tauri::command]
pub fn maestro_list_sessions() -> Result<Vec<SessionInfo>, String> {
    let mut out = Vec::new();
    let base = projects_dir();
    let entries = match std::fs::read_dir(&base) { Ok(e) => e, Err(_) => return Ok(out) };
    for proj in entries.flatten() {
        let p = proj.path();
        if !p.is_dir() { continue; }
        let cwd = p.file_name().and_then(|s| s.to_str()).unwrap_or("").replacen('-', "/", 1).replace('-', "/");
        if let Ok(files) = std::fs::read_dir(&p) {
            for f in files.flatten() {
                let fp = f.path();
                if fp.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
                let session_id = fp.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                let last_modified_ms = f.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64).unwrap_or(0);
                out.push(SessionInfo { session_id, cwd: cwd.clone(), last_modified_ms });
            }
        }
    }
    out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    Ok(out)
}
```

> NOTE: de-slugging `-` → `/` is lossy when real path segments contain `-`. Prefer reading the `cwd` field from the transcript's first JSON line; the de-slug is only a fallback. Add that read in Step 3 if the fixture confirms a `cwd` field exists.

- [ ] **Step 4: Build + commit**

```bash
cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5
git add apps/seraphine/frontend/src-tauri/src/agents/observer.rs apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): list sessions from transcript dir"
```

### Task 3.2: Tail a transcript → events

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/observer.rs`

- [ ] **Step 1: Implement `maestro_read_transcript`** (read the last N lines of a session's `.jsonl`, return parsed `Value`s) — used by the UI to render any observed session.

```rust
#[tauri::command]
pub fn maestro_read_transcript(slug: String, session_id: String, tail: usize) -> Result<Vec<serde_json::Value>, String> {
    let path = projects_dir().join(&slug).join(format!("{session_id}.jsonl"));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > tail { lines = lines.split_off(lines.len() - tail); }
    Ok(lines.iter().filter_map(|l| serde_json::from_str(l).ok()).collect())
}
```

- [ ] **Step 2: Build + commit**

```bash
cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5
git add apps/seraphine/frontend/src-tauri/src/agents/observer.rs
git commit -m "feat(maestro): read transcript tail for any session"
```

---

## Milestone 4 — Handover (resume / fork)

### Task 4.1: `maestro_resume_session` + `maestro_fork_session`

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Implement using `spawn_inner` + extra args**

```rust
#[tauri::command]
pub fn maestro_resume_session(app: AppHandle, session_id: String, cwd: String, goal: String, permission_mode: String) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, &["--resume".into(), session_id])
}

#[tauri::command]
pub fn maestro_fork_session(app: AppHandle, session_id: String, cwd: String, goal: String, permission_mode: String) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, &["--resume".into(), session_id, "--fork-session".into()])
}
```

- [ ] **Step 2: Build + commit**

```bash
cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): resume + fork session handover"
```

---

## Milestone 5 — Register commands + frontend bridge

### Task 5.1: Register all commands in `lib.rs`

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/lib.rs` (desktop `invoke_handler` only — these are desktop-gated)

- [ ] **Step 1: Add to the desktop `tauri::generate_handler![ ... ]`**

```rust
            agents::maestro_list_sessions,
            agents::maestro_read_transcript,
            agents::maestro_spawn_agent,
            agents::maestro_send_to_agent,
            agents::maestro_respond_permission,
            agents::maestro_stop_agent,
            agents::maestro_resume_session,
            agents::maestro_fork_session,
```
(Re-export the command fns from `agents/mod.rs` with `pub use` so `agents::name` resolves, or reference `agents::mod_path::name`.)

- [ ] **Step 2: Build the whole app**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -10`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/lib.rs apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): register agent commands"
```

### Task 5.2: TS bridge (`src/orchestrator/api.ts`)

**Files:**
- Create: `apps/seraphine/frontend/src/orchestrator/api.ts`
- Create: `apps/seraphine/frontend/src/orchestrator/types.ts`

- [ ] **Step 1: Types**

```ts
export type PermissionMode = 'ask_all' | 'auto_reads' | 'full_auto';
export interface SessionInfo { session_id: string; cwd: string; last_modified_ms: number; }
export type AgentEventKind =
  | { kind: 'init'; session_id?: string }
  | { kind: 'assistant' }
  | { kind: 'result' }
  | { kind: 'permission_request'; request_id: string; tool: string }
  | { kind: 'other' };
export interface AgentEvent { agent_id: string; kind: AgentEventKind; raw: unknown; }
```

- [ ] **Step 2: Bridge**

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionInfo, AgentEvent, PermissionMode } from './types';

export const listSessions = () => invoke<SessionInfo[]>('maestro_list_sessions');
export const readTranscript = (slug: string, sessionId: string, tail = 200) =>
  invoke<unknown[]>('maestro_read_transcript', { slug, sessionId, tail });
export const spawnAgent = (cwd: string, goal: string, permissionMode: PermissionMode) =>
  invoke<string>('maestro_spawn_agent', { cwd, goal, permissionMode });
export const sendToAgent = (agentId: string, text: string) =>
  invoke('maestro_send_to_agent', { agentId, text });
export const respondPermission = (agentId: string, requestId: string, allow: boolean) =>
  invoke('maestro_respond_permission', { agentId, requestId, allow });
export const stopAgent = (agentId: string) => invoke('maestro_stop_agent', { agentId });
export const resumeSession = (sessionId: string, cwd: string, goal: string, m: PermissionMode) =>
  invoke<string>('maestro_resume_session', { sessionId, cwd, goal, permissionMode: m });
export const forkSession = (sessionId: string, cwd: string, goal: string, m: PermissionMode) =>
  invoke<string>('maestro_fork_session', { sessionId, cwd, goal, permissionMode: m });
export const onAgentEvent = (cb: (e: AgentEvent) => void): Promise<UnlistenFn> =>
  listen<AgentEvent>('maestro:agent-event', (ev) => cb(ev.payload));
export const onAgentExit = (cb: (agentId: string) => void): Promise<UnlistenFn> =>
  listen<string>('maestro:agent-exit', (ev) => cb(ev.payload));
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/seraphine/frontend && npx tsc -b 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/orchestrator/
git commit -m "feat(maestro): frontend bridge to agent commands"
```

---

## Milestone 6 — React dashboard + nav wiring

### Task 6.1: Add the `maestro` view to nav + layout

**Files:**
- Modify: `apps/seraphine/frontend/src/stores/uiStore.ts:3` (add `'maestro'` to the `ActiveView` union)
- Modify: `apps/seraphine/frontend/src/AppLayout.tsx` (nav item + render branch + import)
- Create: `apps/seraphine/frontend/src/orchestrator/MaestroView.tsx`
- Create: `apps/seraphine/frontend/src/orchestrator/index.ts`
- Create: `apps/seraphine/frontend/src/orchestrator/obsidian.css`

- [ ] **Step 1: Add `'maestro'` to `ActiveView`**

In `uiStore.ts`, append `| 'maestro'` to the union at line 3.

- [ ] **Step 2: Minimal view that lists sessions (proves the pipe end-to-end)**

`MaestroView.tsx`:
```tsx
import './obsidian.css';
import { useEffect, useState } from 'react';
import { listSessions } from './api';
import type { SessionInfo } from './types';

export function MaestroView({ onBack }: { onBack: () => void }): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  useEffect(() => { void listSessions().then(setSessions).catch(() => {}); }, []);
  return (
    <div className="obs-screen maestro">
      <div className="obs-screen__header">
        <div className="obs-screen__titles">
          <h1 className="obs-screen__title">Maestro</h1>
          <div className="obs-screen__sub">{sessions.length} sessões Claude Code</div>
        </div>
      </div>
      <div className="obs-screen__body">
        {sessions.map((s) => (
          <div key={s.cwd + s.session_id} className="obs-card maestro__row">
            <div className="maestro__cwd">{s.cwd}</div>
            <div className="maestro__sid">{s.session_id.slice(0, 8)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```
`index.ts`: `export { MaestroView } from './MaestroView';`
`obsidian.css`: `.maestro__row{display:flex;justify-content:space-between;align-items:center}.maestro__cwd{font-size:13px;color:var(--text)}.maestro__sid{font-size:11px;color:var(--text-faint);font-family:"SF Mono",monospace}`

- [ ] **Step 3: Wire into AppLayout** — import `MaestroView`, add a nav item (reuse an icon, e.g. `FlaskIcon` or a new inline svg) calling `setActiveView('maestro')`, and a render branch `{activeView === 'maestro' && <MaestroView onBack={() => setActiveView('chat')} />}` inside the `ViewTransition`.

- [ ] **Step 4: Build**

Run: `cd apps/seraphine/frontend && npm run build 2>&1 | tail -4`
Expected: `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/stores/uiStore.ts apps/seraphine/frontend/src/AppLayout.tsx apps/seraphine/frontend/src/orchestrator/
git commit -m "feat(maestro): dashboard view + nav wiring (session list)"
```

### Task 6.2: Agent detail + live stream + controls

**Files:**
- Modify: `apps/seraphine/frontend/src/orchestrator/MaestroView.tsx`
- Create: `apps/seraphine/frontend/src/orchestrator/useAgentStream.ts`

- [ ] **Step 1: `useAgentStream` hook** — subscribes via `onAgentEvent`/`onAgentExit`, accumulates events per `agent_id`, exposes `events` and the latest `pendingPermission` (a `permission_request` not yet answered). Unsubscribe on unmount.

```ts
import { useEffect, useRef, useState } from 'react';
import { onAgentEvent, onAgentExit } from './api';
import type { AgentEvent } from './types';

export function useAgentStream() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const unsub = useRef<Array<() => void>>([]);
  useEffect(() => {
    let live = true;
    onAgentEvent((e) => live && setEvents((p) => [...p, e])).then((u) => unsub.current.push(u));
    onAgentExit((id) => live && setEvents((p) => [...p, { agent_id: id, kind: { kind: 'other' }, raw: { exit: true } }]))
      .then((u) => unsub.current.push(u));
    return () => { live = false; unsub.current.forEach((u) => u()); unsub.current = []; };
  }, []);
  return events;
}
```

- [ ] **Step 2: Render a detail panel** for the selected agent: stream of events (assistant text from `raw`, tool calls), a "Novo agente" form (cwd + goal + permission mode → `spawnAgent`), a stop button, and—when an event is `permission_request` without a later response—Approve/Deny buttons calling `respondPermission`.

- [ ] **Step 3: Build + commit**

```bash
cd apps/seraphine/frontend && npm run build 2>&1 | tail -3
git add apps/seraphine/frontend/src/orchestrator/
git commit -m "feat(maestro): live agent stream + spawn/stop/permission controls"
```

### Task 6.3: Handover UI (Resume / Fork per session)

**Files:**
- Modify: `apps/seraphine/frontend/src/orchestrator/MaestroView.tsx`

- [ ] **Step 1:** On each observed session row add a "Cuidar desta" action that opens a small form (goal + permission mode + two buttons **Retomar** → `resumeSession` and **Forkar** → `forkSession`). On success, select the returned `agentId` and switch to its detail panel.

- [ ] **Step 2: Build + commit**

```bash
cd apps/seraphine/frontend && npm run build 2>&1 | tail -3
git add apps/seraphine/frontend/src/orchestrator/MaestroView.tsx
git commit -m "feat(maestro): handover UI (resume/fork) per session"
```

---

## Milestone 7 — End-to-end verification (real claude, gated)

### Task 7.1: Manual E2E checklist

- [ ] **Step 1:** `pnpm tauri:install` and open Seraphine → Maestro. Confirm the session list shows real local sessions (incl. ones started in a terminal).
- [ ] **Step 2:** "Novo agente" in a scratch git repo with goal "create hello.txt with 'hi'" + mode **Auto-aprovar leituras**. Confirm the stream renders, a Write permission **escalates**, Approve works, the file is created.
- [ ] **Step 3:** Start a `claude` session in a terminal, then in Maestro use **Forkar** with a goal; confirm a new owned agent appears and streams without disturbing the terminal session.
- [ ] **Step 4:** Stop an agent; confirm it dies (`pgrep claude`).
- [ ] **Step 5:** Note any deviations from captured fixtures (permission shape, session_id field) and reconcile `proto.rs`/`policy.rs`/`write_permission_response`.

---

## Self-review (done by the author)

- **Spec coverage:** Observability (M3) ✓ · owned agents spawn/control (M1) ✓ · permission policy + respond (M2) ✓ · handover resume/fork (M4) ✓ · dashboard (M6) ✓ · Mac-local only (no SSH tasks) ✓ · errors (stop/exit events, timeouts via UI, resume-conflict noted in 7.1) ✓ · testing via fake-agent harness (M0) ✓ · open items pinned in M0/Task 0.1 ✓.
- **Placeholder scan:** every code step has real code; the only deferrals are explicit "adjust to captured fixture shape" notes, which are grounded in the Task 0.1 artifact, not vague TODOs.
- **Type consistency:** Rust `maestro_*` command names match the `lib.rs` registration (Task 5.1) and the TS bridge invoke strings (Task 5.2); event channel `maestro:agent-event` matches between `mod.rs` emit and `api.ts` listen; `PermissionMode` strings (`ask_all`/`auto_reads`/`full_auto`) match `parse_mode` in Rust.

**Out of scope (Phases 2–3):** SSH remote agents; autonomous self-improvement loop; "Seraphine decides" LLM permission mode; manager→worker recursion.

---

## M0 Spike findings — corrections to later tasks (discovered by Task 0.1)

Capturing real `claude` v2.1.183 stream-json output corrected three assumptions. Later tasks MUST use these real shapes:

**Spawn command (Task 1.2 `spawn_inner`, and resume/fork in Task 4.1):**
Plain `-p` **auto-denies** gated tools and never asks. To make permissions route to the parent you MUST add `--permission-prompt-tool stdio --setting-sources "" --verbose`, and after spawning send an `initialize` control_request before the first user turn:
```
claude -p --output-format stream-json --input-format stream-json \
  --permission-mode default --permission-prompt-tool stdio --setting-sources "" --verbose [--resume <id>] [--fork-session]
```
First stdin line (once, right after spawn): `{"type":"control_request","request_id":"maestro-init","request":{"subtype":"initialize","hooks":{}}}`
Then the user turn: `{"type":"user","message":{"role":"user","content":"<goal>"}}`
(`--setting-sources ""` suppresses the global SessionStart hooks that otherwise flood the stream; `--bare` is NOT usable — it breaks OAuth.)

**Permission classify (Task 1.1 `proto.rs`):** a permission ask is `type=="control_request"` **AND** `request.subtype=="can_use_tool"` (control_request also carries `initialize` and others — guard on the subtype). `request_id` is **top-level**; tool name is `request.tool_name`. Update the `control_request` arm to require `request.subtype == "can_use_tool"`, else classify `Other`.

**Permission response (Task 2.2 `write_permission_response`):** the real reply shape (allow AND deny both use `subtype:"success"`; the decision is the camelCase `behavior` in the nested `response`):
```rust
let resp = serde_json::json!({
  "type":"control_response",
  "response":{"subtype":"success","request_id":request_id,
              "response":{"behavior": if allow {"allow"} else {"deny"}}}
});
```

**Fake-agent harness:** `--wait-stdin-after N` reads the fixture on FD 3 (`done 3< "$fixture"`, `read line <&3`) so the permission-response `read` blocks on real stdin (already fixed, commit d296a13).
