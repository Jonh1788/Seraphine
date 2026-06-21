# Maestro Phase 3 — Directed Self-Improvement (gated) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seraphine improves her own repo from a user goal (+ optional reference URLs), in an isolated git worktree, iterating to a green build/test gate, with a sandbox permission policy and a hybrid Maestro review that merges to local `main` only on the user's approval — never pushing or deploying.

**Architecture:** Reuses the Phase 1/2 supervisor (the self-improve agent is an owned headless agent whose cwd is the worktree). New, thin Rust: worktree lifecycle + gate runner + an input-aware Sandbox policy mode (reader thread routes sandbox agents through it). New React: a "Melhorar a Seraphine" panel that drives create → spawn → gate-iterate → review → approve/reject via the existing event stream.

**Tech Stack:** Rust (`std::process::Command`, `serde_json`, existing `agents` module), Tauri 2, React/TS (existing `src/orchestrator`), the Phase 1 fake-agent harness.

**Spec:** `docs/superpowers/specs/2026-06-21-maestro-phase3-self-improvement-design.md`

**Phase 1/2 facts (verified on `main`):** `agents::policy::{Mode(AskAll/AutoReads/FullAuto), Decision, decide(Mode,&str), parse_mode}`; `agents::mod` reader thread auto-decides permissions from `AgentHandle.mode` (a `String`) and `AgentHandle.cwd`; the raw control_request JSON `v` is in scope in the reader thread (`v["request"]["input"]` holds the tool input — captured real in M0); `spawn_inner(app, cwd, goal, mode, host, extra_args)`; `maestro_send_to_agent(agent_id, text)`; events `maestro:agent-event` carry `{agent_id, kind, raw}` (a `result` kind marks a finished turn). Commands registered in the desktop `generate_handler!` (observer/ssh via full path). Tauri arg convention camelCase→snake_case.

---

## Milestone 1 — Worktree lifecycle (`agents/selfimprove.rs`)

All git commands use `-C <repo_root>` so they never depend on the process cwd. `repo_root` is passed by the frontend (a configured dev-checkout path; see M4 settings).

### Task 1.1: create + list

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/src/agents/selfimprove.rs`
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs` (`pub mod selfimprove;`)

- [ ] **Step 1: Write create/list + a slugify helper + test**

```rust
//! Directed self-improvement: isolated worktrees on Seraphine's own repo.
use std::process::Command;
use serde::Serialize;

fn git(repo_root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(repo_root).args(args)
        .output().map_err(|e| format!("git falhou: {e}"))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).to_string()) }
    else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// kebab-case, ascii, max 40 chars — for the branch/worktree name.
pub fn slugify(goal: &str) -> String {
    let s: String = goal.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    s.chars().take(40).collect::<String>().trim_matches('-').to_string()
}

#[derive(Serialize, Clone)]
pub struct SiSession { pub id: String, pub path: String, pub branch: String }

#[tauri::command]
pub fn maestro_si_create(repo_root: String, slug: String, id: String) -> Result<SiSession, String> {
    let branch = format!("selfimprove/{slug}");
    let rel = format!(".worktrees/selfimprove-{id}");
    git(&repo_root, &["worktree", "add", &rel, "-b", &branch, "HEAD"])?;
    Ok(SiSession { id, path: format!("{repo_root}/{rel}"), branch })
}

#[tauri::command]
pub fn maestro_si_list(repo_root: String) -> Result<Vec<String>, String> {
    let out = git(&repo_root, &["worktree", "list", "--porcelain"])?;
    Ok(out.lines().filter_map(|l| l.strip_prefix("worktree ")).filter(|p| p.contains("/.worktrees/selfimprove-")).map(String::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slugify_is_kebab() {
        assert_eq!(slugify("Melhore o parser de SSH!"), "melhore-o-parser-de-ssh");
        assert_eq!(slugify("  a/b  c  "), "a-b-c");
    }
}
```
Add `pub mod selfimprove;` to `agents/mod.rs`. Test: `cd apps/seraphine/frontend/src-tauri && cargo test agents::selfimprove --lib 2>&1 | tail -6` → 1 passed. Commit `feat(maestro): self-improve worktree create/list`.

