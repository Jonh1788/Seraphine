# Maestro Phase 2 — Remote Agents over SSH — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Seraphine spawn/control and observe Claude Code agents on remote hosts over SSH, reusing the Phase 1 supervisor unchanged (the stream-json over the ssh pipe is byte-identical to local).

**Architecture:** Shell out to the system `ssh`. `spawn_inner` gains an optional `host`; when set, the launched process is `ssh -T <host> "bash -lc 'cd <cwd> && exec claude -p stream-json …'"`, and its stdin/stdout (the stream-json protocol) flow through the ssh pipe into the existing registry/reader-thread/permission machinery. A new `ssh.rs` does host discovery (`~/.ssh/config`) + preflight; the observer gains remote variants via `ssh <host> ls/tail`. The React dashboard gains a host selector + remote sessions + Local/`<host>` badges.

**Tech Stack:** Rust (`std::process::Command`, `serde`, existing `agents` module), Tauri 2, React/TS (existing `src/orchestrator` bridge), the Phase 1 fake-agent harness.

**Spec:** `docs/superpowers/specs/2026-06-21-maestro-phase2-remote-agents-design.md`

**Phase 1 facts (verified, in `apps/seraphine/frontend/src-tauri/src/agents/`):**
- `spawn_inner(app: &AppHandle, cwd: &str, goal: &str, mode: &str, extra_args: &[String]) -> Result<String, String>` (mod.rs) — builds the local `claude` argv, spawns, registers, streams.
- `claude_bin()` = `MAESTRO_CLAUDE_BIN` env or `"claude"`; `is_fake()` = bin ends with `.sh` (tests point it at `fake_agent.sh`).
- `struct AgentHandle { child, stdin, cwd, mode }`; registry `OnceLock<Mutex<HashMap<String, AgentHandle>>>`.
- `observer.rs`: `project_slug`, `projects_dir()`, `SessionInfo{session_id, slug, cwd, last_modified_ms}`, `maestro_list_sessions`, `maestro_read_transcript(slug, session_id, tail)`, `cwd_from_transcript`.
- Commands registered in the DESKTOP `generate_handler!` in `lib.rs` (observer ones via full path `agents::observer::…`).
- Frontend bridge `src/orchestrator/{api.ts,types.ts}`; `MaestroView.tsx`; Tauri arg convention = camelCase JS → snake_case Rust.

---

## Milestone 1 — SSH host discovery + preflight (`agents/ssh.rs`)

### Task 1.1: `~/.ssh/config` Host parser

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/src/agents/ssh.rs`
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs` (add `pub mod ssh;`)

- [ ] **Step 1: Write `ssh.rs` with the parser + test**

```rust
//! SSH host discovery + preflight for remote agents.
use std::path::PathBuf;
use serde::Serialize;

fn ssh_config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".ssh/config")
}

/// Parse plain top-level `Host <alias>` lines from ~/.ssh/config, excluding
/// wildcard patterns (containing `*` or `?`) and multi-token host lists.
/// (Include/Match directives are not expanded — documented limitation.)
pub fn parse_hosts(config: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in config.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') { continue; }
        let lower = t.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("host ") {
            // Use the original-case tokens, aligned with the lowercased split.
            let orig_rest = t[t.len() - rest.len()..].trim();
            for tok in orig_rest.split_whitespace() {
                if !tok.contains('*') && !tok.contains('?') && !out.iter().any(|h| h == tok) {
                    out.push(tok.to_string());
                }
            }
        }
    }
    out
}

#[tauri::command]
pub fn maestro_list_hosts() -> Result<Vec<String>, String> {
    match std::fs::read_to_string(ssh_config_path()) {
        Ok(s) => Ok(parse_hosts(&s)),
        Err(_) => Ok(Vec::new()),
    }
}

#[derive(Serialize, Clone)]
pub struct HostStatus { pub reachable: bool, pub claude_version: Option<String>, pub error: Option<String> }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_hosts_excluding_wildcards() {
        let cfg = "# comment\nHost CassinoAPI\n  HostName 1.2.3.4\nHost *\n  User root\nHost a b\nHost gpu?box\n";
        assert_eq!(parse_hosts(cfg), vec!["CassinoAPI".to_string(), "a".to_string(), "b".to_string()]);
    }
}
```

