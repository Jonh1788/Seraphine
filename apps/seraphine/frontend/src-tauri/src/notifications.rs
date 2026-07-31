//! SDD task 27 — notificação rica com ações ("Marcar pago" / "Adiar 1h").
//!
//! Casca Rust fina sobre `swift/NotificationBridge.swift`. O Swift é dono
//! do `UNUserNotificationCenterDelegate`, das categorias e do tratamento
//! dos toques; aqui só existem os comandos Tauri que a UI usa para
//! agendar, consultar e cancelar.
//!
//! Onde o toque é tratado: **no processo do app**, não no React. As duas
//! ações são de background (`options: []`), então o iOS acorda — ou
//! relança — o app só para chamar o delegate. Ver o cabeçalho do arquivo
//! Swift para o porquê de o delegate ficar de pé antes de
//! `UIApplicationMain`.
//!
//! Fora do iOS todo comando devolve erro em vez de fingir que agendou.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "ios")]
use std::ffi::{c_char, CStr, CString};

/// Lembrete de conta a pagar.
///
/// `task_id` é **obrigatório** e é o alvo do botão "Marcar pago"
/// (`PATCH /tasks/{id}` → `status: completed`). O Swift recusa o
/// agendamento sem ele, de propósito: um botão de notificação sem alvo
/// não teria como avisar que não fez nada.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BillReminder {
    #[serde(rename = "taskId")]
    pub task_id: i64,
    /// Vira "Lembrete · {title}" — a segunda linha do card do handoff.
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// ISO-8601 com offset. Ignorado quando `in_seconds` vem preenchido.
    #[serde(default)]
    pub at: Option<String>,
    /// Atalho para disparar daqui a N segundos (teste e "adiar" manual).
    #[serde(default, rename = "inSeconds")]
    pub in_seconds: Option<u64>,
}

/// Payload de `notifications_run_action` — diagnóstico, roda o mesmo
/// handler do delegate sem depender de um toque real.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRun {
    /// `mark_paid` | `snooze_1h`.
    pub action: String,
    #[serde(default, rename = "taskId")]
    pub task_id: Option<i64>,
    #[serde(default, rename = "notificationId")]
    pub notification_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// JSON cru do bridge (`{"ok":bool,...}`). Re-tipar cada campo aqui só
/// criaria um segundo lugar para manter em sincronia.
pub type BridgeResult = serde_json::Value;

#[cfg(target_os = "ios")]
extern "C" {
    fn seraphine_notifications_install() -> *mut c_char;
    fn seraphine_notifications_request_authorization() -> *mut c_char;
    fn seraphine_notifications_status() -> *mut c_char;
    fn seraphine_notifications_schedule_bill(json: *const c_char) -> *mut c_char;
    fn seraphine_notifications_sync_streak() -> *mut c_char;
    fn seraphine_notifications_cancel(id: *const c_char) -> *mut c_char;
    fn seraphine_notifications_action_log() -> *mut c_char;
    fn seraphine_notifications_run_action(json: *const c_char) -> *mut c_char;
    fn seraphine_notifications_free_string(ptr: *mut c_char);
}

#[cfg(target_os = "ios")]
fn consume(ptr: *mut c_char) -> Result<BridgeResult, String> {
    if ptr.is_null() {
        return Err("notification bridge returned null".to_string());
    }
    let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    unsafe { seraphine_notifications_free_string(ptr) };
    serde_json::from_str(&json).map_err(|e| format!("parse: {e} (payload={json})"))
}

#[cfg(not(target_os = "ios"))]
const NOT_IOS: &str = "notificações ricas só existem no build iOS";

/// Autorização, categorias registradas e notificações pendentes.
#[tauri::command]
pub async fn notifications_status() -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        consume(unsafe { seraphine_notifications_status() })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err(NOT_IOS.to_string())
    }
}

/// Abre o diálogo de permissão do iOS. O onboarding (task 24) é quem
/// chama isto em contexto — o `setup` do app não pergunta nada sozinho.
#[tauri::command]
pub async fn notifications_request_authorization() -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        consume(unsafe { seraphine_notifications_request_authorization() })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err(NOT_IOS.to_string())
    }
}

/// Agenda o lembrete de conta com as ações "Marcar pago" / "Adiar 1h".
#[tauri::command]
pub async fn notifications_schedule_bill(bill: BillReminder) -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        let payload = serde_json::to_string(&bill).map_err(|e| format!("encode: {e}"))?;
        let c = CString::new(payload).map_err(|e| format!("cstring: {e}"))?;
        consume(unsafe { seraphine_notifications_schedule_bill(c.as_ptr()) })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = bill;
        Err(NOT_IOS.to_string())
    }
}

/// Reavalia "streak em risco" contra `/courses/stats` e agenda ou cancela
/// o alerta. Roda sozinho no launch e a cada foreground; o comando existe
/// para a UI forçar a reavaliação depois de concluir uma lição.
#[tauri::command]
pub async fn notifications_sync_streak() -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        consume(unsafe { seraphine_notifications_sync_streak() })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err(NOT_IOS.to_string())
    }
}

/// Cancela uma notificação pendente e as cópias adiadas dela.
#[tauri::command]
pub async fn notifications_cancel(id: String) -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        let c = CString::new(id).map_err(|e| format!("cstring: {e}"))?;
        consume(unsafe { seraphine_notifications_cancel(c.as_ptr()) })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = id;
        Err(NOT_IOS.to_string())
    }
}

/// Últimas ações tratadas, lidas do App Group. É por aqui que a UI
/// descobre, depois do fato, que um "Marcar pago" falhou — o botão já
/// sumiu quando o handler roda.
#[tauri::command]
pub async fn notifications_action_log() -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        consume(unsafe { seraphine_notifications_action_log() })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err(NOT_IOS.to_string())
    }
}

/// Diagnóstico: roda o mesmo handler que o delegate roda. Prova o caminho
/// até o backend — **não** prova a entrega da resposta pelo iOS.
#[tauri::command]
pub async fn notifications_run_action(action: ActionRun) -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        let payload = serde_json::to_string(&action).map_err(|e| format!("encode: {e}"))?;
        let c = CString::new(payload).map_err(|e| format!("cstring: {e}"))?;
        consume(unsafe { seraphine_notifications_run_action(c.as_ptr()) })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = action;
        Err(NOT_IOS.to_string())
    }
}

/// Chamado uma vez do hook `setup` do Tauri: instala o delegate, registra
/// as categorias e liga o watcher do streak.
///
/// Precisa rodar cedo. `tauri::Builder::build()` — onde o `setup` roda —
/// acontece antes de `EventLoop::run` chamar `UIApplicationMain`, ou seja
/// antes de `application:didFinishLaunchingWithOptions:`. É o que garante
/// que uma resposta de notificação entregue num relançamento em background
/// encontre o delegate já instalado.
#[cfg(target_os = "ios")]
pub fn install() {
    match consume(unsafe { seraphine_notifications_install() }) {
        Ok(v) => log::info!("[notifications] instalado: {v}"),
        Err(e) => log::warn!("[notifications] instalação falhou: {e}"),
    }
}