### Task 1.2: diffstat + merge + discard

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/selfimprove.rs`

- [ ] **Step 1: Implement**

```rust
#[derive(Serialize, Clone)]
pub struct DiffFile { pub path: String, pub changes: String }

#[tauri::command]
pub fn maestro_si_diffstat(repo_root: String, branch: String) -> Result<Vec<DiffFile>, String> {
    let out = git(&repo_root, &["diff", "--stat", &format!("main...{branch}")])?;
    Ok(out.lines().filter(|l| l.contains('|')).map(|l| {
        let mut p = l.splitn(2, '|');
        DiffFile { path: p.next().unwrap_or("").trim().to_string(), changes: p.next().unwrap_or("").trim().to_string() }
    }).collect())
}

#[tauri::command]
pub fn maestro_si_merge(repo_root: String, branch: String) -> Result<String, String> {
    git(&repo_root, &["switch", "main"])?;
    match git(&repo_root, &["merge", "--no-ff", "-m", &format!("merge: self-improvement {branch}"), &branch]) {
        Ok(o) => Ok(o),
        Err(e) => { let _ = git(&repo_root, &["merge", "--abort"]); Err(format!("conflito no merge (abortado): {e}")) }
    }
}

#[tauri::command]
pub fn maestro_si_discard(repo_root: String, id: String, branch: String) -> Result<(), String> {
    let rel = format!(".worktrees/selfimprove-{id}");
    let _ = git(&repo_root, &["worktree", "remove", "--force", &rel]);
    let _ = git(&repo_root, &["branch", "-D", &branch]);
    Ok(())
}
```

- [ ] **Step 2: Integration test against a throwaway repo**

Create `apps/seraphine/frontend/src-tauri/tests/selfimprove.rs`:
```rust
use std::process::Command;
fn run(dir: &str, args: &[&str]) { assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success()); }

#[test]
fn worktree_create_diff_merge_discard() {
    let tmp = std::env::temp_dir().join(format!("si-test-{}", std::process::id()));
    let root = tmp.to_str().unwrap();
    std::fs::create_dir_all(&tmp).unwrap();
    run(root, &["init", "-q", "-b", "main"]);
    run(root, &["config", "user.email", "t@t"]); run(root, &["config", "user.name", "t"]);
    std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
    run(root, &["add", "."]); run(root, &["commit", "-q", "-m", "init"]);
    // create worktree, change a file, commit on the branch
    run(root, &["worktree", "add", ".worktrees/selfimprove-x", "-b", "selfimprove/test", "HEAD"]);
    std::fs::write(tmp.join(".worktrees/selfimprove-x/a.txt"), "one\ntwo\n").unwrap();
    run(&format!("{root}/.worktrees/selfimprove-x"), &["commit", "-aqm", "change"]);
    // diff shows a.txt
    let diff = Command::new("git").arg("-C").arg(root).args(["diff","--stat","main...selfimprove/test"]).output().unwrap();
    assert!(String::from_utf8_lossy(&diff.stdout).contains("a.txt"));
    // merge to main
    run(root, &["switch", "main"]);
    run(root, &["merge", "--no-ff", "-m", "m", "selfimprove/test"]);
    assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "one\ntwo\n");
    std::fs::remove_dir_all(&tmp).ok();
}
```

- [ ] **Step 3: Run + commit**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test --test selfimprove 2>&1 | tail -6` → pass.
```bash
git add apps/seraphine/frontend/src-tauri/src/agents/selfimprove.rs apps/seraphine/frontend/src-tauri/tests/selfimprove.rs
git commit -m "feat(maestro): self-improve diffstat/merge/discard"
```

---

## Milestone 2 — Gate runner

