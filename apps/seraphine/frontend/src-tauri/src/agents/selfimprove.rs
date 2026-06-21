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
