//! 033 — Mac-local tool proxy commands.
//!
//! These Tauri commands are invoked by the frontend's `tool_proxy_request`
//! handler whenever the VPS backend needs to execute something on the
//! user's machine (shell, filesystem, screen capture, clipboard write).
//!
//! Desktop-only (`#[cfg(not(any(target_os = "ios", target_os = "android")))]`)
//! because iOS has neither a shell nor `screencapture`.

#![cfg(not(any(target_os = "ios", target_os = "android")))]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;

const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_BYTES: usize = 8 * 1024;
const SHELL_TIMEOUT_SECS: u64 = 60;

fn expand_path(raw: &str) -> PathBuf {
    if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(raw)
}

#[derive(Serialize)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Run a shell command on the Mac. Captures stdout/stderr (truncated).
/// 60s hard timeout.
#[tauri::command]
pub fn run_shell_local(command: String, cwd: Option<String>) -> Result<ShellOutput, String> {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();

    let cwd_path = cwd
        .as_ref()
        .map(|p| expand_path(p))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")));

    thread::spawn(move || {
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(&command)
            .current_dir(&cwd_path)
            .output();
        let _ = tx.send(output);
    });

    match rx.recv_timeout(Duration::from_secs(SHELL_TIMEOUT_SECS)) {
        Ok(Ok(out)) => {
            let mut stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let mut stderr = String::from_utf8_lossy(&out.stderr).to_string();
            if stdout.len() > MAX_OUTPUT_BYTES {
                stdout.truncate(MAX_OUTPUT_BYTES);
                stdout.push_str("\n… [truncated]");
            }
            if stderr.len() > MAX_OUTPUT_BYTES {
                stderr.truncate(MAX_OUTPUT_BYTES);
                stderr.push_str("\n… [truncated]");
            }
            Ok(ShellOutput {
                stdout,
                stderr,
                code: out.status.code().unwrap_or(-1),
            })
        }
        Ok(Err(e)) => Err(format!("spawn failed: {}", e)),
        Err(_) => Err("timeout".into()),
    }
}

#[tauri::command]
pub fn read_file_local(path: String) -> Result<String, String> {
    let p = expand_path(&path);
    let bytes = fs::read(&p).map_err(|e| format!("read failed: {}", e))?;
    let truncated = if bytes.len() > MAX_READ_BYTES {
        &bytes[..MAX_READ_BYTES]
    } else {
        &bytes[..]
    };
    Ok(String::from_utf8_lossy(truncated).to_string())
}

#[tauri::command]
pub fn write_file_local(path: String, content: String) -> Result<(), String> {
    let p = expand_path(&path);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&p, content).map_err(|e| format!("write failed: {}", e))
}

#[tauri::command]
pub fn list_dir_local(path: String) -> Result<Vec<String>, String> {
    let p = expand_path(&path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    let mut out: Vec<String> = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| format!("read_dir failed: {}", e))? {
        if let Ok(entry) = entry {
            let name = entry.file_name().to_string_lossy().to_string();
            let suffix = if entry
                .file_type()
                .map(|t| t.is_dir())
                .unwrap_or(false)
            {
                "/"
            } else {
                ""
            };
            out.push(format!("{}{}", name, suffix));
        }
    }
    out.sort();
    Ok(out)
}

/// Capture the primary screen via `screencapture`. Returns base64-encoded PNG.
#[tauri::command]
pub fn screen_capture_local() -> Result<String, String> {
    let tmp = std::env::temp_dir().join(format!("seraphine-capture-{}.png", std::process::id()));
    let tmp_path = tmp.as_path();
    let status = Command::new("/usr/sbin/screencapture")
        .arg("-x") // no sound
        .arg(tmp_path)
        .status()
        .map_err(|e| format!("screencapture spawn failed: {}", e))?;
    if !status.success() {
        return Err("screencapture exit != 0".into());
    }
    let bytes = fs::read(tmp_path).map_err(|e| format!("read capture: {}", e))?;
    let _ = fs::remove_file(tmp_path);
    Ok(B64.encode(bytes))
}

#[tauri::command]
pub fn write_clipboard_local(text: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard open: {}", e))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("clipboard set: {}", e))
}

// Convenience: also expose read for consistency with the proxy list.
#[tauri::command]
pub fn read_clipboard_local() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard open: {}", e))?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(_) => Ok(String::new()),
    }
}

// ---------------------------------------------------------------------------
// 034 — Native Mac integrations: osascript, shortcuts, open
// ---------------------------------------------------------------------------

/// Run arbitrary AppleScript. Returns stdout. 15s timeout.
#[tauri::command]
pub fn osascript_local(script: String) -> Result<String, String> {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let out = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(&script)
            .output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(out)) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).to_string())
            }
        }
        Ok(Err(e)) => Err(format!("spawn failed: {}", e)),
        Err(_) => Err("timeout".into()),
    }
}

