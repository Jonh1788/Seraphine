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
    /// Fresh state. Interception is OFF by default — it is opt-in: the user
    /// flips it on (which also installs the global hook). A `true` default would
    /// make the UI read "on" with no hook actually installed.
    pub fn new(token: String) -> Self {
        ApprovalState {
            enabled: AtomicBool::new(false),
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
// Global PreToolUse hook in ~/.claude/settings.json
// ---------------------------------------------------------------------------
//
// Toggling interception ON installs ONE matcher-group under `hooks.PreToolUse`
// that routes every session's tool calls to this process's approval server:
//
// ```json
// { "matcher": "*", "hooks": [ { "type": "http",
//     "url": "http://127.0.0.1:<PORT>/hooks/pre-tool-use",
//     "headers": { "Authorization": "Bearer <TOKEN>" },
//     "timeout": 600 } ] }
// ```
//
// The token is written LITERALLY (not `$VAR`): Claude spawns hooks from arbitrary
// terminal sessions where our process env never propagates. We own a group by the
// inner `hooks[].url` containing `/hooks/pre-tool-use` — that marker lets us
// reinstall (replacing a stale port) and remove without touching the user's own
// hooks. All existing settings keys and other hook events are preserved verbatim.

/// The path of the route segment that marks a matcher-group as OURS, regardless
/// of port (the port changes per server start).
const HOOK_URL_MARKER: &str = "/hooks/pre-tool-use";

/// `~/.claude/settings.json`. Resolves home the same way `observer.rs` /
/// `skills.rs` reach `~/.claude`: `HOME` env var first (so tests can redirect it),
/// then `dirs::home_dir()`, then `/`.
fn settings_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".claude/settings.json")
}

/// True when this matcher-group is ours, i.e. one of its inner hooks targets a
/// URL containing [`HOOK_URL_MARKER`]. Tolerant of malformed groups (returns
/// false rather than panicking on unexpected shapes).
fn group_is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("url")
                    .and_then(|u| u.as_str())
                    .is_some_and(|u| u.contains(HOOK_URL_MARKER))
            })
        })
        .unwrap_or(false)
}

/// The matcher-group routing tool calls to our server on `port` with `token`.
fn our_group(port: u16, token: &str) -> Value {
    json!({
        "matcher": "*",
        "hooks": [ {
            "type": "http",
            "url": format!("http://127.0.0.1:{port}{HOOK_URL_MARKER}"),
            "headers": { "Authorization": format!("Bearer {token}") },
            "timeout": 600,
        } ]
    })
}

/// Pure, testable: return `settings` with our PreToolUse matcher-group installed
/// (replacing any prior one of ours, so reinstalling updates the port instead of
/// duplicating). Coerces `settings`, `hooks`, and `hooks.PreToolUse` to the
/// required object/array shapes; every other key and hook event is preserved.
pub fn install_hook_json(mut settings: Value, port: u16, token: &str) -> Value {
    if !settings.is_object() {
        settings = json!({});
    }
    let root = settings.as_object_mut().expect("coerced to object above");
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().expect("coerced to object above");
    let pre = hooks.entry("PreToolUse").or_insert_with(|| json!([]));
    if !pre.is_array() {
        *pre = json!([]);
    }
    let pre = pre.as_array_mut().expect("coerced to array above");
    // Drop any prior group of ours so re-install never duplicates and a changed
    // port replaces the stale entry; foreign groups are left in place.
    pre.retain(|g| !group_is_ours(g));
    pre.push(our_group(port, token));
    settings
}

/// Pure, testable inverse of [`install_hook_json`]: strip our PreToolUse
/// matcher-group(s). Idempotent — a no-op when none of ours (or no `PreToolUse`)
/// is present. Empties are tidied: if `PreToolUse` becomes empty the key is
/// removed; an emptied `hooks` object is left as-is (no over-cleaning).
pub fn remove_hook_json(mut settings: Value) -> Value {
    let Some(root) = settings.as_object_mut() else {
        return settings;
    };
    let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return settings;
    };
    let Some(pre) = hooks.get_mut("PreToolUse").and_then(|p| p.as_array_mut()) else {
        return settings;
    };
    pre.retain(|g| !group_is_ours(g));
    if pre.is_empty() {
        hooks.remove("PreToolUse");
    }
    settings
}