### Task 2.1: `maestro_si_gate`

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/selfimprove.rs`

- [ ] **Step 1: Implement (runs a configurable command list in the worktree)**

```rust
#[derive(Serialize, Clone)]
pub struct GateStep { pub cmd: String, pub ok: bool, pub tail: String }
#[derive(Serialize, Clone)]
pub struct GateResult { pub ok: bool, pub steps: Vec<GateStep> }

/// Each `cmd` is a `sh -c` string run with cwd = `path`. Stops at first failure.
#[tauri::command]
pub fn maestro_si_gate(path: String, commands: Vec<String>) -> Result<GateResult, String> {
    let mut steps = Vec::new();
    for cmd in &commands {
        let out = Command::new("/bin/sh").arg("-c").arg(cmd).current_dir(&path).output()
            .map_err(|e| format!("spawn {cmd}: {e}"))?;
        let mut tail = String::from_utf8_lossy(&out.stdout).to_string();
        tail.push_str(&String::from_utf8_lossy(&out.stderr));
        if tail.len() > 4000 { tail = tail.split_off(tail.len() - 4000); }
        let ok = out.status.success();
        steps.push(GateStep { cmd: cmd.clone(), ok, tail });
        if !ok { return Ok(GateResult { ok: false, steps }); }
    }
    Ok(GateResult { ok: true, steps })
}
```

- [ ] **Step 2: Unit test (true/false commands)**

Append to the `tests` mod in `selfimprove.rs`:
```rust
#[test]
fn gate_stops_at_first_failure() {
    let dir = std::env::temp_dir(); let p = dir.to_str().unwrap().to_string();
    let r = maestro_si_gate(p.clone(), vec!["true".into(), "false".into(), "true".into()]).unwrap();
    assert!(!r.ok); assert_eq!(r.steps.len(), 2); assert!(r.steps[0].ok); assert!(!r.steps[1].ok);
    let g = maestro_si_gate(p, vec!["true".into(), "true".into()]).unwrap();
    assert!(g.ok); assert_eq!(g.steps.len(), 2);
}
```

- [ ] **Step 3: Run + commit**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::selfimprove --lib 2>&1 | tail -6` → pass.
```bash
git add apps/seraphine/frontend/src-tauri/src/agents/selfimprove.rs
git commit -m "feat(maestro): self-improve gate runner"
```

---

## Milestone 3 — Sandbox permission policy

### Task 3.1: `decide_sandbox` (input-aware, TDD)

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/policy.rs`

- [ ] **Step 1: Add `decide_sandbox` + tests**

```rust
use serde_json::Value;

const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];
const DENY_BASH: &[&str] = &["git push", "ssh ", "scp ", "rsync ", "tauri build", "tauri:install", "docker ", " deploy"];

/// Sandbox decision for a self-improve agent confined to `worktree`.
/// Reads (incl. WebFetch/WebSearch) are allowed (reference ingestion).
/// Writes are allowed only inside the worktree (or the OS temp dir).
/// Bash is denied for push/deploy/ssh; allowed otherwise; ambiguous → escalate.
pub fn decide_sandbox(worktree: &str, tool: &str, input: Option<&Value>) -> Decision {
    if READ_TOOLS.contains(&tool) { return Decision::Allow; }
    let tmp = std::env::temp_dir().to_string_lossy().to_string();
    if WRITE_TOOLS.contains(&tool) {
        let path = input.and_then(|i| i.get("file_path").or_else(|| i.get("path"))).and_then(Value::as_str).unwrap_or("");
        return if path.starts_with(worktree) || path.starts_with(&tmp) { Decision::Allow } else { Decision::Escalate };
    }
    if tool == "Bash" {
        let cmd = input.and_then(|i| i.get("command")).and_then(Value::as_str).unwrap_or("");
        let low = cmd.to_lowercase();
        if DENY_BASH.iter().any(|p| low.contains(p)) || low.contains(".env") || low.contains("credential") {
            return Decision::Deny;
        }
        return Decision::Allow; // build/test/git-local/read — confined by the worktree cwd
    }
    Decision::Escalate
}

