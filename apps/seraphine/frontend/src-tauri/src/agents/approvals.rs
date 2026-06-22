//! Maestro approval server.
//!
//! Claude Code is configured (later milestone) with a global `PreToolUse` hook
//! of `type:"http"` in `~/.claude/settings.json`. For every tool call Claude
//! POSTs the event here and BLOCKS (up to 600s) on the HTTP response; the
//! response body carries the permission decision. We answer with the official
//! contract:
//!
//! ```json
//! { "hookSpecificOutput": {
//!     "hookEventName": "PreToolUse",
//!     "permissionDecision": "allow|deny|ask|defer",
//!     "permissionDecisionReason": "..." } }
//! ```
//!
//! `defer` = don't intercept, let Claude's own rules decide. We return `defer`
//! when approvals are disabled, for read-only "safe" tools, and as the
//! fail-open answer on timeout/unknown — never block real work on a stuck UI.
//!
//! The server is synchronous (`tiny_http`): one accept loop thread, one worker
//! thread per request. A worker that needs a human decision parks on an mpsc
//! channel whose `Sender` lives in `ApprovalState.pending` keyed by request id;
//! the `maestro_resolve_permission` command (driven by the UI) looks the id up,
//! removes the sender, and sends the `Decision`, unparking the worker.
//!
//! This is Milestone 1: the server + decision/pending machinery + the resolve
//! command only. Installing the global hook, the UI, and wiring `start_server`
//! into app startup land in later milestones — so most of the public surface
//! here has no in-tree caller yet and the module is `allow(dead_code)`.
//! (`unused_imports` is also allowed: the `Read` trait is used only inside the
//! still-uncalled `handle`, so the compiler flags it until startup wires it in.)
#![allow(dead_code, unused_imports)]

use std::collections::HashMap;
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Tools that never need a human decision — read-only or local-only — so the
/// hook auto-`defer`s them and Claude's normal rules apply. Keeps the approval
/// queue focused on side-effecting tools (Bash/Write/Edit/network/etc.).
const SAFE_TOOLS: &[&str] = &[
    "Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "Task", "WebSearch",
];

/// Longest we hold a Claude request open waiting for the human. Claude's own
/// timeout is 600s; we answer at 590s with `defer` so the worker always wins
/// the race and Claude never sees a hook timeout (which would be non-blocking
/// and proceed anyway, but a clean `defer` is the documented contract).
const WAIT_TIMEOUT: Duration = Duration::from_secs(590);

/// A human (or fail-open) decision for one parked permission request.
#[derive(Debug, Clone)]
pub struct Decision {
    pub allow: bool,
    pub reason: String,
}

/// Shared server state. Behind `Arc`, stored in the [`STATE`] global so the
/// Tauri commands and the accept/worker threads see the same instance.
pub struct ApprovalState {
    /// Master switch. When false, every request auto-`defer`s. Atomic so the
    /// UI can flip it without locking.
    pub enabled: AtomicBool,
    /// Bearer token Claude must present (`Authorization: Bearer <token>`).
    pub token: String,
    /// id -> Sender for requests currently parked awaiting a human decision.
    pub pending: Mutex<HashMap<String, Sender<Decision>>>,
    /// Monotonic counter for request ids (paired with the tool name).
    counter: AtomicU64,
    /// Bound port, filled in by [`start_server`]; 0 until the server starts.
    port: AtomicU64,
}

impl ApprovalState {
    /// Fresh state with a random-ish token and approvals enabled.
    pub fn new(token: String) -> Self {
        ApprovalState {
            enabled: AtomicBool::new(true),
            token,
            pending: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
            port: AtomicU64::new(0),
        }
    }

    fn next_id(&self, tool_name: &str) -> String {
        format!("{}-{}", self.counter.fetch_add(1, Ordering::SeqCst), tool_name)
    }
}

/// Module global so commands + server threads share one `ApprovalState`.
/// Mirrors the `OnceLock<Mutex<...>>` REGISTRY pattern in `agents/mod.rs`
/// (here the inner value is already `Arc`-shared + internally synchronized, so
/// no outer Mutex is needed).
static STATE: OnceLock<Arc<ApprovalState>> = OnceLock::new();