- [ ] **Step 2: Register the module + run the test**

Add `pub mod ssh;` to `agents/mod.rs`. Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::ssh --lib 2>&1 | tail -6`
Expected: `1 passed`.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/ssh.rs apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): parse ~/.ssh/config hosts"
```

### Task 1.2: `maestro_check_host` preflight

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/ssh.rs`

- [ ] **Step 1: Implement (uses BatchMode so it fails fast, never prompts)**

```rust
fn ssh_bin() -> String { std::env::var("MAESTRO_SSH_BIN").unwrap_or_else(|_| "ssh".into()) }

#[tauri::command]
pub fn maestro_check_host(host: String) -> Result<HostStatus, String> {
    use std::process::Command;
    let out = Command::new(ssh_bin())
        .args(["-T", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", &host,
               "bash -lc 'command -v claude >/dev/null 2>&1 && claude --version'"])
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(HostStatus {
            reachable: true,
            claude_version: Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
            error: None,
        }),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            // ssh reached the host but claude missing → reachable, no version.
            let reachable = !err.to_lowercase().contains("connection")
                && !err.to_lowercase().contains("timed out")
                && !err.to_lowercase().contains("could not resolve");
            Ok(HostStatus { reachable, claude_version: None, error: Some(if err.is_empty() { "claude não encontrado no host".into() } else { err }) })
        }
        Err(e) => Ok(HostStatus { reachable: false, claude_version: None, error: Some(format!("ssh falhou: {e}")) }),
    }
}
```

- [ ] **Step 2: Build**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5`
Expected: builds (dead-code warning until registered in M4).

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/ssh.rs
git commit -m "feat(maestro): remote host preflight check"
```

---

## Milestone 2 — Remote spawn (extend `spawn_inner`)

### Task 2.1: Remote command builder (pure, TDD)

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Add the builder + test** (append near `spawn_inner`)

```rust
/// POSIX single-quote a string for safe embedding in a shell command.
fn shq(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

/// The claude headless flags shared by local and remote spawns.
const CLAUDE_FLAGS: &[&str] = &[
    "-p", "--output-format", "stream-json", "--input-format", "stream-json",
    "--permission-mode", "default", "--permission-prompt-tool", "stdio",
    "--setting-sources", "", "--verbose",
];

/// Build the full ssh argv for a remote agent. The remote command runs under a
/// login bash (`bash -lc`) so the user's PATH (e.g. ~/.local/bin/claude) is set.
fn remote_ssh_argv(host: &str, cwd: &str, extra: &[String]) -> Vec<String> {
    let flags = CLAUDE_FLAGS.iter().map(|f| if f.is_empty() { "\"\"".to_string() } else { (*f).to_string() }).collect::<Vec<_>>().join(" ");
    let extra_s = extra.join(" ");
    let inner = format!("cd {} && exec claude {} {}", shq(cwd), flags, extra_s);
    let remote = format!("bash -lc {}", shq(inner.trim_end()));
    vec![
        "-T".into(), "-o".into(), "ControlMaster=auto".into(),
        "-o".into(), "ControlPersist=60s".into(),
        host.to_string(), remote,
    ]
}

#[cfg(test)]
mod remote_tests {
    use super::*;
    #[test]
    fn builds_remote_argv() {
        let argv = remote_ssh_argv("Cassino", "/srv/app", &["--resume".into(), "abc".into()]);
        assert_eq!(argv[0], "-T");
        assert_eq!(argv[5], "Cassino");
        let remote = &argv[6];
        assert!(remote.starts_with("bash -lc '"), "got {remote}");
        assert!(remote.contains("cd '/srv/app' && exec claude"), "got {remote}");
        assert!(remote.contains("--resume abc"), "got {remote}");
        assert!(remote.contains("--permission-prompt-tool stdio"), "got {remote}");
    }
}
```

- [ ] **Step 2: Run the test**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::remote_tests --lib 2>&1 | tail -6`
Expected: `1 passed`.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): build remote ssh argv for agents"
```

### Task 2.2: Thread `host` through `spawn_inner` + `AgentHandle` + commands

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Add `host` to the spawn path**

Change `AgentHandle` to add `host: Option<String>` (annotate `#[allow(dead_code)]` if unused by the compiler outside this milestone). Change `spawn_inner`'s signature to `spawn_inner(app, cwd, goal, mode, host: Option<&str>, extra_args)`. Inside, choose the command:
```rust
let mut cmd = if let Some(h) = host {
    let mut c = Command::new(ssh_bin());           // ssh_bin from ssh.rs — re-export or duplicate the helper
    c.args(remote_ssh_argv(h, cwd, extra_args));
    c
} else if is_fake() {
    let mut c = Command::new(claude_bin());
    c.arg(std::env::var("MAESTRO_FAKE_FIXTURE").unwrap_or_default());
    c
} else {
    let mut c = Command::new(claude_bin());
    c.args(CLAUDE_FLAGS.iter().map(|s| *s));
    for a in extra_args { c.arg(a); }
    c
};
// Remote/local-real both stream stdin; only local non-fake sets current_dir
// (remote cwd is handled inside the ssh command). For remote, current_dir is irrelevant.
cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
if host.is_none() && !is_fake() { /* local: nothing extra */ }
```
Keep the existing `current_dir(cwd)` ONLY for the local non-fake branch (remote sets cwd via the ssh command; fake doesn't need it). The `initialize` handshake + goal user turn write to stdin for BOTH local-real and remote (anything that isn't the fake `.sh`): change the guard from `if !is_fake()` to `if host.is_some() || !is_fake()`. Store `host` on the `AgentHandle`.

