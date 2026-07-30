//! Relé HTTP para a rede local da casa.
//!
//! O backend roda no VPS e não alcança a LAN. Ele manda um
//! `lan_request` pelo WebSocket de proxy de tools e este comando faz a
//! requisição de dentro de casa.
//!
//! A allowlist é a única coisa entre este relé e um SSRF na rede local,
//! por isso é constante de compilação e não configuração.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);

/// Pares host:porta que o relé pode alcançar. `espmusic.local` é o nome
/// mDNS que o servidor do EspMusic anuncia. Sem IP de reserva: o do PC
/// é DHCP, e uma entrada que envelhece dá falsa sensação de fallback.
const ALLOWED: &[&str] = &["espmusic.local:8080"];

/// Verdadeiro quando `base` é uma URL http:// cujo host:porta está na
/// allowlist. https não é usado na LAN, e recusar qualquer outro esquema
/// já barra `file://` e amigos.
pub fn is_allowed(base: &str) -> bool {
    let rest = match base.strip_prefix("http://") {
        Some(r) => r,
        None => return false,
    };
    let hostport = rest.split('/').next().unwrap_or("");
    ALLOWED.contains(&hostport)
}

#[derive(Debug, Deserialize)]
pub struct LanRequestArgs {
    /// Base absoluta, ex. "http://espmusic.local:8080".
    pub base: String,
    /// "GET" ou "POST".
    pub method: String,
    /// Caminho, ex. "/api/play".
    pub path: String,
    /// Corpo JSON de um POST comum.
    #[serde(default)]
    pub json: Option<serde_json::Value>,
    /// Áudio em base64 — quando presente, o POST vira multipart no
    /// campo `file` e o `json` é ignorado.
    #[serde(default)]
    pub audio_b64: Option<String>,
    #[serde(default)]
    pub audio_filename: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LanResponse {
    pub status: u16,
    pub body: String,
}

#[tauri::command]
pub async fn lan_request(args: LanRequestArgs) -> Result<LanResponse, String> {
    if !is_allowed(&args.base) {
        return Err(format!("host não permitido: {}", args.base));
    }
    let url = format!("{}{}", args.base.trim_end_matches('/'), args.path);
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let req = match args.method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => match args.audio_b64.as_ref() {
            Some(b64) => {
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| format!("base64 inválido: {e}"))?;
                let name = args
                    .audio_filename
                    .clone()
                    .unwrap_or_else(|| "aviso.wav".to_string());
                let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
                let form = reqwest::multipart::Form::new().part("file", part);
                client.post(&url).multipart(form)
            }
            None => client
                .post(&url)
                .json(&args.json.clone().unwrap_or_else(|| serde_json::json!({}))),
        },
        other => return Err(format!("método não suportado: {other}")),
    };

    let resp = req.send().await.map_err(|e| format!("rede: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Ok(LanResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::is_allowed;

    #[test]
    fn allows_the_espmusic_mdns_host() {
        assert!(is_allowed("http://espmusic.local:8080"));
    }

    #[test]
    fn rejects_the_pcs_ip_because_it_is_not_listed() {
        // O IP é DHCP; só o nome mDNS entra na allowlist.
        assert!(!is_allowed("http://192.168.68.62:8080"));
    }

    #[test]
    fn allows_a_base_with_a_trailing_slash() {
        assert!(is_allowed("http://espmusic.local:8080/"));
    }

    #[test]
    fn rejects_an_unlisted_host() {
        assert!(!is_allowed("http://192.168.1.99:8080"));
    }

    #[test]
    fn rejects_the_right_host_on_the_wrong_port() {
        assert!(!is_allowed("http://espmusic.local:9000"));
    }

    #[test]
    fn rejects_a_non_http_scheme() {
        assert!(!is_allowed("file:///etc/passwd"));
    }

    #[test]
    fn rejects_an_allowlisted_host_smuggled_into_the_path() {
        assert!(!is_allowed("http://evil.example.com/espmusic.local:8080"));
    }
}