#[cfg(test)]
mod sandbox_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sandbox_rules() {
        let wt = "/repo/.worktrees/selfimprove-x";
        assert_eq!(decide_sandbox(wt, "WebFetch", None), Decision::Allow);
        assert_eq!(decide_sandbox(wt, "Write", Some(&json!({"file_path": format!("{wt}/src/x.rs")}))), Decision::Allow);
        assert_eq!(decide_sandbox(wt, "Write", Some(&json!({"file_path": "/etc/passwd"}))), Decision::Escalate);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "cargo test"}))), Decision::Allow);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "git push origin main"}))), Decision::Deny);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "cat ../.env"}))), Decision::Deny);
    }
}
```
(`READ_TOOLS` already exists in `policy.rs` from Phase 1 — reuse it; `Decision` derives `PartialEq`.)

- [ ] **Step 2: Run + commit**

Run: `cd apps/seraphine/frontend/src-tauri && cargo test agents::policy --lib 2>&1 | tail -6` → all pass.
```bash
git add apps/seraphine/frontend/src-tauri/src/agents/policy.rs
git commit -m "feat(maestro): input-aware sandbox permission policy"
```

### Task 3.2: route sandbox agents through `decide_sandbox` in the reader thread

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/agents/mod.rs`

- [ ] **Step 1: Use the sandbox path when `mode == "sandbox"`**

In the reader-thread permission block (where it currently does `policy::decide(parse_mode(&h.mode), tool)`), branch on the mode string:
```rust
let decision = if h.mode == "sandbox" {
    let input = v.get("request").and_then(|r| r.get("input"));
    crate::agents::policy::decide_sandbox(&h.cwd, tool, input)
} else {
    crate::agents::policy::decide(crate::agents::policy::parse_mode(&h.mode), tool)
};
match decision {
    crate::agents::policy::Decision::Allow => { if let Some(si) = h.stdin.as_mut() { let _ = write_permission_response(si, request_id, true); } }
    crate::agents::policy::Decision::Deny  => { if let Some(si) = h.stdin.as_mut() { let _ = write_permission_response(si, request_id, false); } }
    crate::agents::policy::Decision::Escalate => {}
}
```
(`v` is the raw parsed line already in scope in the reader thread.)

- [ ] **Step 2: Build + all agent tests**

Run: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -6 && cargo test agents:: --lib 2>&1 | tail -6 && cargo test --test supervisor 2>&1 | tail -6` → builds; all pass (non-sandbox path unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/agents/mod.rs
git commit -m "feat(maestro): route sandbox agents through input-aware policy"
```

---

## Milestone 4 — Register + bridge + Self-Improve panel

### Task 4.1: Register + repo-root setting + bridge

**Files:**
- Modify: `apps/seraphine/frontend/src-tauri/src/lib.rs`
- Modify: `apps/seraphine/frontend/src/orchestrator/{api.ts,types.ts}`

- [ ] **Step 1: Register the 6 si commands** in the desktop `generate_handler!`:
```rust
            agents::selfimprove::maestro_si_create,
            agents::selfimprove::maestro_si_list,
            agents::selfimprove::maestro_si_diffstat,
            agents::selfimprove::maestro_si_merge,
            agents::selfimprove::maestro_si_discard,
            agents::selfimprove::maestro_si_gate,
```
Build: `cd apps/seraphine/frontend/src-tauri && cargo build 2>&1 | tail -8` → clean (no dead-code on the si commands).

