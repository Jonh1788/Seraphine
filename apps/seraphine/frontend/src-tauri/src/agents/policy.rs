//! Permission policy: given a mode and a tool name, decide auto-allow,
//! auto-deny, or escalate-to-user.
use serde_json::Value;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Decision { Allow, Deny, Escalate }

#[derive(Clone, Copy)]
pub enum Mode { AskAll, AutoReads, FullAuto }

const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead"];
const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];
const DENY_BASH: &[&str] = &["git push", "ssh ", "scp ", "rsync ", "tauri build", "tauri:install", "docker ", " deploy"];

pub fn decide(mode: Mode, tool: &str) -> Decision {
    match mode {
        Mode::FullAuto => Decision::Allow,
        Mode::AskAll => Decision::Escalate,
        Mode::AutoReads => if READ_TOOLS.contains(&tool) { Decision::Allow } else { Decision::Escalate },
    }
}

/// Map the frontend policy string to a Mode (default: AskAll).
pub fn parse_mode(s: &str) -> Mode {
    match s { "full_auto" => Mode::FullAuto, "auto_reads" => Mode::AutoReads, _ => Mode::AskAll }
}

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
mod tests {
    use super::*;
    #[test]
    fn modes_behave() {
        assert_eq!(decide(Mode::FullAuto, "Bash"), Decision::Allow);
        assert_eq!(decide(Mode::AskAll, "Read"), Decision::Escalate);
        assert_eq!(decide(Mode::AutoReads, "Read"), Decision::Allow);
        assert_eq!(decide(Mode::AutoReads, "Write"), Decision::Escalate);
    }
    #[test]
    fn parse_mode_maps() {
        assert!(matches!(parse_mode("full_auto"), Mode::FullAuto));
        assert!(matches!(parse_mode("auto_reads"), Mode::AutoReads));
        assert!(matches!(parse_mode("anything_else"), Mode::AskAll));
    }
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
