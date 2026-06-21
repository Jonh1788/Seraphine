#![cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod observer;
pub mod policy;
pub mod proto;
pub mod selfimprove;
pub mod ssh;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::agents::proto::{classify, AgentEventKind};

struct AgentHandle {
    child: Child,
    stdin: Option<ChildStdin>,
    // `cwd` and `mode` are stored for Milestone 2 (permission policy + restart);
    // unused in this milestone, hence the allow.
    #[allow(dead_code)]
    cwd: String,
    #[allow(dead_code)]
    mode: String,
    // `host` is the ssh alias the agent runs on (None = local); stored for
    // remote observability/handover in later milestones.
    #[allow(dead_code)]
    host: Option<String>,
}
static REGISTRY: OnceLock<Mutex<HashMap<String, AgentHandle>>> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(1);
fn registry() -> &'static Mutex<HashMap<String, AgentHandle>> { REGISTRY.get_or_init(|| Mutex::new(HashMap::new())) }
fn claude_bin() -> String { std::env::var("MAESTRO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()) }
fn is_fake() -> bool { claude_bin().ends_with(".sh") }

#[derive(Serialize, Clone)]
struct AgentEvent { agent_id: String, kind: AgentEventKind, raw: Value }

fn spawn_inner(app: &AppHandle, cwd: &str, goal: &str, mode: &str, host: Option<&str>, extra_args: &[String]) -> Result<String, String> {
    let agent_id = format!("agent-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
    let mut cmd = if let Some(h) = host {
        // Remote: ssh into the host; the remote command sets its own cwd.
        let mut c = Command::new(crate::agents::ssh::ssh_bin());
        c.args(remote_ssh_argv(h, cwd, extra_args));
        c
    } else if is_fake() {
        // Fake harness: replay a captured fixture (no cwd needed).
        let mut c = Command::new(claude_bin());
        c.arg(std::env::var("MAESTRO_FAKE_FIXTURE").unwrap_or_default());
        c
    } else {
        // Local real claude.
        let mut c = Command::new(claude_bin());
        c.args(CLAUDE_FLAGS.iter().map(|s| *s));
        for a in extra_args { c.arg(a); }
        c.current_dir(cwd);
        c
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    if host.is_some() || !is_fake() {
        if let Some(si) = child.stdin.as_mut() {
            // initialize handshake, then the goal as the first user turn.
            let _ = writeln!(si, r#"{{"type":"control_request","request_id":"maestro-init","request":{{"subtype":"initialize","hooks":{{}}}}}}"#);
            let msg = serde_json::json!({"type":"user","message":{"role":"user","content":goal}});
            let _ = writeln!(si, "{}", msg);
        }
    }
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let app2 = app.clone();
    let id2 = agent_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            let v: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
            let kind = classify(&v);
            if let AgentEventKind::PermissionRequest { request_id, tool } = &kind {
                // Decide using the agent's stored policy; auto-respond unless Escalate.
                // SHORT registry lock: do not hold it across the emit below.
                let mut reg = registry().lock().unwrap();
                if let Some(h) = reg.get_mut(&id2) {
                    let mode = crate::agents::policy::parse_mode(&h.mode);
                    match crate::agents::policy::decide(mode, tool) {
                        crate::agents::policy::Decision::Allow => {
                            if let Some(si) = h.stdin.as_mut() { let _ = write_permission_response(si, request_id, true); }
                        }
                        crate::agents::policy::Decision::Deny => {
                            if let Some(si) = h.stdin.as_mut() { let _ = write_permission_response(si, request_id, false); }
                        }
                        crate::agents::policy::Decision::Escalate => { /* leave for the UI via the emitted event */ }
                    }
                }
                drop(reg);
            }
            // Emit in ALL cases so the UI reflects what happened (incl. auto allow/deny).
            let _ = app2.emit("maestro:agent-event", AgentEvent { agent_id: id2.clone(), kind, raw: v });
        }
        let _ = app2.emit("maestro:agent-exit", id2.clone());
    });
    registry().lock().unwrap().insert(agent_id.clone(), AgentHandle { child, stdin, cwd: cwd.to_string(), mode: mode.to_string(), host: host.map(String::from) });
    Ok(agent_id)
}

#[tauri::command]
pub fn maestro_spawn_agent(app: AppHandle, cwd: String, goal: String, permission_mode: String, host: Option<String>) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, host.as_deref(), &[])
}