/// Run a named Shortcut (Shortcuts.app). Optional input piped in.
#[tauri::command]
pub fn shortcuts_run_local(name: String, input: Option<String>) -> Result<String, String> {
    let mut cmd = Command::new("/usr/bin/shortcuts");
    cmd.arg("run").arg(&name);
    let output = if let Some(body) = input {
        use std::io::Write;
        use std::process::Stdio;
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(body.as_bytes());
        }
        child.wait_with_output().map_err(|e| format!("wait failed: {}", e))?
    } else {
        cmd.output().map_err(|e| format!("spawn failed: {}", e))?
    };
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// `open` wrapper — launches file/folder/URL with the default app.
#[tauri::command]
pub fn open_path_local(target: String) -> Result<(), String> {
    let expanded = expand_path(&target);
    let final_target: String = if target.starts_with("http://") || target.starts_with("https://") {
        target
    } else {
        expanded.to_string_lossy().to_string()
    };
    Command::new("/usr/bin/open")
        .arg(&final_target)
        .status()
        .map_err(|e| format!("open failed: {}", e))
        .and_then(|s| if s.success() { Ok(()) } else { Err("open exit != 0".into()) })
}

// ---------------------------------------------------------------------------
// 035 — Screen automation (cliclick) + 042 active app
// ---------------------------------------------------------------------------

fn cliclick() -> &'static str {
    // Homebrew paths (Apple Silicon first, then Intel).
    if Path::new("/opt/homebrew/bin/cliclick").exists() {
        "/opt/homebrew/bin/cliclick"
    } else if Path::new("/usr/local/bin/cliclick").exists() {
        "/usr/local/bin/cliclick"
    } else {
        "cliclick"
    }
}

#[tauri::command]
pub fn screen_click_local(x: f64, y: f64, button: Option<String>) -> Result<(), String> {
    let btn = button.unwrap_or_else(|| "left".to_string());
    let verb = match btn.as_str() {
        "right" => "rc",
        "double" => "dc",
        _ => "c",
    };
    let arg = format!("{}:{},{}", verb, x.round() as i32, y.round() as i32);
    let status = Command::new(cliclick())
        .arg(&arg)
        .status()
        .map_err(|e| format!("cliclick missing? {}", e))?;
    if status.success() { Ok(()) } else { Err("cliclick exit != 0".into()) }
}

#[tauri::command]
pub fn screen_type_local(text: String) -> Result<(), String> {
    let arg = format!("t:{}", text);
    let status = Command::new(cliclick())
        .arg(&arg)
        .status()
        .map_err(|e| format!("cliclick missing? {}", e))?;
    if status.success() { Ok(()) } else { Err("cliclick exit != 0".into()) }
}

#[tauri::command]
pub fn screen_key_local(combo: String) -> Result<(), String> {
    // combo format "cmd+w", "cmd+shift+t". cliclick uses kd:/ku: per key.
    let parts: Vec<&str> = combo.split('+').map(|s| s.trim()).collect();
    if parts.is_empty() { return Err("empty combo".into()); }
    let (mods, key) = parts.split_at(parts.len() - 1);
    let key = key[0];

    let mut args: Vec<String> = Vec::new();
    for m in mods {
        let token = match m.to_lowercase().as_str() {
            "cmd" | "command" => "cmd",
            "ctrl" | "control" => "ctrl",
            "alt" | "option" | "opt" => "alt",
            "shift" => "shift",
            _ => return Err(format!("unknown modifier: {}", m)),
        };
        args.push(format!("kd:{}", token));
    }
    args.push(format!("kp:{}", key.to_lowercase()));
    for m in mods.iter().rev() {
        let token = match m.to_lowercase().as_str() {
            "cmd" | "command" => "cmd",
            "ctrl" | "control" => "ctrl",
            "alt" | "option" | "opt" => "alt",
            "shift" => "shift",
            _ => unreachable!(),
        };
        args.push(format!("ku:{}", token));
    }

    let status = Command::new(cliclick())
        .args(&args)
        .status()
        .map_err(|e| format!("cliclick missing? {}", e))?;
    if status.success() { Ok(()) } else { Err("cliclick exit != 0".into()) }
}

#[derive(Serialize)]
pub struct ActiveApp {
    pub app_name: String,
    pub window_title: String,
}

#[tauri::command]
pub fn active_app_local() -> Result<ActiveApp, String> {
    let script = r#"
    tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set winTitle to ""
        try
            set winTitle to name of front window of frontApp
        end try
        return appName & "|" & winTitle
    end tell
    "#;
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript spawn: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (app_name, window_title) = match raw.split_once('|') {
        Some((a, w)) => (a.to_string(), w.to_string()),
        None => (raw.clone(), String::new()),
    };
    Ok(ActiveApp { app_name, window_title })
}
