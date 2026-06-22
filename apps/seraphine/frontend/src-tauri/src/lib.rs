//! Seraphine desktop shell — wraps the same Vite-built React UI that the
//! PWA serves, plus native niceties:
//!
//! - System tray icon with Show / Hide / Quit
//! - Global shortcut Cmd+Shift+\\ to toggle the main window
//! - Close button hides instead of quitting (so the app stays "alive"
//!   while the backend keeps running). Quit is tray-only.

#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod agents;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod clipboard;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod cv_triage_zip;
mod health;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod mac_tools;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod mic;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod voice_io;
mod whisper;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        run_mobile();
        return;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    run_desktop();
}

/// iOS/Android entry — minimal Tauri shell that hosts the React UI plus
/// the HealthKit bridge commands. No tray, no global shortcuts, no
/// microphone capture (mobile webviews handle audio natively).
#[cfg(any(target_os = "ios", target_os = "android"))]
fn run_mobile() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            health::health_request_authorization,
            health::health_get_today_summary,
            health::health_get_recent,
            whisper::whisper_status,
            whisper::whisper_prepare,
            whisper::whisper_transcribe_pcm,
            health::health_schedule_background,
        ])
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| unsafe {
                        ios_extend_into_safe_area(webview.inner());
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Tell the iOS WKWebView to render edge-to-edge instead of stopping at
/// `safeAreaLayoutGuide`. Without this, the home-indicator zone is host
/// `UIView` (no page content), so the bottom-nav can never sit flush
/// against the physical screen edge. After this call CSS `env()` still
/// reports the real inset, so layout code stays correct.
///
/// # Safety
/// `wkwebview` must be a valid Objective-C `WKWebView` pointer that
/// remains live for the duration of this call. Only invoke from the
/// Tauri `setup` hook (or another main-thread context) using the
/// pointer obtained from `Webview::inner()`; calling with a dangling
/// pointer or off-thread is undefined behavior. A null pointer is
/// tolerated as a no-op.
#[cfg(target_os = "ios")]
unsafe fn ios_extend_into_safe_area(wkwebview: *mut std::ffi::c_void) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    if wkwebview.is_null() {
        return;
    }
    let wkwebview = wkwebview as *mut AnyObject;
    // UIScrollViewContentInsetAdjustmentNever = 2
    let scroll_view: *mut AnyObject = msg_send![wkwebview, scrollView];
    if !scroll_view.is_null() {
        let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2i64];
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn run_desktop() {
    let toggle_shortcut = Shortcut::new(
        Some(Modifiers::SUPER | Modifiers::SHIFT),
        Code::Backslash,
    );
    let capture_shortcut = Shortcut::new(
        Some(Modifiers::SUPER | Modifiers::SHIFT),
        Code::KeyS,
    );
    let avatar_shortcut = Shortcut::new(
        Some(Modifiers::SUPER | Modifiers::SHIFT),
        Code::KeyA,
    );
    // SDD 017-B — on-demand clipboard assist (Cmd+Shift+V).
    let clipboard_shortcut = Shortcut::new(
        Some(Modifiers::SUPER | Modifiers::SHIFT),
        Code::KeyV,
    );

    tauri::Builder::default()
        .manage(mic::MicState::new())
        .manage(voice_io::VoiceIoState::new())
        .invoke_handler(tauri::generate_handler![
            mic::start_mic_capture,
            mic::stop_mic_capture,
            voice_io::vpio_start,
            voice_io::vpio_stop,
            voice_io::vpio_play_chunk,
            voice_io::vpio_flush_output,
            voice_io::vpio_ring_len,
            clipboard::read_clipboard,
            health::health_request_authorization,
            health::health_get_today_summary,
            health::health_get_recent,
            whisper::whisper_status,
            whisper::whisper_prepare,
            whisper::whisper_transcribe_pcm,
            // 033 — Mac-local tool proxy commands
            mac_tools::run_shell_local,
            mac_tools::read_file_local,
            mac_tools::write_file_local,
            mac_tools::list_dir_local,
            mac_tools::screen_capture_local,
            mac_tools::write_clipboard_local,
            mac_tools::read_clipboard_local,
            // 034 native integrations
            mac_tools::osascript_local,
            mac_tools::shortcuts_run_local,
            mac_tools::open_path_local,
            // 035 screen automation
            mac_tools::screen_click_local,
            mac_tools::screen_type_local,
            mac_tools::screen_key_local,
            // 042 active app
            mac_tools::active_app_local,
            // CV Triage — Task 15: zip a folder of PDFs for upload.
            cv_triage_zip::zip_folder_pdfs,
            // Maestro — agent orchestration (desktop only).
            agents::observer::maestro_list_sessions,
            agents::observer::maestro_read_transcript,
            agents::ssh::maestro_list_hosts,
            agents::ssh::maestro_check_host,
            agents::observer::maestro_list_remote_sessions,
            agents::maestro_spawn_agent,
            agents::maestro_send_to_agent,
            agents::maestro_respond_permission,
            agents::maestro_stop_agent,
            agents::maestro_resume_session,
            agents::maestro_fork_session,
            agents::selfimprove::maestro_si_create,
            agents::selfimprove::maestro_si_list,
            agents::selfimprove::maestro_si_commit,
            agents::selfimprove::maestro_si_diffstat,
            agents::selfimprove::maestro_si_review,
            agents::selfimprove::maestro_si_merge,
            agents::selfimprove::maestro_si_discard,
            agents::selfimprove::maestro_si_gate,
            agents::skills::maestro_skill_extract,
            agents::skills::maestro_skill_publish,
            agents::skills::maestro_skill_list,
        ])
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &toggle_shortcut {
                        toggle_main_window(app);
                    } else if shortcut == &capture_shortcut {
                        // Toggle the dedicated quick-capture floating window.
                        if let Some(window) = app.get_webview_window("quick-capture") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                position_quick_capture(&window);
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.emit("quick-capture-open", ());
                            }
                        }
                    } else if shortcut == &avatar_shortcut {
                        // Toggle the floating avatar companion window.
                        if let Some(window) = app.get_webview_window("avatar-companion") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                position_avatar_companion(&window);
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    } else if shortcut == &clipboard_shortcut {
                        // SDD 017-B — read the clipboard now and hand it
                        // to the main window so the React layer can open
                        // the ClipboardAssistModal with suggested actions.
                        let text = match arboard::Clipboard::new()
                            .and_then(|mut cb| cb.get_text())
                        {
                            Ok(t) => t,
                            Err(_) => String::new(),
                        };
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                            let _ = window.emit("clipboard-assist", text);
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Register global shortcuts.
            app.global_shortcut().register(toggle_shortcut)?;
            app.global_shortcut().register(capture_shortcut)?;
            app.global_shortcut().register(avatar_shortcut)?;
            app.global_shortcut().register(clipboard_shortcut)?;

            // Kick off Whisper model download + context warmup in the
            // background so the first voice input is instant. Errors are
            // swallowed; the frontend can retry via whisper_prepare.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match whisper::whisper_prepare().await {
                    Ok(status) => {
                        log::info!(
                            "whisper ready: {} ({} MB)",
                            status.model_id,
                            status.model_size_bytes / 1_000_000,
                        );
                        let _ = app_handle.emit("whisper-ready", status);
                    }
                    Err(e) => {
                        log::warn!("whisper prepare failed: {e}");
                        let _ = app_handle.emit("whisper-error", e);
                    }
                }
            });

            // Build the system tray.
            let show = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Esconder", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray.png"
            ))?;
            let _tray = TrayIconBuilder::with_id("seraphine-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close button hides instead of quitting — the app is meant
            // to live in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" | "quick-capture" | "avatar-companion" => {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                    _ => {}
                }
            }
            // Auto-hide quick-capture when it loses focus (click outside)
            if let WindowEvent::Focused(false) = event {
                if window.label() == "quick-capture" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn hide_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn toggle_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
    }
}