> Use `ssh_bin()` from `ssh.rs` — make it `pub(crate)` there and `use crate::agents::ssh::ssh_bin;`, or duplicate the 1-line helper in mod.rs. Pick one and keep it DRY.

- [ ] **Step 2: Update command signatures**

```rust
#[tauri::command]
pub fn maestro_spawn_agent(app: AppHandle, cwd: String, goal: String, permission_mode: String, host: Option<String>) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, host.as_deref(), &[])
}
```
Update `maestro_resume_session`/`maestro_fork_session` calls to pass `None` for host (remote handover is out of scope — they stay local). Update the existing internal callers accordingly so it compiles.

- [ ] **Step 3: Build + run all agent tests**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -6 && cargo test agents:: --lib 2>&1 | tail -6 && cargo test --test supervisor 2>&1 | tail -6`
Expected: builds; all prior agent tests still pass (local path unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): spawn agents on remote hosts via ssh"
```

### Task 2.3: `fake_ssh.sh` harness (test the remote path without ssh/API)

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_ssh.sh`
- Modify: `apps/seraphine/frontend/src-tauri/tests/supervisor.rs`

- [ ] **Step 1: Write the harness**

```bash
#!/usr/bin/env bash
# Stands in for `ssh` in tests. Ignores all ssh flags + the host, and replays
# the basic_run fixture via fake_agent.sh — exercising the remote spawn path
# (argv built by remote_ssh_argv) without a real ssh or claude.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
exec "$dir/fake_agent.sh" "$dir/basic_run.jsonl"
```

- [ ] **Step 2: chmod + an integration test**

```bash
chmod +x apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_ssh.sh
```
Add to `tests/supervisor.rs`:
```rust
#[test]
fn fake_ssh_streams_result_line() {
    let dir = env!("CARGO_MANIFEST_DIR");
    // remote_ssh_argv produces flags + host + a remote command; fake_ssh.sh
    // ignores them and replays the fixture, so invoking it directly with any
    // args yields the stream — same contract the supervisor relies on.
    let mut c = Command::new(format!("{dir}/tests/fixtures/agent/fake_ssh.sh"))
        .arg("-T").arg("anyhost").arg("bash -lc 'exec claude ...'")
        .stdout(Stdio::piped()).spawn().unwrap();
    let out = c.stdout.take().unwrap();
    let n = BufReader::new(out).lines().map_while(Result::ok).filter(|l| l.contains("\"type\":\"result\"")).count();
    c.wait().unwrap();
    assert_eq!(n, 1, "fake_ssh should replay a result line");
}
```

- [ ] **Step 3: Run + commit**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test --test supervisor 2>&1 | tail -8` → all pass.
```bash
git add apps/seraphine/frontend/src-tauri/tests/fixtures/agent/fake_ssh.sh apps/seraphine/frontend/src-tauri/tests/supervisor.rs
git commit -m "test(maestro): fake-ssh harness for the remote path"
```

