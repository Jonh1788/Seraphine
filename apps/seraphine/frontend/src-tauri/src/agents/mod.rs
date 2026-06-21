#![cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod proto;

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
}
static REGISTRY: OnceLock<Mutex<HashMap<String, AgentHandle>>> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(1);
fn registry() -> &'static Mutex<HashMap<String, AgentHandle>> { REGISTRY.get_or_init(|| Mutex::new(HashMap::new())) }
fn claude_bin() -> String { std::env::var("MAESTRO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()) }
fn is_fake() -> bool { claude_bin().ends_with(".sh") }

#[derive(Serialize, Clone)]
struct AgentEvent { agent_id: String, kind: AgentEventKind, raw: Value }

fn spawn_inner(app: &AppHandle, cwd: &str, goal: &str, mode: &str, extra_args: &[String]) -> Result<String, String> {
    let agent_id = format!("agent-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
    let mut cmd = Command::new(claude_bin());
    if is_fake() {
        cmd.arg(std::env::var("MAESTRO_FAKE_FIXTURE").unwrap_or_default());
    } else {
        cmd.args(["-p","--output-format","stream-json","--input-format","stream-json",
                  "--permission-mode","default","--permission-prompt-tool","stdio",
                  "--setting-sources","","--verbose"]);
        for a in extra_args { cmd.arg(a); }
    }
    cmd.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    if !is_fake() {
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
            let _ = app2.emit("maestro:agent-event", AgentEvent { agent_id: id2.clone(), kind, raw: v });
        }
        let _ = app2.emit("maestro:agent-exit", id2.clone());
    });
    registry().lock().unwrap().insert(agent_id.clone(), AgentHandle { child, stdin, cwd: cwd.to_string(), mode: mode.to_string() });
    Ok(agent_id)
}

#[tauri::command]
pub fn maestro_spawn_agent(app: AppHandle, cwd: String, goal: String, permission_mode: String) -> Result<String, String> {
    spawn_inner(&app, &cwd, &goal, &permission_mode, &[])
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