/// Install the process-wide `ApprovalState` (idempotent — first writer wins)
/// and return the shared handle. Called by `start_server`; the commands read it
/// back via [`state`].
pub fn init_state(s: Arc<ApprovalState>) -> Arc<ApprovalState> {
    let _ = STATE.set(s);
    STATE.get().expect("state set above").clone()
}

/// The process-wide `ApprovalState`, or `None` if the server hasn't started.
pub fn state() -> Option<Arc<ApprovalState>> {
    STATE.get().cloned()
}

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested) — no I/O, no Tauri.
// ---------------------------------------------------------------------------

/// Static, side-effect-free decision: `Some("defer")` when approvals are off OR
/// the tool is read-only/safe; `None` when the tool needs a human decision.
pub fn decide_static(tool_name: &str, enabled: bool) -> Option<&'static str> {
    if !enabled || SAFE_TOOLS.contains(&tool_name) {
        Some("defer")
    } else {
        None
    }
}

/// Build the `hookSpecificOutput` body for one decision. `reason` is omitted
/// when empty (Claude treats `permissionDecisionReason` as optional).
fn body(decision: &str, reason: &str) -> String {
    let mut out = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
        }
    });
    if !reason.is_empty() {
        out["hookSpecificOutput"]["permissionDecisionReason"] = json!(reason);
    }
    out.to_string()
}

/// Body that tells Claude to fall back to its own permission rules.
fn defer_body() -> String {
    body("defer", "")
}

/// Body that approves the tool call.
fn allow_body(reason: &str) -> String {
    body("allow", reason)
}

/// Body that blocks the tool call (reason surfaces to Claude/the user).
fn deny_body(reason: &str) -> String {
    body("deny", reason)
}

/// Compact, human-readable one-liner describing a tool call for the UI queue.
/// Prefers the obvious "what does this do" field (Bash `command`, the various
/// `*_path` / `pattern` / `url` fields); otherwise falls back to compact JSON.
/// Always capped to ~300 chars so a giant Write payload can't bloat the event.
fn summarize_input(tool_input: &Value) -> String {
    const CAP: usize = 300;
    let pick = |k: &str| tool_input.get(k).and_then(|v| v.as_str());
    let raw = pick("command")
        .or_else(|| pick("file_path"))
        .or_else(|| pick("path"))
        .or_else(|| pick("pattern"))
        .or_else(|| pick("url"))
        .or_else(|| pick("query"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| tool_input.to_string());
    if raw.chars().count() > CAP {
        let truncated: String = raw.chars().take(CAP).collect();
        format!("{truncated}…")
    } else {
        raw
    }
}

// ---------------------------------------------------------------------------
// Resolve (testable core + Tauri command)
// ---------------------------------------------------------------------------

/// Core of `maestro_resolve_permission`, factored out so it's unit-testable
/// without a Tauri runtime: pop the parked sender for `id` and deliver the
/// decision, unparking the waiting worker. Err if the id is unknown (already
/// resolved, timed out, or never existed).
pub fn resolve(state: &ApprovalState, id: &str, decision: Decision) -> Result<(), String> {
    let tx = {
        let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
        pending.remove(id)
    };
    match tx {
        Some(tx) => tx.send(decision).map_err(|_| "worker gone".to_string()),
        None => Err("unknown id".to_string()),
    }
}

/// UI-driven decision for a parked permission request.
#[tauri::command]
pub fn maestro_resolve_permission(id: String, allow: bool, reason: String) -> Result<(), String> {
    let state = state().ok_or("approval server not running")?;
    resolve(&state, &id, Decision { allow, reason })
}

/// Whether approvals are on + the bound port (0 if the server isn't running).
#[tauri::command]
pub fn maestro_approvals_status() -> Value {
    match state() {
        Some(s) => json!({
            "enabled": s.enabled.load(Ordering::Relaxed),
            "port": s.port.load(Ordering::Relaxed),
        }),
        None => json!({ "enabled": false, "port": 0 }),
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/// `~/.maestro` — where we publish the live `server.json` for the hook to read.
fn maestro_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".maestro")
}

/// Publish `~/.maestro/server.json` = `{port, token, pid}` so a later milestone
/// can wire the global hook to this exact port/token. Best-effort: creates the
/// dir (chmod 0700 on unix) and writes the file; failures are returned to the
/// caller of `start_server`.
fn write_server_json(port: u16, token: &str) -> std::io::Result<()> {
    let dir = maestro_dir();
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let payload = json!({ "port": port, "token": token, "pid": std::process::id() });
    std::fs::write(dir.join("server.json"), payload.to_string())
}

/// Bind a localhost HTTP server on an ephemeral port, publish `server.json`,
/// install the shared state, and spawn the accept loop. Returns the bound port.
///
/// Not started anywhere yet (Milestone 4 wires it into app startup); this just
/// has to compile and be self-contained.
pub fn start_server(app: AppHandle, state: Arc<ApprovalState>) -> std::io::Result<u16> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        // tiny_http can bind a unix socket; we always ask for an IP, so this
        // arm is unreachable in practice but must be handled for the match.
        _ => return Err(std::io::Error::new(std::io::ErrorKind::Other, "non-IP listen addr")),
    };

    write_server_json(port, &state.token)?;
    state.port.store(port as u64, Ordering::Relaxed);
    let state = init_state(state);

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            let state = state.clone();
            std::thread::spawn(move || handle(request, app, state));
        }
    });

    Ok(port)
}

