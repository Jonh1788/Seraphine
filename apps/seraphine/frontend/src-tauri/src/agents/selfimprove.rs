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
    }

    #[test]
    fn gate_stops_at_first_failure() {
        let p = std::env::temp_dir().to_str().unwrap().to_string();
        let r = maestro_si_gate(p.clone(), vec!["true".into(), "false".into(), "true".into()]).unwrap();
        assert!(!r.ok); assert_eq!(r.steps.len(), 2); assert!(r.steps[0].ok); assert!(!r.steps[1].ok);
        let g = maestro_si_gate(p, vec!["true".into(), "true".into()]).unwrap();
        assert!(g.ok); assert_eq!(g.steps.len(), 2);
    }
}
