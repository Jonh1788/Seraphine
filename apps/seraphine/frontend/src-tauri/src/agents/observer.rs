use std::path::PathBuf;
use serde::Serialize;

/// `~/.claude/projects/<slug>/` for an absolute cwd: every `/` → `-`.
pub fn project_slug(cwd: &str) -> String { cwd.replace('/', "-") }

pub fn projects_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".claude/projects")
}

#[derive(Serialize, Clone)]
pub struct SessionInfo { pub session_id: String, pub slug: String, pub cwd: String, pub last_modified_ms: u64 }

/// Read the cwd recorded inside a transcript (first line that has a top-level
/// "cwd"); falls back to a lossy de-slug of the dir name if none is found.
fn cwd_from_transcript(path: &std::path::Path, slug: &str) -> String {
    if let Ok(text) = std::fs::read_to_string(path) {
        for line in text.lines().take(20) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) { return c.to_string(); }
            }
        }
    }
    slug.replacen('-', "/", 1).replace('-', "/")
}

#[tauri::command]
pub fn maestro_list_sessions() -> Result<Vec<SessionInfo>, String> {
    let mut out = Vec::new();
    let base = projects_dir();
    let entries = match std::fs::read_dir(&base) { Ok(e) => e, Err(_) => return Ok(out) };
    for proj in entries.flatten() {
        let p = proj.path();
        if !p.is_dir() { continue; }
        let slug = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if let Ok(files) = std::fs::read_dir(&p) {
            for f in files.flatten() {
                let fp = f.path();
                if fp.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
                let session_id = fp.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                let last_modified_ms = f.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64).unwrap_or(0);
                let cwd = cwd_from_transcript(&fp, &slug);
                out.push(SessionInfo { session_id, slug: slug.clone(), cwd, last_modified_ms });
            }
        }
    }
    out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    Ok(out)
}

#[tauri::command]
pub fn maestro_read_transcript(slug: String, session_id: String, tail: usize) -> Result<Vec<serde_json::Value>, String> {
    let path = projects_dir().join(&slug).join(format!("{session_id}.jsonl"));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > tail { lines = lines.split_off(lines.len() - tail); }
    Ok(lines.iter().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slug_replaces_slashes() {
        assert_eq!(project_slug("/Users/x/Dev/Ars-Animus"), "-Users-x-Dev-Ars-Animus");
    }
}
