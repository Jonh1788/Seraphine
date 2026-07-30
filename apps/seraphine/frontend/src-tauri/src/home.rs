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

/// Verdadeiro quando a URL **já composta** (`base` + `path`) resolve,
/// depois de parseada de verdade, para um host:porta da allowlist.
///
/// `is_allowed` só enxerga o `base`; o `path` entra na URL sem passar
/// por lá e consegue trocar o destino real — `@outro-host/` vira
/// userinfo e o host de verdade passa a ser `outro-host`. Por isso a
/// trava autoritativa é aqui, sobre o que o cliente HTTP realmente vai
/// discar, e por parsing e não por lista de caracteres proibidos.
pub fn resolved_host_allowed(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    // Sem porta explícita o destino é a 80, que precisa constar na
    // allowlist como qualquer outra.
    let port = parsed.port_or_known_default().unwrap_or(80);
    ALLOWED.contains(&format!("{host}:{port}").as_str())
}

/// Compõe a URL final a partir de `base` + `path` e passa as duas
/// travas, devolvendo a URL pronta ou a mensagem de erro já formatada.
///
/// Vive fora de `lan_request` para ter cobertura: o comando é async e
/// dispara HTTP de verdade, então a checagem embutida nele não daria
/// para testar sem rede — e ela é o portão autoritativo, o tipo de
/// código que não pode depender de revisão para não sumir.
pub fn compose_and_check(base: &str, path: &str) -> Result<String, String> {
    if !is_allowed(base) {
        return Err(format!("host não permitido: {base}"));
    }
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    // Trava autoritativa: o `path` também entra na URL, e é ele que
    // consegue mudar o host de verdade. Vale sobre o que o cliente vai
    // discar, não sobre o prefixo que o chamador prometeu.
    if !resolved_host_allowed(&url) {
        return Err(format!("host não permitido: {url}"));
    }
    Ok(url)
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
    let url = compose_and_check(&args.base, &args.path)?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // Sem seguir redirect. As travas rodam uma vez, sobre a URL
        // composta; seguir um 302 mandaria o segundo salto para onde o
        // servidor apontasse, sem passar por elas. Um nome `.local` não
        // é autenticado — qualquer aparelho da LAN pode responder por
        // `espmusic.local` — e um `Location: http://127.0.0.1:.../`
        // alcançaria o loopback do Mac, que a LAN não alcança e onde
        // este mesmo binário sobe o servidor de aprovação do Maestro.
        // Com a política desligada, um 3xx volta como resposta normal.
        .redirect(reqwest::redirect::Policy::none())
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
    use super::{compose_and_check, is_allowed, resolved_host_allowed};

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

    // A URL composta é `base` + `path`. `is_allowed` só validou o
    // `base`, então o `path` é a superfície que sobra — estes testes
    // cobrem a trava que roda sobre o destino real.

    #[test]
    fn allows_an_ordinary_path_under_the_allowlisted_host() {
        assert!(resolved_host_allowed("http://espmusic.local:8080/api/play"));
    }

    #[test]
    fn rejects_a_path_that_smuggles_another_host_as_userinfo() {
        // O `base` aprovado vira userinfo e o host de verdade passa a
        // ser o roteador. Sem parsear a URL composta, isto sairia.
        assert!(!resolved_host_allowed(
            "http://espmusic.local:8080@192.168.1.1/admin"
        ));
    }

    #[test]
    fn rejects_a_path_that_smuggles_the_same_host_on_another_port() {
        assert!(!resolved_host_allowed(
            "http://espmusic.local:8080@espmusic.local:9000/x"
        ));
    }

    #[test]
    fn rejects_the_allowlisted_host_on_the_implicit_default_port() {
        // Sem porta explícita o destino é a 80, que não está na lista.
        assert!(!resolved_host_allowed("http://espmusic.local/api/play"));
    }

    #[test]
    fn rejects_a_composed_url_with_a_non_http_scheme() {
        assert!(!resolved_host_allowed("file:///etc/passwd"));
    }

    #[test]
    fn rejects_a_composed_url_that_does_not_parse() {
        assert!(!resolved_host_allowed("http://espmusic.local:porta/x"));
    }

    // O portão que `lan_request` de fato usa. Sem estes, apagar a
    // checagem de dentro do comando deixaria a suíte verde.

    #[test]
    fn composes_an_ordinary_base_and_path() {
        assert_eq!(
            compose_and_check("http://espmusic.local:8080", "/api/play"),
            Ok("http://espmusic.local:8080/api/play".to_string())
        );
    }

    #[test]
    fn does_not_double_the_slash_when_the_base_ends_in_one() {
        assert_eq!(
            compose_and_check("http://espmusic.local:8080/", "/api/play"),
            Ok("http://espmusic.local:8080/api/play".to_string())
        );
    }

    #[test]
    fn refuses_a_path_that_smuggles_another_host() {
        let err = compose_and_check("http://espmusic.local:8080", "@192.168.1.1/admin")
            .expect_err("um path que troca o host tem que ser recusado");
        assert!(err.contains("host não permitido"), "mensagem foi: {err}");
    }

    #[test]
    fn refuses_a_base_outside_the_allowlist() {
        let err = compose_and_check("http://192.168.1.99:8080", "/api/play")
            .expect_err("base fora da allowlist tem que ser recusada");
        assert!(err.contains("host não permitido"), "mensagem foi: {err}");
    }
}