- [ ] **Step 2: `types.ts` + `api.ts`**
```ts
// types.ts
export interface SiSession { id: string; path: string; branch: string; }
export interface DiffFile { path: string; changes: string; }
export interface GateStep { cmd: string; ok: boolean; tail: string; }
export interface GateResult { ok: boolean; steps: GateStep[]; }
```
```ts
// api.ts
import type { SiSession, DiffFile, GateResult } from './types';
export const siCreate = (repoRoot: string, slug: string, id: string) => invoke<SiSession>('maestro_si_create', { repoRoot, slug, id });
export const siList = (repoRoot: string) => invoke<string[]>('maestro_si_list', { repoRoot });
export const siDiffstat = (repoRoot: string, branch: string) => invoke<DiffFile[]>('maestro_si_diffstat', { repoRoot, branch });
export const siMerge = (repoRoot: string, branch: string) => invoke<string>('maestro_si_merge', { repoRoot, branch });
export const siDiscard = (repoRoot: string, id: string, branch: string) => invoke('maestro_si_discard', { repoRoot, id, branch });
export const siGate = (path: string, commands: string[]) => invoke<GateResult>('maestro_si_gate', { path, commands });
```
- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/seraphine/frontend && npm run build 2>&1 | tail -4` → `✓ built`, 0 TS errors.
```bash
git add apps/seraphine/frontend/src-tauri/src/lib.rs apps/seraphine/frontend/src/orchestrator/api.ts apps/seraphine/frontend/src/orchestrator/types.ts
git commit -m "feat(maestro): register self-improve commands + bridge"
```

### Task 4.2: "Melhorar a Seraphine" panel + the gate-iterate loop

**Files:**
- Create: `apps/seraphine/frontend/src/orchestrator/SelfImprove.tsx`
- Modify: `apps/seraphine/frontend/src/orchestrator/MaestroView.tsx` (mount the panel — e.g. a tab/section)
- Modify: `apps/seraphine/frontend/src/orchestrator/obsidian.css`

- [ ] **Step 1: The panel + loop**

Create `SelfImprove.tsx`. State: `repoRoot` (a text input, default `/Users/jonh1788/Dev/Projeto-Seraphine`, persisted to localStorage `maestro.repoRoot`), `goal`, `refs` (string[]), `session` (SiSession | null), `phase` ('idle'|'working'|'gating'|'ready'|'failed'), `gate` (GateResult | null), `diff` (DiffFile[]), and the agent id. The loop, driven by the agent event stream (`useAgentStream`, filter by the spawned agent id; a `result` kind = turn finished):
```
const GATE = ['cargo build', 'cargo test agents:: --lib', 'cargo test --test supervisor', 'npm run build'];
const startSI = async () => {
  const id = `si-${Date.now()}`;
  const slug = goal.slice(0,40);                       // server slugifies; this is only the suffix label
  const s = await siCreate(repoRoot, /*server slug*/ slugifyClient(goal), id);
  setSession(s); setPhase('working');
  const prompt = composePrompt(goal, refs);            // goal + "read these refs via WebFetch and adapt what fits; clone to a temp dir if needed; do NOT copy reference repos into this tree"
  const agentId = await spawnAgent(s.path, prompt, 'full_auto');  // see note: pass 'sandbox' — extend spawnAgent/maestro_spawn_agent to accept it; mode string flows to AgentHandle.mode
  setAgentId(agentId);
};
// when a `result` event for agentId arrives → run the gate:
useEffect(() => {
  if (phase !== 'working' || !lastResultFor(agentId)) return;
  setPhase('gating');
  void siGate(session!.path, GATE).then((g) => {
    setGate(g);
    if (g.ok) { void siDiffstat(repoRoot, session!.branch).then(setDiff); setPhase('ready'); }
    else if (attempts < 3) { setAttempts(a => a+1); void sendToAgent(agentId!, `O gate falhou:\n${g.steps.at(-1)?.tail}\nCorrija e me avise.`); setPhase('working'); }
    else { setPhase('failed'); }
  });
}, [events]);
```
Render: repoRoot input, goal textarea, refs list (add/remove URL), Start; then the live agent stream + the phase + (when ready/failed) the gate steps + diffstat + **Aprovar** (`siMerge` then `siDiscard` worktree-keep-branch → reset) / **Rejeitar** (`siDiscard`) / **Iterar** (feedback box → `sendToAgent` + back to 'working').

> IMPORTANT mode change: extend `maestro_spawn_agent`/`spawnAgent` to pass the permission mode string straight through (Phase 1 already stores it as `AgentHandle.mode`), and call it with `'sandbox'` here so the reader thread routes through `decide_sandbox`. No new spawn arg needed — `permission_mode: 'sandbox'` is just another string value. Confirm `parse_mode` leaves unknown strings as a safe default for the NON-sandbox path (it does → AskAll), and the reader-thread branch added in Task 3.2 handles `"sandbox"` explicitly.

- [ ] **Step 2: Mount in MaestroView**

Add a small toggle/tab in `MaestroView` header ("Agentes" | "Melhorar a Seraphine") that renders `<SelfImprove/>` instead of the agent list when selected. Keep the Phase 1/2 view as the default tab.

- [ ] **Step 3: CSS + build**

Add scoped `.si-*` styles to `obsidian.css` (reuse `obs-card`/`obs-btn`). Run: `cd apps/seraphine/frontend && npm run build 2>&1 | tail -4` → `✓ built`, 0 TS errors.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/orchestrator/SelfImprove.tsx apps/seraphine/frontend/src/orchestrator/MaestroView.tsx apps/seraphine/frontend/src/orchestrator/obsidian.css
git commit -m "feat(maestro): Melhorar a Seraphine panel + gate-iterate loop"
```

