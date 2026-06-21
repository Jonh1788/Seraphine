//! SSH host discovery + preflight for remote agents.
use std::path::PathBuf;
use serde::Serialize;

fn ssh_config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".ssh/config")
}

/// Parse plain top-level `Host <alias>` lines from ~/.ssh/config, excluding
/// wildcard patterns (containing `*` or `?`). Include/Match are not expanded.
pub fn parse_hosts(config: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in config.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') { continue; }
        let lower = t.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("host ") {
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

pub fn ssh_bin() -> String { std::env::var("MAESTRO_SSH_BIN").unwrap_or_else(|_| "ssh".into()) }

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
            let low = err.to_lowercase();
            let reachable = !low.contains("connection") && !low.contains("timed out") && !low.contains("could not resolve");
            Ok(HostStatus { reachable, claude_version: None, error: Some(if err.is_empty() { "claude não encontrado no host".into() } else { err }) })
        }
        Err(e) => Ok(HostStatus { reachable: false, claude_version: None, error: Some(format!("ssh falhou: {e}")) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_hosts_excluding_wildcards() {
        let cfg = "# comment\nHost CassinoAPI\n  HostName 1.2.3.4\nHost *\n  User root\nHost a b\nHost gpu?box\n";
        assert_eq!(parse_hosts(cfg), vec!["CassinoAPI".to_string(), "a".to_string(), "b".to_string()]);
    }
}
