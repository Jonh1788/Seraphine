//! Directed self-improvement: isolated worktrees on Seraphine's own repo.
use std::io::Write;
use std::process::{Command, Stdio};
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

/// One-shot AI code review of the branch's changes. Runs `claude -p` (print mode)
/// with the `git diff main...branch` embedded in the prompt (fed via stdin to dodge
/// arg-length limits) and returns the reviewer's prose. Read-only: `-p` without a
/// permission-prompt tool auto-denies any tool the model tries, so it reviews from
/// the diff alone. Blocks for the model round-trip (the frontend shows a spinner).
#[tauri::command]
pub fn maestro_si_review(repo_root: String, branch: String) -> Result<String, String> {
    let diff = git(&repo_root, &["diff", &format!("main...{branch}")])?;
    let diff = diff.trim();
    if diff.is_empty() { return Ok("Sem mudanças para revisar.".to_string()); }
    // Bound the prompt: keep the head of the diff (where structure/intent lives).
    const CAP: usize = 28000;
    let body = if diff.len() > CAP {
        let mut end = CAP;
        while !diff.is_char_boundary(end) { end -= 1; }
        format!("{}\n\n…(diff truncado em {CAP} caracteres)…", &diff[..end])
    } else {
        diff.to_string()
    };
    let prompt = format!(
        "Você é um revisor de código sênior e cético. Revise o diff abaixo — são mudanças de uma auto-melhoria que a Seraphine fez no PRÓPRIO código dela. Baseie-se só no diff (não use ferramentas). Avalie correção, SEGURANÇA (fuga de sandbox, injeção de prompt, exfiltração), qualidade e se está pronto pra mesclar no `main`. Responda em PT-BR, conciso e direto, neste formato:\n\nVeredito: APROVAR | APROVAR COM RESSALVAS | NÃO MESCLAR\nResumo: 1-2 frases.\nPontos: bullets curtos (bug/risco/nit) citando o arquivo. Se algo bloquear o merge, deixe explícito.\n\n--- DIFF (git diff main...{branch}) ---\n{body}"
    );
    let mut child = Command::new(crate::agents::claude_bin())
        .arg("-p").arg("--setting-sources").arg("")
        .current_dir(&repo_root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("claude falhou ao iniciar: {e}"))?;
    child.stdin.take().ok_or("sem stdin")?.write_all(prompt.as_bytes())
        .map_err(|e| format!("write prompt: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("claude -p: {e}"))?;
    if !out.status.success() {
        return Err(format!("claude -p erro: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
        let r = maestro_si_gate(p.clone(), vec!["true".into(), "false".into(), "true".into()]).unwrap();
        assert!(!r.ok); assert_eq!(r.steps.len(), 2); assert!(r.steps[0].ok); assert!(!r.steps[1].ok);
        let g = maestro_si_gate(p, vec!["true".into(), "true".into()]).unwrap();
        assert!(g.ok); assert_eq!(g.steps.len(), 2);
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
