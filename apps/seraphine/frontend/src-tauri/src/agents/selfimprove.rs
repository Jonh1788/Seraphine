//! Directed self-improvement: isolated worktrees on Seraphine's own repo.
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use serde::Serialize;

fn git(repo_root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(repo_root).args(args)
        .output().map_err(|e| format!("git falhou: {e}"))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).to_string()) }
    else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// kebab-case, ascii, max 40 chars — for the branch/worktree name.
// Retained as the canonical server-side slug rule (the client now supplies the slug
// to `maestro_si_create`); exercised by the `slugify_is_kebab` test.
#[allow(dead_code)]
pub fn slugify(goal: &str) -> String {
    let s: String = goal.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let out: String = s.chars().take(40).collect::<String>().trim_matches('-').to_string();
    if out.is_empty() { "session".to_string() } else { out }
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

/// Stage (`add -A`) and commit everything in the worktree so the agent's work —
/// which it makes via Edit/Write WITHOUT committing — becomes real commits on the
/// branch. Without this, `git diff --stat main...branch` shows nothing (no commits)
/// and a merge would bring nothing. Returns false when there was nothing to commit
/// (agent already committed, or no changes). Idempotent.
#[tauri::command]
pub fn maestro_si_commit(repo_root: String, id: String, message: String) -> Result<bool, String> {
    let wt = format!("{repo_root}/.worktrees/selfimprove-{id}");
    git(&wt, &["add", "-A"])?;
    if git(&wt, &["status", "--porcelain"])?.trim().is_empty() { return Ok(false); }
    let msg = if message.trim().is_empty() { "self-improve: alterações do agente".to_string() } else { message };
    git(&wt, &["commit", "-m", &msg])?;
    Ok(true)
}

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

#[derive(Serialize, Clone)]
pub struct GateStep { pub cmd: String, pub ok: bool, pub tail: String, pub timed_out: bool }
#[derive(Serialize, Clone)]
pub struct GateResult { pub ok: bool, pub steps: Vec<GateStep> }

/// Default wall-clock budget for a single gate command (30 min). Generous enough
/// for a cold `cargo build` + test + `npm run build`, but bounded so an
/// agent-authored hanging test or a build stalled on a network fetch can't wedge
/// the self-improve loop forever. Overridable per-call (`timeout_secs`) or via
/// the `MAESTRO_GATE_TIMEOUT_SECS` env var.
const DEFAULT_GATE_TIMEOUT_SECS: u64 = 1800;

fn gate_timeout(explicit: Option<u64>) -> Duration {
    let secs = explicit
        .or_else(|| std::env::var("MAESTRO_GATE_TIMEOUT_SECS").ok().and_then(|s| s.parse().ok()))
        .unwrap_or(DEFAULT_GATE_TIMEOUT_SECS);
    Duration::from_secs(secs.max(1))
}

/// Keep the last `max` bytes of `s`, snapped forward to a UTF-8 char boundary so
/// truncating mid-character can never panic (build output is mostly ascii, but a
/// stray multibyte char in a compiler note must not crash the gate).
fn tail_bytes(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) { start += 1; }
    s[start..].to_string()
}

/// SIGKILL the whole process group `pgid` (negative pid). The gate command runs
/// in its own group (`process_group(0)`), so this also reaps descendants the
/// command spawned — `cargo`, `rustc`, `node`, test binaries — which a plain
/// `child.kill()` of the `/bin/sh` leader would orphan. `kill` is a shell
/// builtin, so this needs no standalone binary on the PATH.
fn kill_group(pgid: i32) {
    let _ = Command::new("/bin/sh").arg("-c").arg(format!("kill -KILL -{pgid} 2>/dev/null")).output();
}

/// Run one `sh -c` gate command with cwd = `cwd`, bounded by `timeout`.
/// Returns `(success, combined_output, timed_out)`. On timeout the whole process
/// group is killed and `timed_out` is true (success forced false). stdout+stderr
/// are drained on threads so a command that fills a pipe buffer can't deadlock
/// against our wait loop.
fn run_with_timeout(cmd: &str, cwd: &str, timeout: Duration) -> (bool, String, bool) {
    let mut child = match Command::new("/bin/sh")
        .arg("-c").arg(cmd)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // new group: lets kill_group() reap the command's descendants
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("spawn {cmd}: {e}"), false),
    };
    let pgid = child.id() as i32; // == leader pid == group id under process_group(0)

    let mut out = child.stdout.take().expect("stdout piped");
    let mut err = child.stderr.take().expect("stderr piped");
    let (tx, rx) = mpsc::channel();
    let txo = tx.clone();
    std::thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); let _ = txo.send(s); });
    std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); let _ = tx.send(s); });

    let deadline = Instant::now() + timeout;
    let (ok, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.success(), false),
            Ok(None) if Instant::now() >= deadline => {
                kill_group(pgid);
                let _ = child.wait();
                break (false, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break (false, false), // wait() errored — treat as a failed step
        }
    };

    // Reader threads finish once the pipes hit EOF (process exit / kill).
    let mut tail = String::new();
    for _ in 0..2 {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_secs(2)) { tail.push_str(&chunk); }
    }
    if timed_out {
        tail.push_str(&format!("\n[Maestro] comando excedeu o limite de {}s e foi encerrado.", timeout.as_secs()));
    }
    (ok, tail, timed_out)
}