/// Read `~/.claude/settings.json` as JSON, defaulting to `{}` when the file is
/// missing or unparseable (so an absent/corrupt settings file degrades to a
/// clean install rather than an error).
fn read_settings() -> Value {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// Atomically write `settings.json`: pretty-print, write a pid-scoped temp file
/// in the SAME dir (so `rename` stays on one filesystem), then rename over the
/// destination — a reader never sees a half-written file. Creates `~/.claude`
/// if missing.
fn write_settings(v: &Value) -> Result<(), String> {
    let path = settings_path();
    let dir = path
        .parent()
        .ok_or_else(|| format!("settings path has no parent: {path:?}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    let pretty =
        serde_json::to_string_pretty(v).map_err(|e| format!("serialize settings: {e}"))?;
    let tmp = dir.join(format!(".settings.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, pretty.as_bytes()).map_err(|e| format!("write {tmp:?}: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename {tmp:?} -> {path:?}: {e}"));
    }
    Ok(())
}

/// Read settings, install our hook for `port`/`token`, write back atomically.
fn install_hook(port: u16, token: &str) -> Result<(), String> {
    write_settings(&install_hook_json(read_settings(), port, token))
}

/// Read settings, strip our hook, write back atomically. No-op-safe.
/// Generate a random-ish Bearer token (16 bytes from /dev/urandom, hex; falls
/// back to time+pid). Modest threat model — the server binds 127.0.0.1 only.
pub fn generate_token() -> String {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read as _;
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("maestro{nanos:x}{:x}", std::process::id())
}

pub fn remove_hook() -> Result<(), String> {
    write_settings(&remove_hook_json(read_settings()))
}

/// Toggle whole-machine permission interception. Flips the in-memory master
/// switch AND (un)installs the global `PreToolUse` hook in `~/.claude/settings.json`
/// so the change takes effect for every Claude session, not just ones we spawned.
/// Errs when the approval server isn't running (no port/token to bind the hook to).
#[tauri::command]
pub fn maestro_set_permission_interception(enable: bool) -> Result<bool, String> {
    let state = state().ok_or("approval server not running")?;
    state.enabled.store(enable, Ordering::Relaxed);
    if enable {
        let port = state.port.load(Ordering::Relaxed) as u16;
        install_hook(port, &state.token)?;
    } else {
        remove_hook()?;
    }
    Ok(enable)
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

    // ---- settings.json hook install/remove (pure json) -------------------

    /// Count matcher-groups in `hooks.PreToolUse` that are ours (by url marker).
    fn our_group_count(settings: &Value) -> usize {
        settings["hooks"]["PreToolUse"]
            .as_array()
            .map(|a| a.iter().filter(|g| group_is_ours(g)).count())
            .unwrap_or(0)
    }

    #[test]
    fn install_preserves_existing_keys_and_writes_our_group() {
        let s = json!({ "env": { "X": "1" }, "skipAutoPermissionPrompt": true });
        let out = install_hook_json(s, 54321, "secret-tok");

        // Untouched siblings.
        assert_eq!(out["env"]["X"], "1");
        assert_eq!(out["skipAutoPermissionPrompt"], true);

        // Our group is present and well-formed.
        let group = &out["hooks"]["PreToolUse"][0];
        assert_eq!(group["matcher"], "*");
        let inner = &group["hooks"][0];
        assert_eq!(inner["type"], "http");
        assert_eq!(inner["timeout"], 600);
        assert!(
            inner["url"].as_str().unwrap().contains("54321"),
            "url must carry the port: {inner}"
        );
        assert!(inner["url"].as_str().unwrap().contains(HOOK_URL_MARKER));
        assert_eq!(inner["headers"]["Authorization"], "Bearer secret-tok");
    }

    #[test]
    fn install_is_idempotent_and_replaces_on_port_change() {
        let once = install_hook_json(json!({}), 1, "t");
        let twice = install_hook_json(once, 1, "t");
        // Re-installing the SAME port/token leaves exactly one group of ours.
        assert_eq!(our_group_count(&twice), 1, "no duplicate on re-install");

        // A different port REPLACES (still exactly one group, now the new port).
        let changed = install_hook_json(twice, 2, "t");
        assert_eq!(our_group_count(&changed), 1, "changed port replaces, no dupe");
        let url = changed["hooks"]["PreToolUse"][0]["hooks"][0]["url"]
            .as_str()
            .unwrap();
        assert!(url.contains(":2/"), "port updated to 2: {url}");
        assert!(!url.contains(":1/"), "stale port 1 gone: {url}");
    }

    #[test]
    fn install_preserves_unrelated_hook_events() {
        let post = json!([ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo hi" } ] } ]);
        let s = json!({ "hooks": { "PostToolUse": post.clone() } });
        let out = install_hook_json(s, 9, "t");

        // The foreign event is byte-for-byte intact.
        assert_eq!(out["hooks"]["PostToolUse"], post);
        // And ours was added under PreToolUse.
        assert_eq!(our_group_count(&out), 1);
    }

    #[test]
    fn install_coerces_non_object_hooks() {
        // A pre-existing `hooks` that isn't an object (or PreToolUse not an array)
        // is coerced rather than panicking, and our group still lands.
        let s = json!({ "hooks": "garbage" });
        let out = install_hook_json(s, 7, "t");
        assert_eq!(our_group_count(&out), 1);

        let s2 = json!({ "hooks": { "PreToolUse": 42 } });
        let out2 = install_hook_json(s2, 7, "t");
        assert_eq!(our_group_count(&out2), 1);
    }

    #[test]
    fn remove_strips_ours_keeps_other_keys_and_events() {
        let installed = install_hook_json(
            json!({ "env": { "X": "1" }, "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [] } ] } }),
            5,
            "t",
        );
        let out = remove_hook_json(installed);

        // Sibling key + foreign event survive.
        assert_eq!(out["env"]["X"], "1");
        assert!(out["hooks"]["PostToolUse"].is_array());
        // Ours is gone, and since it was the only PreToolUse group, the key is removed.
        assert_eq!(our_group_count(&out), 0);
        assert!(
            out["hooks"].get("PreToolUse").is_none(),
            "empty PreToolUse key should be removed: {out}"
        );
    }

    #[test]
    fn remove_preserves_foreign_pre_tool_use_groups() {
        let foreign = json!({ "matcher": "Write", "hooks": [ { "type": "command", "command": "fmt" } ] });
        let installed = install_hook_json(
            json!({ "hooks": { "PreToolUse": [ foreign.clone() ] } }),
            5,
            "t",
        );
        // Sanity: both ours and the foreign group are present after install.
        assert_eq!(installed["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);

        let out = remove_hook_json(installed);
        let pre = out["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1, "only ours removed");
        assert_eq!(pre[0], foreign, "foreign group untouched");
    }

    #[test]
    fn remove_is_noop_when_absent() {
        // No hooks at all.
        let s = json!({ "env": { "X": "1" } });
        assert_eq!(remove_hook_json(s.clone()), s);

        // hooks present but no PreToolUse.
        let s2 = json!({ "hooks": { "PostToolUse": [] } });
        assert_eq!(remove_hook_json(s2.clone()), s2);

        // Non-object settings: returned unchanged.
        let s3 = json!("not an object");
        assert_eq!(remove_hook_json(s3.clone()), s3);
    }

    // ---- settings.json read/write round-trip (temp HOME) -----------------

    // Serialize HOME-mutating tests behind a lock (same rationale as skills.rs).
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    struct HomeGuard {
        prev: Option<std::ffi::OsString>,
    }
    impl HomeGuard {
        fn set(tmp: &std::path::Path) -> Self {
            let prev = std::env::var_os("HOME");
            std::env::set_var("HOME", tmp);
            HomeGuard { prev }
        }
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn unique_tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "approvals-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    #[test]
    fn install_remove_round_trip_on_disk_preserves_user_keys() {
        let _g = HOME_LOCK.lock().unwrap();
        let tmp = unique_tmp("roundtrip");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        let _home = HomeGuard::set(&tmp);

        // Seed a realistic settings.json (matches the real one's keys).
        let seed = json!({
            "env": { "DISABLE_ADAPTIVE_THINKING": "1" },
            "effortLevel": "medium",
            "skipAutoPermissionPrompt": true,
        });
        std::fs::write(
            settings_path(),
            serde_json::to_string_pretty(&seed).unwrap(),
        )
        .unwrap();

        // Install → file gains our hook, keeps user keys, stays valid JSON.
        install_hook(45678, "round-tok").unwrap();
        let after_install = read_settings();
        assert_eq!(after_install["env"]["DISABLE_ADAPTIVE_THINKING"], "1");
        assert_eq!(after_install["effortLevel"], "medium");
        assert_eq!(after_install["skipAutoPermissionPrompt"], true);
        assert_eq!(our_group_count(&after_install), 1);
        let url = after_install["hooks"]["PreToolUse"][0]["hooks"][0]["url"]
            .as_str()
            .unwrap();
        assert!(url.contains("45678"));

        // No temp files left behind by the atomic write.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.join(".claude"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "atomic write must leave no temp files");

        // Remove → our hook gone, user keys intact.
        remove_hook().unwrap();
        let after_remove = read_settings();
        assert_eq!(after_remove["env"]["DISABLE_ADAPTIVE_THINKING"], "1");
        assert_eq!(after_remove["skipAutoPermissionPrompt"], true);
        assert_eq!(our_group_count(&after_remove), 0);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn install_creates_settings_when_file_absent() {
        let _g = HOME_LOCK.lock().unwrap();
        let tmp = unique_tmp("absent");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap(); // no .claude dir yet
        let _home = HomeGuard::set(&tmp);

        // read_settings on a missing file degrades to {} and install creates it.
        install_hook(11, "t").unwrap();
        assert!(settings_path().is_file(), "settings.json should be created");
        assert_eq!(our_group_count(&read_settings()), 1);

        std::fs::remove_dir_all(&tmp).ok();
    }
}