---

## Milestone 5 — End-to-end (manual, real repo)

### Task 5.1: E2E checklist

- [ ] **Step 1:** Set repoRoot to the dev checkout. Goal: a tiny real improvement (e.g. "adicione um teste para slugify cobrindo acentos"). Start. Confirm a worktree `.worktrees/selfimprove-*` appears, the agent streams, sandbox permissions auto-allow worktree writes + `cargo`/`npm`, and a `git push` attempt (if any) is auto-denied.
- [ ] **Step 2:** Confirm the gate runs after the agent's turn; on green, the diffstat + changed files show in Maestro. Inspect the full diff in your editor (the branch is on disk).
- [ ] **Step 3: Reference ingestion.** New session, goal: "olha `<um github/artigo>` e adapte o que fizer sentido aqui", with the URL in refs. Confirm the agent uses WebFetch/WebSearch (visible in the stream) and does NOT clone the reference into the tree.
- [ ] **Step 4: Approve** → confirm `selfimprove/<slug>` merges into local `main` and the worktree is removed; `git log` shows the merge; nothing was pushed/deployed.
- [ ] **Step 5: Reject** a different session → worktree + branch gone, `main` untouched.
- [ ] **Step 6:** Validate the open items: the repoRoot setting (M4 §1), the gate command set + timeouts (cargo can be slow — bump if needed), and the sandbox path/denylist against real claude tool inputs (adjust `decide_sandbox` if a real input shape differs).

---

## Self-review (author)

- **Spec coverage:** worktree lifecycle (M1) ✓ · gate runner (M2) ✓ · input-aware sandbox policy + reader-thread routing (M3) ✓ · register+bridge (M4.1) ✓ · panel + gate-iterate loop + reference ingestion + hybrid review/approve/reject (M4.2) ✓ · local-only merge (M1.2 `maestro_si_merge`, no push) ✓ · guardrails (sandbox policy denies push/deploy/ssh/secrets/outside-paths) ✓ · bounded iteration (N=3 in the loop) ✓ · repo-root open item handled (configured path param) ✓ · testing via temp-repo + true/false gate + sandbox unit tests ✓.
- **Placeholder scan:** every step has real code; deferrals are the explicit out-of-scope items + the M5 open-item validations (grounded).
- **Type/name consistency:** `maestro_si_create/list/diffstat/merge/discard/gate`, `SiSession{id,path,branch}`, `GateResult{ok,steps}`, `decide_sandbox(worktree,tool,input)` are used identically across Rust + the TS bridge (camelCase keys `repoRoot`/`branch`/`commands`); the self-improve agent uses `permission_mode: 'sandbox'`, routed by the Task 3.2 reader-thread branch; `READ_TOOLS`/`Decision` reused from Phase 1 `policy.rs`.

**Out of scope (future):** fully-autonomous/proactive triggering; self-improvement backlog; container sandbox; auto-push/auto-deploy; "Seraphine decides" choosing goals herself.