/// Each `cmd` is a `sh -c` string run with cwd = `path`. Stops at first failure.
/// Every command is bounded by a wall-clock budget (see `gate_timeout`); a timed
/// out command fails the gate with `timed_out` set so the loop can surface it.
#[tauri::command]
pub fn maestro_si_gate(path: String, commands: Vec<String>, timeout_secs: Option<u64>) -> Result<GateResult, String> {
    let timeout = gate_timeout(timeout_secs);
    let mut steps = Vec::new();
    for cmd in &commands {
        let (ok, tail, timed_out) = run_with_timeout(cmd, &path, timeout);
        let tail = tail_bytes(&tail, 4000);
        steps.push(GateStep { cmd: cmd.clone(), ok, tail, timed_out });
        if !ok { return Ok(GateResult { ok: false, steps }); }
    }
    Ok(GateResult { ok: true, steps })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slugify_is_kebab() {
        assert_eq!(slugify("Melhore o parser de SSH!"), "melhore-o-parser-de-ssh");
        assert_eq!(slugify("  a/b  c  "), "a-b-c");
        assert_eq!(slugify("你好"), "session");
        assert_eq!(slugify("   "), "session");
        assert_eq!(slugify(""), "session");
    }

    #[test]
    fn gate_stops_at_first_failure() {
        let p = std::env::temp_dir().to_str().unwrap().to_string();
        let r = maestro_si_gate(p.clone(), vec!["true".into(), "false".into(), "true".into()], None).unwrap();
        assert!(!r.ok); assert_eq!(r.steps.len(), 2); assert!(r.steps[0].ok); assert!(!r.steps[1].ok);
        assert!(!r.steps[1].timed_out, "an ordinary non-zero exit is a failure, not a timeout");
        let g = maestro_si_gate(p, vec!["true".into(), "true".into()], None).unwrap();
        assert!(g.ok); assert_eq!(g.steps.len(), 2);
    }

    #[test]
    fn gate_kills_command_that_exceeds_timeout() {
        let p = std::env::temp_dir().to_str().unwrap().to_string();
        let start = Instant::now();
        // `sleep 30` with a 1s budget must be killed promptly, not waited out.
        let r = maestro_si_gate(p, vec!["sleep 30".into()], Some(1)).unwrap();
        assert!(start.elapsed() < Duration::from_secs(10), "must not block for the full sleep");
        assert!(!r.ok);
        assert_eq!(r.steps.len(), 1);
        assert!(r.steps[0].timed_out, "step should be marked timed_out");
        assert!(!r.steps[0].ok);
        assert!(r.steps[0].tail.contains("excedeu o limite"), "tail explains the timeout");
    }

    #[test]
    fn gate_timeout_kills_descendants() {
        // A child process group: the gate command backgrounds a long sleep and
        // exits its own shell quickly. Killing only the leader would orphan the
        // sleep; killing the group reaps it. We assert the call returns fast and
        // the spawned grandchild does not keep us blocked.
        let p = std::env::temp_dir().to_str().unwrap().to_string();
        let start = Instant::now();
        let r = maestro_si_gate(p, vec!["sleep 30 & wait".into()], Some(1)).unwrap();
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(r.steps[0].timed_out);
    }

    #[test]
    fn gate_within_budget_passes_and_captures_output() {
        let p = std::env::temp_dir().to_str().unwrap().to_string();
        let r = maestro_si_gate(p, vec!["echo hello-gate".into()], Some(30)).unwrap();
        assert!(r.ok);
        assert!(!r.steps[0].timed_out);
        assert!(r.steps[0].tail.contains("hello-gate"), "stdout is captured");
    }

    #[test]
    fn gate_timeout_resolution_prefers_explicit_then_env_then_default() {
        assert_eq!(gate_timeout(Some(5)), Duration::from_secs(5));
        assert_eq!(gate_timeout(Some(0)), Duration::from_secs(1), "clamped to >= 1s");
        assert_eq!(gate_timeout(None), Duration::from_secs(DEFAULT_GATE_TIMEOUT_SECS));
    }

    #[test]
    fn tail_bytes_keeps_suffix_on_char_boundary() {
        assert_eq!(tail_bytes("abcdef", 3), "def");
        assert_eq!(tail_bytes("short", 100), "short");
        // multibyte: 'é' is 2 bytes; asking for 1 byte must snap forward, not panic
        let s = "é!"; // 3 bytes
        let out = tail_bytes(s, 1);
        assert!(s.ends_with(&out));
    }

    #[test]
    fn commit_captures_uncommitted_work_so_diffstat_shows_it() {
        let tmp = std::env::temp_dir().join(format!("si-commit-{}", std::process::id()));
        let root = tmp.to_str().unwrap().to_string();
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let g = |args: &[&str]| git(&root, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "init"]);

        let s = maestro_si_create(root.clone(), "test".into(), "x".into()).unwrap();
        // Agent makes UNCOMMITTED changes in the worktree (Edit + a new file).
        std::fs::write(format!("{}/a.txt", s.path), "one\ntwo\n").unwrap();
        std::fs::write(format!("{}/new.rs", s.path), "fn x() {}\n").unwrap();

        // The bug: before committing, the commit-to-commit diffstat is empty.
        assert!(maestro_si_diffstat(root.clone(), s.branch.clone()).unwrap().is_empty());

        // The fix: commit captures both files (returns true = something committed).
        assert!(maestro_si_commit(root.clone(), "x".into(), "agent work".into()).unwrap());
        let diff = maestro_si_diffstat(root.clone(), s.branch.clone()).unwrap();
        assert!(diff.iter().any(|d| d.path.contains("a.txt")), "modified file shows");
        assert!(diff.iter().any(|d| d.path.contains("new.rs")), "new file shows");

        // Idempotent: nothing left to commit → false.
        assert!(!maestro_si_commit(root.clone(), "x".into(), "noop".into()).unwrap());

        std::fs::remove_dir_all(&tmp).ok();
    }
}
