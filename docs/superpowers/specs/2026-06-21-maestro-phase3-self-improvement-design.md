# Maestro Phase 3 — Directed Self-Improvement (gated) — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Builds on:** Phase 1 + Phase 2 (both merged to `main`).

## Vision / scope (v1)

Let Seraphine improve her **own** codebase: the user gives a goal (optionally with reference **links** — a GitHub repo or an article — to learn from), Seraphine launches an agent on her own repo in an **isolated git worktree**, iterates until the build/tests pass, and presents the change for the user's review. **Nothing merges without the user's explicit approval, and nothing is ever pushed or deployed by Seraphine.**

This reuses the Phase 1/2 supervisor: the self-improve agent is just an **owned headless agent** whose cwd is the worktree of `Projeto-Seraphine`.

**In scope (v1):**
- User-directed goal (free text) + optional reference URLs.
- Reference ingestion: the agent reads GitHub/article links via its built-in **WebFetch/WebSearch** (and may `git clone` a repo into a temp scratch dir to read it). The "observe what's good in `<link>` and adapt what fits here" pattern is first-class.
- Isolated git worktree per self-improve session; auto-iterate to a green build/test gate (bounded).
- Hybrid review in Maestro: summary + diffstat + gate result + Approve (local merge → `main`) / Reject (discard or iterate). Full diff inspected in the user's editor.
- A sandbox permission policy that confines the agent's writes to the worktree and blocks network-escape/deploy.

**Out of scope (later):** fully-autonomous / proactive triggering ("Seraphine decides what to improve"); a self-improvement backlog; container sandbox (stronger than worktree + denylist); auto-push/auto-deploy.

## The loop

1. **Start:** user enters a goal (+ optional reference URLs) in the Maestro "Melhorar a Seraphine" panel.
2. **Isolate:** Maestro creates a worktree `.worktrees/selfimprove-<id>` on branch `selfimprove/<slug>` from `main` HEAD.
3. **Work:** spawn an owned agent (Phase 1 supervisor) with `cwd` = the worktree and a composed prompt: the goal + the reference URLs (instructing it to read them via WebFetch and adapt what fits, NOT to copy reference repos into the tree — clone to a temp scratch dir if needed). Stream renders in Maestro.
4. **Gate:** when the agent finishes a turn, run the gate in the worktree: `cargo build` + `cargo test agents:: --lib` + `cargo test --test supervisor` + `npm run build` (configurable). Capture pass/fail + tail of output.
5. **Iterate (bounded):** if the gate fails, send the failing output back to the agent (`send_to_agent`) to fix; re-gate. Up to **N=3** attempts. After N, stop and present the current state + logs.
6. **Ready for review:** on a green gate (or after N), mark the session "ready". Maestro shows the agent summary, `git diff --stat main`, the changed files, and the gate result.
7. **Decide:** **Approve** → `git merge --no-ff selfimprove/<slug>` into local `main`, remove the worktree (branch kept). **Reject** → remove the worktree + delete the branch, OR iterate (send more user feedback to the agent).

## Architecture

Reuses Phase 1/2 for the agent. New pieces are thin.