---

## Milestone 3 — Remote observer

### Task 3.1: `maestro_list_remote_sessions` + `host` on `SessionInfo`

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/observer.rs`

- [ ] **Step 1: Add `host` to `SessionInfo` + the remote lister**

Add `pub host: Option<String>` to `SessionInfo` (set `host: None` in the existing local `maestro_list_sessions` push). Add:
```rust
use std::process::Command;
fn ssh_bin() -> String { std::env::var("MAESTRO_SSH_BIN").unwrap_or_else(|_| "ssh".into()) }

#[tauri::command]
pub fn maestro_list_remote_sessions(host: String) -> Result<Vec<SessionInfo>, String> {
    // List newest-first; one ssh call. Format: "<mtime_epoch>\t<path>" per line.
    let out = Command::new(ssh_bin())
        .args(["-T", "-o", "ControlMaster=auto", "-o", "ControlPersist=60s",
               "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", &host,
               "bash -lc 'for f in ~/.claude/projects/*/*.jsonl; do [ -e \"$f\" ] && stat -c \"%Y\\t%n\" \"$f\" 2>/dev/null || true; done | sort -rn'"])
        .output().map_err(|e| format!("ssh falhou: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut sessions = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.splitn(2, '\t');
        let (Some(mtime), Some(path)) = (parts.next(), parts.next()) else { continue };
        let session_id = std::path::Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let slug = std::path::Path::new(path).parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()).unwrap_or("").to_string();
        sessions.push(SessionInfo {
            session_id, slug, host: Some(host.clone()),
            cwd: String::new(), // filled lazily by read_transcript; keep light (1 ssh call)
            last_modified_ms: mtime.trim().parse::<u64>().unwrap_or(0).saturating_mul(1000),
        });
    }
    Ok(sessions)
}
```
> NOTE: `stat -c` is GNU/Linux (CassinoAPI is Linux). cwd is left empty to avoid N extra ssh calls — the UI shows the slug; when a remote session is opened, `maestro_read_transcript(host=…)` surfaces its real content. (If per-row cwd is wanted later, derive it from the slug client-side.)

- [ ] **Step 2: Build**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5` → builds.

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/observer.rs
git commit -m "feat(maestro): list remote sessions over ssh"
```

### Task 3.2: `host` on `maestro_read_transcript`

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/observer.rs`

- [ ] **Step 1: Add optional `host` (ssh tail when set)**

```rust
#[tauri::command]
pub fn maestro_read_transcript(slug: String, session_id: String, tail: usize, host: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let rel = format!("~/.claude/projects/{slug}/{session_id}.jsonl");
    let text = if let Some(h) = host {
        let out = Command::new(ssh_bin())
            .args(["-T", "-o", "ControlMaster=auto", "-o", "ControlPersist=60s",
                   "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", &h,
                   &format!("tail -n {tail} {rel}")])
            .output().map_err(|e| format!("ssh falhou: {e}"))?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        String::from_utf8_lossy(&out.stdout).to_string()
    } else {
        let path = projects_dir().join(&slug).join(format!("{session_id}.jsonl"));
        let mut s = std::fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))?;
        // local already returns the full file; tail it to match the remote contract.
        let lines: Vec<&str> = s.lines().collect();
        if lines.len() > tail { s = lines[lines.len() - tail..].join("\n"); }
        s
    };
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}
```
> This replaces the Phase 1 `maestro_read_transcript`; the `host` arg is added LAST so the existing local callers pass `host: None`/`undefined`. The local branch keeps the same tail behavior.

- [ ] **Step 2: Build + commit**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -5` → builds.
```bash
git add apps/seraphine/frontend/src-tauri/src/agents/observer.rs
git commit -m "feat(maestro): read remote transcript over ssh"
```

---

## Milestone 4 — Register + bridge + UI

### Task 4.1: Register new commands + extend the TS bridge

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/lib.rs`
- Modify: `apps/seraphine/frontend/src/orchestrator/{api.ts,types.ts}`