#[tauri::command]
pub fn maestro_stop_agent(agent_id: String) -> Result<(), String> {
    if let Some(mut h) = registry().lock().unwrap().remove(&agent_id) { let _ = h.child.kill(); }
    Ok(())
}

#[tauri::command]
pub fn maestro_send_to_agent(agent_id: String, text: String) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let h = reg.get_mut(&agent_id).ok_or("unknown agent")?;
    let si = h.stdin.as_mut().ok_or("agent stdin closed")?;
    let msg = serde_json::json!({"type":"user","message":{"role":"user","content":text}});
    writeln!(si, "{}", msg).map_err(|e| format!("write failed: {e}"))?;
    si.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Write a `control_response` answering a `can_use_tool` permission request.
/// REAL shape (verified in M0): camelCase `behavior`, `subtype:"success"` for
/// BOTH allow and deny — the decision lives in the nested `response.behavior`.
fn write_permission_response(si: &mut ChildStdin, request_id: &str, allow: bool) -> Result<(), String> {
    let resp = serde_json::json!({
        "type":"control_response",
        "response":{"subtype":"success","request_id":request_id,
                    "response":{"behavior": if allow {"allow"} else {"deny"}}}
    });
    writeln!(si, "{}", resp).map_err(|e| format!("write failed: {e}"))?;
    si.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn maestro_respond_permission(agent_id: String, request_id: String, allow: bool) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let h = reg.get_mut(&agent_id).ok_or("unknown agent")?;
    let si = h.stdin.as_mut().ok_or("agent stdin closed")?;
    write_permission_response(si, &request_id, allow)
}

#[tauri::command]
pub fn maestro_resume_session(app: AppHandle, session_id: String, cwd: String, goal: String, permission_mode: String) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, None, &["--resume".into(), session_id])
}

#[tauri::command]
pub fn maestro_fork_session(app: AppHandle, session_id: String, cwd: String, goal: String, permission_mode: String) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, None, &["--resume".into(), session_id, "--fork-session".into()])
}

/// POSIX single-quote a string for safe embedding in a shell command.
fn shq(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

/// The claude headless flags shared by local and remote spawns.
const CLAUDE_FLAGS: &[&str] = &[
    "-p", "--output-format", "stream-json", "--input-format", "stream-json",
    "--permission-mode", "default", "--permission-prompt-tool", "stdio",
    "--setting-sources", "", "--verbose",
];

/// Build the full ssh argv for a remote agent. The remote command runs under a
/// login bash so the user's PATH (e.g. ~/.local/bin/claude) is set.
fn remote_ssh_argv(host: &str, cwd: &str, extra: &[String]) -> Vec<String> {
    let flags = CLAUDE_FLAGS.iter().map(|f| if f.is_empty() { "\"\"".to_string() } else { (*f).to_string() }).collect::<Vec<_>>().join(" ");
    let extra_s = extra.join(" ");
    let inner = format!("cd {} && exec claude {} {}", shq(cwd), flags, extra_s);
    let remote = format!("bash -lc {}", shq(inner.trim_end()));
    vec!["-T".into(), "-o".into(), "ControlMaster=auto".into(), "-o".into(), "ControlPersist=60s".into(), host.to_string(), remote]
}

#[cfg(test)]
mod remote_tests {
    use super::*;
    #[test]
    fn builds_remote_argv() {
        let argv = remote_ssh_argv("Cassino", "/srv/app", &["--resume".into(), "abc".into()]);
        assert_eq!(argv[0], "-T");
        assert_eq!(argv[5], "Cassino");
        let remote = &argv[6];
        assert!(remote.starts_with("bash -lc '"), "got {remote}");
        // `inner` is single-quoted as one arg to `bash -lc`, so the cwd's own
        // single-quotes are POSIX-escaped to '\'' inside the outer quoting.
        assert!(remote.contains(r"cd '\''/srv/app'\'' && exec claude"), "got {remote}");
        assert!(remote.contains("--resume abc"), "got {remote}");
        assert!(remote.contains("--permission-prompt-tool stdio"), "got {remote}");
    }
}