### Rust — worktree lifecycle (`src/agents/selfimprove.rs`, new)
- `maestro_si_create(slug) -> { id, path, branch }`: `git worktree add .worktrees/selfimprove-<id> -b selfimprove/<slug> HEAD` (run from the repo root, discovered via `git rev-parse --show-toplevel` of the app's own location, or a configured repo path). Returns the worktree path (used as the agent cwd).
- `maestro_si_diffstat(branch) -> { files: [{path, added, removed}], summary }`: `git diff --stat main...selfimprove/<slug>` parsed.
- `maestro_si_merge(branch) -> Result`: `git switch main && git merge --no-ff <branch>`; on conflict, abort + return the conflict list (the session stays open for the user).
- `maestro_si_discard(id, branch)`: `git worktree remove --force <path>` + `git branch -D <branch>`.
- All git commands run with an explicit `-C <repo-root>` so they never depend on the process cwd.

### Rust — gate runner (`selfimprove.rs`)
- `maestro_si_gate(path) -> GateResult`: run the configured commands in `<path>` sequentially (`cargo build`, `cargo test agents:: --lib`, `cargo test --test supervisor`, `npm run build`), each with a timeout; return `{ ok: bool, steps: [{cmd, ok, tail}] }`. Stops at the first failure (returns it).

### Permission policy — sandbox mode (`policy.rs`, extend)
Add a `Mode::Sandbox { worktree: PathBuf }`. `decide` for Sandbox:
- Read tools (Read/Glob/Grep/LS/WebFetch/WebSearch/NotebookRead) → **Allow** (reference ingestion needs WebFetch/WebSearch).
- Write/Edit/NotebookEdit → **Allow** iff the target path is inside `worktree` or the OS temp dir; else **Escalate**.
- Bash → inspect the command: **Deny** if it contains `git push`, `ssh `, `scp `, deploy markers (`docker`, `tauri:install`, `tauri build`), or writes to paths outside the worktree/temp/secrets (`.env`, credentials); **Allow** build/test/git-local/read commands; **Escalate** anything ambiguous.
- This requires the policy to see the tool's **input** (path/command), not just its name — so the permission round-trip carries the tool input (already present in the `control_request.request.input` captured in M0). The reader-thread auto-decision passes `input` to `decide`.

### Frontend — "Melhorar a Seraphine" panel (`src/orchestrator/SelfImprove.tsx`, new; surfaced in `MaestroView`)
- Goal textarea + a "reference URLs" list (add/remove) + Start.
- Session state: streaming agent (reuse `useAgentStream`), the gate result (running/green/failed with the failing step's tail), the diffstat + changed files.
- Approve / Reject (+ "Iterar" with a feedback box) buttons, calling the `maestro_si_*` bridge.
- Bridge `api.ts`: `siCreate`, `siGate`, `siDiffstat`, `siMerge`, `siDiscard`.

## Guardrails (the safety core)

- **File isolation:** the agent's repo edits are confined to the worktree (git) — `main` is never touched until an explicit, reviewed merge.
- **Sandbox policy (input-aware):** auto-allow reads (incl. WebFetch/WebSearch for references) + writes/bash **inside the worktree + temp**; deny `git push`/`ssh`/deploy/secrets/outside-paths; escalate the ambiguous. This is the key new guardrail vs Phase 1's tool-name-only policy.
- **Local-only merge:** Approve runs a LOCAL `git merge` only. Seraphine NEVER pushes to `vps`/`origin` or deploys — the user does that separately (push to `vps` is a production deploy and stays a human action).
- **Bounded iteration:** at most N=3 auto-fix attempts before handing back to the user.
- **References stay out of the tree:** reference repos are cloned to a temp scratch dir (or just WebFetched); only the agent's *adapted* changes land in the worktree, keeping the diff clean and avoiding license/code-copy issues.
- **Off-limits even in the worktree:** secrets/.env, deploy configs (docker-compose, tauri prod conf), and the self-improve/guardrail code itself — writes there escalate.

## Error handling
- Gate fails after N iterations → present the state + the failing step's output; user chooses reject/iterate/approve-anyway.
- Merge conflict on Approve → `git merge --abort`, return the conflicting files; the worktree/branch stay so the user (or another agent turn) can resolve.
- Orphaned worktree (crash) → a `maestro_si_list()` enumerates `.worktrees/selfimprove-*` so the UI can clean them up.
- Agent escapes the sandbox (policy escalation) → surfaced to the user as a pending permission (same Phase 1 round-trip), defaulting to deny on timeout.

## Testing
- **Temp-repo fixture:** tests create a throwaway `git init` repo, exercise `maestro_si_create`/`diffstat`/`merge`/`discard` against it (no touching the real repo). `maestro_si_gate` is tested with a trivial fake gate command (e.g. `true`/`false`) via a configurable command list.
- **Sandbox policy unit tests:** `decide(Sandbox{worktree}, tool, input)` for: WebFetch→Allow; Write inside worktree→Allow; Write outside→Escalate; Bash `git push`→Deny; Bash `cargo test`→Allow; Bash touching `.env`→Deny.
- Frontend: the self-improve panel with mocked bridge (gate states, diffstat, approve/reject).

## Open items to pin during planning
1. How Maestro locates Seraphine's own repo root at runtime (the installed `.app` has no repo cwd) — likely a configured/derived path (e.g. the dev checkout path) stored in settings; document that self-improve runs against a local dev checkout, not the installed bundle.
2. Exact gate command set + per-step timeouts (cargo can be slow) — make it a small configurable list.
3. The input-aware policy's exact "inside worktree" path check (canonicalize + prefix) and the Bash command denylist patterns — validated against real claude tool-call inputs.