/// Respond to one request with a 200 + JSON body.
fn respond_json(request: tiny_http::Request, body: String) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let response = tiny_http::Response::from_string(body)
        .with_status_code(200)
        .with_header(header);
    let _ = request.respond(response);
}

/// Respond with a bare status code (404/401) and empty body.
fn respond_status(request: tiny_http::Request, code: u16) {
    let response = tiny_http::Response::from_string("").with_status_code(code);
    let _ = request.respond(response);
}

/// Handle one `PreToolUse` POST end-to-end: auth, parse, static decide, and —
/// if needed — park on a channel until the human (or the 590s fail-open
/// timeout) resolves it. Always answers HTTP 200 + a hook-output body once it
/// gets past auth/routing.
fn handle(mut request: tiny_http::Request, app: AppHandle, state: Arc<ApprovalState>) {
    // Route.
    if request.method() != &tiny_http::Method::Post || request.url() != "/hooks/pre-tool-use" {
        return respond_status(request, 404);
    }

    // Auth: constant-prefix bearer check.
    let expected = format!("Bearer {}", state.token);
    let authed = request
        .headers()
        .iter()
        .any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected);
    if !authed {
        return respond_status(request, 401);
    }

    // Body.
    let mut body_str = String::new();
    if request.as_reader().read_to_string(&mut body_str).is_err() {
        // Malformed body — fail open so Claude isn't blocked by our parse bug.
        return respond_json(request, defer_body());
    }
    let v: Value = match serde_json::from_str(&body_str) {
        Ok(v) => v,
        Err(_) => return respond_json(request, defer_body()),
    };

    let tool_name = v.get("tool_name").and_then(|x| x.as_str()).unwrap_or("");
    let session_id = v.get("session_id").and_then(|x| x.as_str()).unwrap_or("");
    let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("");
    let tool_input = v.get("tool_input").cloned().unwrap_or_else(|| json!({}));

    // Static fast path: disabled or safe tool → defer.
    if decide_static(tool_name, state.enabled.load(Ordering::Relaxed)).is_some() {
        return respond_json(request, defer_body());
    }

    // Needs a human. Park on a channel keyed by a fresh id.
    let id = state.next_id(tool_name);
    let (tx, rx) = mpsc::channel::<Decision>();
    {
        let mut pending = match state.pending.lock() {
            Ok(p) => p,
            Err(_) => return respond_json(request, defer_body()),
        };
        pending.insert(id.clone(), tx);
    }

    let _ = app.emit(
        "maestro:permission-pending",
        json!({
            "id": id,
            "session_id": session_id,
            "cwd": cwd,
            "tool_name": tool_name,
            "tool_input": summarize_input(&tool_input),
        }),
    );

    let body = match rx.recv_timeout(WAIT_TIMEOUT) {
        Ok(Decision { allow: true, reason }) => allow_body(&reason),
        Ok(Decision { allow: false, reason }) => {
            deny_body(if reason.is_empty() { "Negado pelo Maestro." } else { &reason })
        }
        // Timed out (or sender dropped): fail open.
        Err(_) => defer_body(),
    };

    // Always clear the id — covers the timeout path (resolve() never ran) and
    // is a harmless no-op on the resolved path (resolve already removed it).
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&id);
    }

    respond_json(request, body);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_tool_defers_even_when_enabled() {
        for t in SAFE_TOOLS {
            assert_eq!(decide_static(t, true), Some("defer"), "{t} should defer");
        }
    }

    #[test]
    fn anything_defers_when_disabled() {
        assert_eq!(decide_static("Bash", false), Some("defer"));
        assert_eq!(decide_static("Write", false), Some("defer"));
        assert_eq!(decide_static("SomethingElse", false), Some("defer"));
    }

    #[test]
    fn dangerous_tools_need_human_when_enabled() {
        assert_eq!(decide_static("Bash", true), None);
        assert_eq!(decide_static("Write", true), None);
        assert_eq!(decide_static("Edit", true), None);
    }

    #[test]
    fn defer_body_shape() {
        let v: Value = serde_json::from_str(&defer_body()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "defer");
        // No reason on defer.
        assert!(v["hookSpecificOutput"]["permissionDecisionReason"].is_null());
    }

    #[test]
    fn allow_body_shape() {
        let v: Value = serde_json::from_str(&allow_body("looks good")).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(v["hookSpecificOutput"]["permissionDecisionReason"], "looks good");
    }

    #[test]
    fn deny_body_shape() {
        let v: Value = serde_json::from_str(&deny_body("rm -rf is scary")).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(v["hookSpecificOutput"]["permissionDecisionReason"], "rm -rf is scary");
    }

    #[test]
    fn allow_body_with_empty_reason_omits_reason() {
        let v: Value = serde_json::from_str(&allow_body("")).unwrap();
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(v["hookSpecificOutput"]["permissionDecisionReason"].is_null());
    }

    #[test]
    fn summarize_prefers_command_then_path_then_json() {
        assert_eq!(summarize_input(&json!({ "command": "ls -la" })), "ls -la");
        assert_eq!(summarize_input(&json!({ "file_path": "/tmp/x" })), "/tmp/x");
        // No known field → compact JSON.
        let s = summarize_input(&json!({ "weird": 1 }));
        assert!(s.contains("weird"));
    }

    #[test]
    fn summarize_caps_long_input() {
        let long = "x".repeat(1000);
        let s = summarize_input(&json!({ "command": long }));
        // 300 chars + the ellipsis.
        assert_eq!(s.chars().count(), 301);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn resolve_delivers_decision_and_removes_id() {
        let state = ApprovalState::new("tok".into());
        let (tx, rx) = mpsc::channel::<Decision>();
        state.pending.lock().unwrap().insert("req-1".into(), tx);

        // A worker parked on the channel, mirroring handle()'s wait.
        let handle = std::thread::spawn(move || rx.recv_timeout(WAIT_TIMEOUT));

        resolve(&state, "req-1", Decision { allow: true, reason: "ok".into() }).unwrap();

        let got = handle.join().unwrap().expect("decision delivered");
        assert!(got.allow);
        assert_eq!(got.reason, "ok");
        // Id removed from pending.
        assert!(!state.pending.lock().unwrap().contains_key("req-1"));
    }

    #[test]
    fn resolve_unknown_id_errs() {
        let state = ApprovalState::new("tok".into());
        let err = resolve(&state, "nope", Decision { allow: false, reason: String::new() })
            .unwrap_err();
        assert_eq!(err, "unknown id");
    }

    #[test]
    fn status_without_server_is_disabled() {
        // Pure shape check on the no-state branch (the global may or may not be
        // set depending on test order, so only assert the keys exist).
        let v = maestro_approvals_status();
        assert!(v.get("enabled").is_some());
        assert!(v.get("port").is_some());
    }
}