/// Position the Avatar Companion window in the bottom-right corner,
/// with a small margin from the screen edges.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn position_avatar_companion<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(Some(monitor)) = window.current_monitor() else { return };
    let mon_size = monitor.size();
    let mon_pos = monitor.position();
    let scale = monitor.scale_factor();
    let Ok(win_size) = window.outer_size() else { return };

    let mon_w = mon_size.width as f64 / scale;
    let mon_h = mon_size.height as f64 / scale;
    let mon_x = mon_pos.x as f64 / scale;
    let mon_y = mon_pos.y as f64 / scale;
    let win_w = win_size.width as f64 / scale;
    let win_h = win_size.height as f64 / scale;

    // Bottom-right corner with 24px margin.
    let x = mon_x + mon_w - win_w - 24.0;
    let y = mon_y + mon_h - win_h - 48.0; // slightly higher to clear the dock

    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// Position the Quick Capture window centered horizontally, 15% from the
/// bottom of the current monitor — ChatGPT-style floating overlay.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn position_quick_capture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(Some(monitor)) = window.current_monitor() else { return };
    let mon_size = monitor.size();
    let mon_pos = monitor.position();
    let scale = monitor.scale_factor();
    let Ok(win_size) = window.outer_size() else { return };

    // Convert physical pixels to logical for placement.
    let mon_w = mon_size.width as f64 / scale;
    let mon_h = mon_size.height as f64 / scale;
    let mon_x = mon_pos.x as f64 / scale;
    let mon_y = mon_pos.y as f64 / scale;
    let win_w = win_size.width as f64 / scale;
    let win_h = win_size.height as f64 / scale;

    // Horizontally centered; vertically at 80% down (15% margin from bottom).
    let x = mon_x + (mon_w - win_w) / 2.0;
    let y = mon_y + mon_h - win_h - (mon_h * 0.15);

    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}