- [ ] **Step 1: Register the 3 new commands** in the DESKTOP `generate_handler!` (use full paths like the existing observer ones):
```rust
            agents::ssh::maestro_list_hosts,
            agents::ssh::maestro_check_host,
            agents::observer::maestro_list_remote_sessions,
```
(`maestro_read_transcript` / `maestro_spawn_agent` are already registered; their new optional args don't change registration.)
Build: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -8` → clean; the new commands' dead-code warnings disappear.

- [ ] **Step 2: Extend `types.ts`**
```ts
export interface HostStatus { reachable: boolean; claude_version: string | null; error: string | null; }
```
And add `host?: string` to `SessionInfo` (`host: string | null` to match serde `Option`).

- [ ] **Step 3: Extend `api.ts`**
```ts
import type { HostStatus } from './types';
export const listHosts = () => invoke<string[]>('maestro_list_hosts');
export const checkHost = (host: string) => invoke<HostStatus>('maestro_check_host', { host });
export const listRemoteSessions = (host: string) => invoke<SessionInfo[]>('maestro_list_remote_sessions', { host });
```
Change `spawnAgent` to accept an optional host:
```ts
export const spawnAgent = (cwd: string, goal: string, permissionMode: PermissionMode, host?: string) =>
  invoke<string>('maestro_spawn_agent', { cwd, goal, permissionMode, host: host ?? null });
```
Change `readTranscript` to accept an optional host:
```ts
export const readTranscript = (slug: string, sessionId: string, tail = 200, host?: string) =>
  invoke<unknown[]>('maestro_read_transcript', { slug, sessionId, tail, host: host ?? null });
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd apps/seraphine/frontend && npm run build 2>&1 | tail -4` → `✓ built`, 0 TS errors.
```bash
git add apps/seraphine/frontend/src-tauri/src/lib.rs apps/seraphine/frontend/src/orchestrator/api.ts apps/seraphine/frontend/src/orchestrator/types.ts
git commit -m "feat(maestro): register remote commands + extend bridge"
```

### Task 4.2: Host selector + remote sessions + badges in `MaestroView`

**Files:**
- Modify: `apps/seraphine/frontend/src/orchestrator/MaestroView.tsx`
- Modify: `apps/seraphine/frontend/src/orchestrator/obsidian.css`

- [ ] **Step 1: Host selector + preflight in the new-agent form**

Add state `const [host, setHost] = useState<string>('')` (empty = Local) and `const [hosts, setHosts] = useState<string[]>([])`, `const [hostStatus, setHostStatus] = useState<HostStatus | null>(null)`. On mount `void listHosts().then(setHosts)`. Render a `<select>` (Local + hosts + a free `user@host` via an `<input>` shown when "custom" is picked). When a non-empty host is chosen, `void checkHost(host).then(setHostStatus)` and show a pill: reachable + `claude_version`, or the error. Pass `host || undefined` to `spawnAgent(cwd, goal, mode, host || undefined)`.

```tsx
// in the new-agent card, after the mode <select>:
<select className="maestro__input" value={host} onChange={(e) => { setHost(e.target.value); setHostStatus(null); if (e.target.value) void checkHost(e.target.value).then(setHostStatus); }}>
  <option value="">Local</option>
  {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
</select>
{host && hostStatus && (
  <div className={`maestro__hoststatus maestro__hoststatus--${hostStatus.reachable ? 'ok' : 'err'}`}>
    {hostStatus.reachable ? (hostStatus.claude_version || 'acessível') : (hostStatus.error || 'inacessível')}
  </div>
)}
```
And change the Iniciar onClick to `spawnAgent(cwd, goal, mode, host || undefined)`.

- [ ] **Step 2: Remote sessions section**

Add `const [remoteSessions, setRemoteSessions] = useState<SessionInfo[]>([])`. When a host is selected (non-empty) and reachable, `void listRemoteSessions(host).then(setRemoteSessions).catch(() => setRemoteSessions([]))`. Render those rows alongside local ones, reusing `SessionRow`, passing the host so resume/fork stay local-only is fine (handover deferred — for remote rows, hide the handover form or disable it; show only the badge + activity). Pass `host` through `readTranscript` in the activity fetch for remote rows.

- [ ] **Step 3: Host badge on rows**

In `SessionRow`, add a host badge: `<span className="maestro__badge maestro__badge--host">{s.host ?? 'Local'}</span>`. For remote rows, gate the "Cuidar desta" handover (out of scope) — render a small "(handover remoto: em breve)" note instead of the Retomar/Forkar buttons when `s.host` is set.

- [ ] **Step 4: CSS**

Append to `src/orchestrator/obsidian.css`:
```css
.maestro__hoststatus { font-size: 11px; padding: 4px 8px; border-radius: 6px; }
.maestro__hoststatus--ok { color: var(--user); background: rgba(74,222,128,0.10); }
.maestro__hoststatus--err { color: var(--danger); background: rgba(239,68,68,0.10); }
.maestro__badge--host { color: var(--text-dim); background: rgba(255,255,255,0.06); }
```

- [ ] **Step 5: Build + commit**

Run: `cd apps/seraphine/frontend && npm run build 2>&1 | tail -4` → `✓ built`, 0 TS errors.
```bash
git add apps/seraphine/frontend/src/orchestrator/MaestroView.tsx apps/seraphine/frontend/src/orchestrator/obsidian.css
git commit -m "feat(maestro): host selector + remote sessions + host badges"
```

---

## Milestone 5 — End-to-end on a real host (validates the spec's open items)

### Task 5.1: Manual E2E + open-item validation

- [ ] **Step 1: Preflight a real host.** In Maestro, pick a host from `~/.ssh/config` that has `claude` installed (if none, install+auth `claude` on it first). Confirm the status pill shows the claude version. (Validates open item #2: `bash -lc` resolves PATH on the real host — if not, adjust `remote_ssh_argv`/`maestro_check_host` to use the resolved `command -v claude` path.)
- [ ] **Step 2: Remote spawn.** New agent on that host, a scratch repo cwd, a tiny goal, mode "Auto-aprovar leituras". Confirm the stream renders, a Write permission escalates, Approve works remotely, the file appears on the remote.
- [ ] **Step 3: ControlMaster sanity (open item #1).** While a remote agent is alive, open a remote session list / read a remote transcript (more ssh calls). Confirm the live agent's pipe is NOT torn down by the multiplexed calls. If it is, give the agent its own connection (drop ControlMaster for the agent spawn, keep it only for observability calls) and note the change.
- [ ] **Step 4: Remote observe.** Confirm `maestro_list_remote_sessions` shows the host's sessions and `read_transcript(host)` tails one.
- [ ] **Step 5: Disconnect.** Kill the ssh / drop the network; confirm the agent goes to exit/crashed cleanly (no zombie).

---

## Self-review (author)

- **Spec coverage:** host discovery (M1.1) ✓ · preflight (M1.2) ✓ · remote spawn over ssh with login-shell cwd (M2) ✓ · fake-ssh test harness (M2.3) ✓ · remote observe list+tail (M3) ✓ · register+bridge (M4.1) ✓ · UI host selector+remote sessions+badges (M4.2) ✓ · error handling (BatchMode/ConnectTimeout, per-host failures, pipe-EOF crash) ✓ · the 3 spec open items validated in M5 ✓ · remote handover correctly OUT (M4.2 gates it).
- **Placeholder scan:** every step has real code; the only deferrals are the explicit out-of-scope handover note and the M5 open-item validations (grounded, not vague).
- **Type/name consistency:** `remote_ssh_argv`, `shq`, `CLAUDE_FLAGS`, `ssh_bin`, `maestro_list_hosts/check_host/list_remote_sessions`, `HostStatus{reachable,claude_version,error}`, `SessionInfo.host` are used identically across Rust + the TS bridge (camelCase keys `host`); `maestro_read_transcript`/`maestro_spawn_agent` gain the `host` arg LAST so existing callers stay valid (`host: null`).

**Out of scope (Phase 3 / later):** remote handover (resume/fork remote), jump-host/multi-hop, agent-daemon mode, autonomous self-improvement.
