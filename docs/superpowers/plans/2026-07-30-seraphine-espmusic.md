# Seraphine × EspMusic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar à Seraphine quatro tools (`home_play`, `home_control`, `home_announce`, `home_status`) que controlam o sistema de som EspMusic da casa, com os avisos falados na voz dela.

**Architecture:** O backend da Seraphine roda no VPS e o EspMusic só existe na LAN. As tools rodam no VPS e chamam um adaptador de domínio; o adaptador fala por um transporte que empacota a chamada HTTP e a manda para o app Tauri pelo WebSocket de proxy que já existe. No Mac, um comando Rust (`lan_request`) valida o destino contra uma allowlist e faz a requisição de dentro de casa. `lan_request` **não** é registrado no registry — o LLM nunca vê um escape hatch de HTTP genérico.

**Tech Stack:** Python 3.13 / FastAPI / pytest (backend), TypeScript / vitest (frontend), Rust / Tauri 2 / reqwest (cliente), FastAPI (EspMusic, repo separado).

## Global Constraints

- Backend: rodar testes de `apps/seraphine/backend` com `uv run pytest`. `asyncio_mode = "auto"` — testes `async def` **não** levam `@pytest.mark.asyncio`.
- Frontend: rodar testes de `apps/seraphine/frontend` com `pnpm test` (vitest). Testes vivem em `__tests__/` ao lado do módulo.
- Rust: rodar testes com `cargo test` em `apps/seraphine/frontend/src-tauri`.
- Tools novas herdam de `seraphine.tools.base.Tool` e devolvem `ToolResult`.
- Nas descrições das tools `home_*`, dizer explicitamente para usar **só** quando o usuário citar cômodo ou a casa, e apontar `play_music` para o caso do Mac. Sem isso o LLM confunde com as tools de navegador de `tools/browser.py`.
- O endereço do EspMusic é constante em dois lugares que **precisam concordar**: `ALLOWED` em `src-tauri/src/home.rs` e `DEFAULT_BASE` em `seraphine/home/transport.py`. Valor: `http://espmusic.local:8080`.
- O IP de reserva na allowlist (`192.168.1.50:8080` no plano) é um placeholder do endereço real do PC Windows — Jonathan confirma o IP na Task 2 antes do commit.
- Repo separado: a Task 1 acontece em `~/Dev/HomeEspSera`, com commit próprio lá. Todas as outras acontecem em `~/Dev/Projeto-Seraphine`, na branch `feat/home-espmusic`.
- Spec: `docs/superpowers/specs/2026-07-30-seraphine-espmusic-design.md`.

## File Structure

**EspMusic** (`~/Dev/HomeEspSera`)
- `server/api.py` — ganha `POST /api/announce` (multipart) e os imports `File`, `UploadFile`, `tempfile`.
- `server/requirements.txt` — ganha `python-multipart` (exigido pelo FastAPI para `UploadFile`).

**Cliente Tauri** (`apps/seraphine/frontend`)
- `src-tauri/src/home.rs` *(novo)* — allowlist + comando `lan_request`. Única peça que toca a LAN.
- `src-tauri/src/lib.rs` — `mod home;` e registro do comando nos **dois** `invoke_handler` (mobile e desktop).
- `src-tauri/Cargo.toml` — dependência `reqwest` sem TLS.
- `src/tool-proxy/index.ts` — handler `lan_request`; `handlers` passa a ser exportado para teste.
- `src/tool-proxy/__tests__/lanRequest.test.ts` *(novo)*.

**Backend** (`apps/seraphine/backend`)
- `seraphine/home/__init__.py` *(novo)*.
- `seraphine/home/transport.py` *(novo)* — `LanTransport`, exceções de domínio. É o arquivo que a v2 (bridge outbound) substitui.
- `seraphine/home/espmusic.py` *(novo)* — `EspMusicAdapter`, slug de cômodo, conversão %↔dB.
- `seraphine/home/service.py` *(novo)* — `HomeService`, ponto de extensão para luzes/garagem/piscina.
- `seraphine/tools/home.py` *(novo)* — as quatro tools.
- `seraphine/main.py` — registro tardio das tools (precisa de `app.state` e de `tts`).
- `tests/home/test_transport.py`, `tests/home/test_espmusic_adapter.py`, `tests/home/test_home_tools.py` *(novos)*.

---

### Task 1: EspMusic — endpoint `/api/announce`

Recebe um áudio pronto (a voz da Seraphine) e o toca com prioridade de aviso. O `/api/say` que já existe usa o TTS do Windows e não serve.

**Files:**
- Modify: `~/Dev/HomeEspSera/server/api.py:17-23` (imports) e a seção "avisos" (`api.py:204-229`)
- Modify: `~/Dev/HomeEspSera/server/requirements.txt`

**Interfaces:**
- Consumes: `engine.play_alert(tracks: list[dict], preset: str = "voice")` e `file_track(path: Path) -> dict`, ambos de `core.py`.
- Produces: `POST /api/announce`, multipart com campo `file`. Responde `{"ok": true}` em sucesso e `{"error": "áudio vazio"}` com 400 em corpo vazio.

> **Exceção deliberada ao TDD:** este repo não tem nenhuma infraestrutura de teste (sem `pytest`, sem `tests/`). Montar uma para um endpoint de 14 linhas é desproporcional, e o `create_app` monta `StaticFiles` sobre `web/dist`, que nem sempre existe. A verificação aqui é manual, com comandos exatos. Todas as outras tasks são TDD normal.

- [ ] **Step 1: Adicionar `python-multipart` às dependências**

Em `server/requirements.txt`, acrescentar a linha (o FastAPI exige esse pacote para aceitar `UploadFile`; sem ele o endpoint sobe mas devolve 500 na primeira chamada):

```
python-multipart
```

- [ ] **Step 2: Instalar a dependência**

Run (no PC Windows, na pasta do projeto):
```powershell
python -m pip install -r server/requirements.txt
```
Expected: `python-multipart` instalado (ou "already satisfied").

- [ ] **Step 3: Ajustar os imports de `api.py`**

Trocar a linha de import do FastAPI e acrescentar `tempfile`:

```python
import asyncio
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
```

- [ ] **Step 4: Adicionar o endpoint**

Logo depois do `/api/alert` (`api.py:229`), ainda na seção "avisos":

```python
    @app.post("/api/announce")
    async def announce(file: UploadFile = File(...)):
        """Toca um áudio que já veio pronto, com prioridade de aviso.

        É por aqui que a Seraphine fala na casa com a voz dela: o
        `/api/say` gera a fala com o TTS do Windows, este recebe o áudio
        sintetizado fora. `async def` porque ler o upload é await; o
        play_alert continua indo para uma thread, como nos outros avisos.
        """
        data = await file.read()
        if not data:
            return JSONResponse({"error": "áudio vazio"}, status_code=400)
        suffix = Path(file.filename or "aviso.wav").suffix or ".wav"
        tmp = Path(tempfile.gettempdir()) / f"espmusic_announce{suffix}"
        tmp.write_bytes(data)
        track = file_track(tmp)
        track["title"] = "aviso"
        track["artist"] = "seraphine"
        threading.Thread(target=engine.play_alert, args=([track],),
                         daemon=True).start()
        return ok()
```

- [ ] **Step 5: Subir o servidor e verificar o contrato**

Run:
```powershell
python server/espmusic.py serve
```
Noutro terminal, um arquivo vazio deve dar 400:
```powershell
New-Item -ItemType File -Force vazio.wav | Out-Null
curl.exe -s -o NUL -w "%{http_code}" -X POST http://localhost:8080/api/announce -F "file=@vazio.wav"
```
Expected: `400`

- [ ] **Step 6: Verificar que um áudio real toca na caixa**

Gerar um wav de teste com o próprio TTS do Windows e mandá-lo de volta pelo endpoint novo:
```powershell
powershell -c "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('teste.wav'); $s.Speak('teste de aviso'); $s.Dispose()"
curl.exe -X POST http://localhost:8080/api/announce -F "file=@teste.wav"
```
Expected: `{"ok":true}` e a frase sai na caixa selecionada. Com música tocando, ela corta e volta do ponto exato depois.

- [ ] **Step 7: Commit (no repo do EspMusic)**

```bash
cd ~/Dev/HomeEspSera
git add server/api.py server/requirements.txt
git commit -m "feat(api): /api/announce — toca áudio externo como aviso

A Seraphine sintetiza a fala com a voz dela e manda o áudio pronto;
o /api/say continua servindo para o TTS local do Windows."
```

---

### Task 2: Comando Tauri `lan_request` com allowlist

O único ponto do sistema que abre conexão com a LAN. A allowlist é a trava contra virar SSRF na rede de casa, então é constante de compilação, não configuração.

**Files:**
- Create: `apps/seraphine/frontend/src-tauri/src/home.rs`
- Modify: `apps/seraphine/frontend/src-tauri/src/lib.rs` (declaração do módulo + os dois `invoke_handler`)
- Modify: `apps/seraphine/frontend/src-tauri/Cargo.toml`

**Interfaces:**
- Produces: comando Tauri `lan_request(args: LanRequestArgs) -> Result<LanResponse, String>`.
  - `LanRequestArgs { base: String, method: String, path: String, json: Option<Value>, audio_b64: Option<String>, audio_filename: Option<String> }`
  - `LanResponse { status: u16, body: String }`
  - `pub fn is_allowed(base: &str) -> bool`

- [ ] **Step 1: Adicionar a dependência `reqwest`**

Em `src-tauri/Cargo.toml`, na seção `[dependencies]`, depois de `tiny_http`:

```toml
# Relé HTTP para a casa — fala com aparelhos da LAN (EspMusic hoje;
# luzes/garagem/piscina depois). TLS fica desligado de propósito: o relé
# só fala http:// com hosts da allowlist, e sem TLS a árvore de
# dependências fica pequena.
reqwest = { version = "0.12", default-features = false, features = ["multipart", "json"] }
```

- [ ] **Step 2: Escrever os testes contra um `is_allowed` que ainda recusa tudo**

Create `src-tauri/src/home.rs` com o stub e os testes. A implementação real de `is_allowed` entra no Step 4 e o comando no Step 5:

```rust
//! Relé HTTP para a rede local da casa.
//!
//! O backend roda no VPS e não alcança a LAN. Ele manda um
//! `lan_request` pelo WebSocket de proxy de tools e este comando faz a
//! requisição de dentro de casa.
//!
//! A allowlist é a única coisa entre este relé e um SSRF na rede local,
//! por isso é constante de compilação e não configuração.

/// Pares host:porta que o relé pode alcançar. `espmusic.local` é o nome
/// mDNS que o servidor do EspMusic anuncia; o IP é a reserva para
/// quando o mDNS não resolve.
const ALLOWED: &[&str] = &["espmusic.local:8080", "192.168.1.50:8080"];

/// Verdadeiro quando `base` é uma URL http:// cujo host:porta está na
/// allowlist. https não é usado na LAN, e recusar qualquer outro esquema
/// já barra `file://` e amigos.
pub fn is_allowed(_base: &str) -> bool {
    false // stub — implementado no Step 4
}

#[cfg(test)]
mod tests {
    use super::is_allowed;

    #[test]
    fn allows_the_espmusic_mdns_host() {
        assert!(is_allowed("http://espmusic.local:8080"));
    }

    #[test]
    fn allows_the_fallback_ip() {
        assert!(is_allowed("http://192.168.1.50:8080"));
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
```

- [ ] **Step 3: Declarar o módulo e ver os testes falharem**

Em `src-tauri/src/lib.rs`, junto das outras declarações (`lib.rs:19-33`), em ordem alfabética entre `health` e `mac_tools`:

```rust
mod home;
```

Run: `cd apps/seraphine/frontend/src-tauri && cargo test home::`
Expected: FAIL — os 3 testes de `allows_*` falham (o stub recusa tudo); os 4 de `rejects_*` passam por acidente.

- [ ] **Step 4: Implementar `is_allowed` e ver os testes passarem**

Substituir o stub em `home.rs` por:

```rust
pub fn is_allowed(base: &str) -> bool {
    let rest = match base.strip_prefix("http://") {
        Some(r) => r,
        None => return false,
    };
    let hostport = rest.split('/').next().unwrap_or("");
    ALLOWED.contains(&hostport)
}
```

Run: `cd apps/seraphine/frontend/src-tauri && cargo test home::`
Expected: PASS (7 testes)

- [ ] **Step 5: Implementar o comando**

Acrescentar ao topo de `home.rs` (depois do doc-comment) e antes do `#[cfg(test)]`:

```rust
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);

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
```

- [ ] **Step 6: Registrar o comando nos dois `invoke_handler`**

`lib.rs` tem dois builders. No **mobile** (`lib.rs:53`, dentro de `run_mobile`) e no **desktop** (`lib.rs:132`, dentro de `run_desktop`), acrescentar em ambos:

```rust
            // Casa — relé HTTP para a LAN (EspMusic). Vale nos dois
            // alvos: o iPhone em casa está na mesma rede que o Mac.
            home::lan_request,
```

- [ ] **Step 7: Confirmar o IP de reserva e compilar**

Perguntar a Jonathan o IP fixo do PC Windows e substituir `192.168.1.50:8080` em `ALLOWED` (e no teste `allows_the_fallback_ip`).

Run: `cd apps/seraphine/frontend/src-tauri && cargo test home:: && cargo check`
Expected: 7 testes passam, `cargo check` sem erros.

- [ ] **Step 8: Commit**

```bash
git add apps/seraphine/frontend/src-tauri/src/home.rs \
        apps/seraphine/frontend/src-tauri/src/lib.rs \
        apps/seraphine/frontend/src-tauri/Cargo.toml \
        apps/seraphine/frontend/src-tauri/Cargo.lock
git commit -m "feat(home): comando lan_request com allowlist

Relé HTTP para a LAN da casa. Único ponto que abre conexão com a rede
local; a allowlist é constante de compilação, não configuração."
```

---

### Task 3: Handler `lan_request` no tool-proxy

Cola entre o WebSocket do backend e o comando Rust. Traduz status HTTP em `ok`/`error` para o backend distinguir "não alcancei a casa" de "a casa respondeu erro".

**Files:**
- Modify: `apps/seraphine/frontend/src/tool-proxy/index.ts:47` (mapa `handlers`)
- Create: `apps/seraphine/frontend/src/tool-proxy/__tests__/lanRequest.test.ts`

**Interfaces:**
- Consumes: comando Tauri `lan_request` da Task 2.
- Produces: entrada `lan_request` no mapa `handlers`, que passa a ser exportado. Resposta: `ok = status 2xx`, `output = body`, `error = "HTTP <status>"` quando ≥ 400, `metadata.status = <status>`.

- [ ] **Step 1: Escrever o teste falhando**

Create `src/tool-proxy/__tests__/lanRequest.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { handlers } from '../index';

describe('lan_request handler', () => {
  beforeEach(() => invoke.mockReset());

  it('marks a 2xx as ok and passes the body through', async () => {
    invoke.mockResolvedValue({ status: 200, body: '{"ok":true}' });
    const res = await handlers.lan_request({
      base: 'http://espmusic.local:8080',
      method: 'POST',
      path: '/api/next',
    });
    expect(res.ok).toBe(true);
    expect(res.output).toBe('{"ok":true}');
    expect(res.metadata?.status).toBe(200);
  });

  it('forwards every field to the Tauri command under `args`', async () => {
    invoke.mockResolvedValue({ status: 200, body: '{}' });
    await handlers.lan_request({
      base: 'http://espmusic.local:8080',
      method: 'POST',
      path: '/api/announce',
      audio_b64: 'AAAA',
      audio_filename: 'aviso.ogg',
    });
    expect(invoke).toHaveBeenCalledWith('lan_request', {
      args: {
        base: 'http://espmusic.local:8080',
        method: 'POST',
        path: '/api/announce',
        json: null,
        audio_b64: 'AAAA',
        audio_filename: 'aviso.ogg',
      },
    });
  });

  it('marks a 4xx as not ok but still returns the body', async () => {
    invoke.mockResolvedValue({ status: 404, body: '{"error":"nada encontrado"}' });
    const res = await handlers.lan_request({
      base: 'http://espmusic.local:8080',
      method: 'POST',
      path: '/api/play',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('404');
    expect(res.output).toBe('{"error":"nada encontrado"}');
    expect(res.metadata?.status).toBe(404);
  });

  it('turns a rejected invoke into an error response', async () => {
    invoke.mockRejectedValue(new Error('host não permitido'));
    const res = await handlers.lan_request({
      base: 'http://evil.local:80',
      method: 'GET',
      path: '/',
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('host não permitido');
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `cd apps/seraphine/frontend && pnpm test lanRequest`
Expected: FAIL — `handlers` não é exportado / `handlers.lan_request` é `undefined`.

- [ ] **Step 3: Exportar `handlers` e adicionar a entrada**

Em `src/tool-proxy/index.ts:47`, trocar `const handlers: Record<string, Handler> = {` por:

```ts
export const handlers: Record<string, Handler> = {
```

E acrescentar esta entrada ao mapa (junto das outras, antes do fechamento em `index.ts:330`):

```ts
  // Casa — relé HTTP para a LAN. O backend (no VPS) não alcança
  // espmusic.local; ele manda a requisição pronta e o Rust executa
  // daqui de dentro, contra a allowlist de `home.rs`.
  lan_request: async (args) => {
    try {
      const res = await tauriInvoke<{ status: number; body: string }>('lan_request', {
        args: {
          base: String(args.base ?? ''),
          method: String(args.method ?? 'GET'),
          path: String(args.path ?? ''),
          json: args.json ?? null,
          audio_b64: args.audio_b64 ?? null,
          audio_filename: args.audio_filename ?? null,
        },
      });
      const ok = res.status >= 200 && res.status < 300;
      return {
        request_id: '',
        ok,
        output: res.body,
        error: ok ? null : `HTTP ${res.status}`,
        metadata: { status: res.status },
      };
    } catch (e) {
      return wrapErr(e);
    }
  },
```

- [ ] **Step 4: Rodar os testes**

Run: `cd apps/seraphine/frontend && pnpm test lanRequest`
Expected: PASS (4 testes)

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/tool-proxy/index.ts \
        apps/seraphine/frontend/src/tool-proxy/__tests__/lanRequest.test.ts
git commit -m "feat(home): handler lan_request no tool-proxy"
```

---

### Task 4: `LanTransport` — o transporte do backend para a casa

Empacota a chamada, manda pelo broker de proxy e traduz o resultado em exceções de domínio. É o arquivo que a v2 (bridge outbound, funcionando fora de casa) substitui inteiro.

**Files:**
- Create: `apps/seraphine/backend/seraphine/home/__init__.py`
- Create: `apps/seraphine/backend/seraphine/home/transport.py`
- Create: `apps/seraphine/backend/tests/home/__init__.py`
- Create: `apps/seraphine/backend/tests/home/test_transport.py`

**Interfaces:**
- Consumes: `seraphine.conversation.engine._proxy_tool_via_client(app_state, tool_name, tool_args) -> ToolResult` (`conversation/engine.py:378`) e o handler `lan_request` da Task 3.
- Produces:
  - `DEFAULT_BASE: str = "http://espmusic.local:8080"`
  - `class HomeUnreachable(Exception)`
  - `class HomeHTTPError(Exception)` com atributos `.status: int` e `.body: str`
  - `class LanTransport(app_state, base=DEFAULT_BASE)` com
    `async def request(method: str, path: str, *, json_body: dict | None = None, audio: bytes | None = None, audio_filename: str = "aviso.wav") -> Any`

- [ ] **Step 1: Escrever o teste falhando**

Create `tests/home/__init__.py` (vazio) e `tests/home/test_transport.py`:

```python
"""Testes do transporte da casa.

O transporte nunca abre conexão: ele delega ao cliente Tauri pelo broker
de proxy. Aqui o broker é substituído por uma função falsa que grava os
args e devolve o ToolResult combinado.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest

from seraphine.home.transport import (
    DEFAULT_BASE,
    HomeHTTPError,
    HomeUnreachable,
    LanTransport,
)
from seraphine.tools.base import ToolResult


class FakeProxy:
    """Substitui `_proxy_tool_via_client`, gravando a última chamada."""

    def __init__(self, result: ToolResult) -> None:
        self.result = result
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __call__(
        self, app_state: Any, tool_name: str, tool_args: dict[str, Any]
    ) -> ToolResult:
        self.calls.append((tool_name, tool_args))
        return self.result


@pytest.fixture()
def patch_proxy(monkeypatch):
    def _install(result: ToolResult) -> FakeProxy:
        fake = FakeProxy(result)
        monkeypatch.setattr(
            "seraphine.conversation.engine._proxy_tool_via_client", fake
        )
        return fake

    return _install


async def test_get_returns_the_decoded_json_body(patch_proxy):
    patch_proxy(
        ToolResult(ok=True, output='{"volume": 0.5}', metadata={"status": 200})
    )
    t = LanTransport(app_state=object())
    assert await t.request("GET", "/api/status") == {"volume": 0.5}


async def test_it_calls_the_lan_request_capability_not_a_tool(patch_proxy):
    fake = patch_proxy(ToolResult(ok=True, output="{}", metadata={"status": 200}))
    t = LanTransport(app_state=object())
    await t.request("POST", "/api/next", json_body={})
    tool_name, args = fake.calls[0]
    assert tool_name == "lan_request"
    assert args["base"] == DEFAULT_BASE
    assert args["method"] == "POST"
    assert args["path"] == "/api/next"


async def test_audio_travels_as_base64_with_a_filename(patch_proxy):
    fake = patch_proxy(ToolResult(ok=True, output="{}", metadata={"status": 200}))
    t = LanTransport(app_state=object())
    await t.request("POST", "/api/announce", audio=b"RIFFdata", audio_filename="a.ogg")
    _, args = fake.calls[0]
    assert base64.b64decode(args["audio_b64"]) == b"RIFFdata"
    assert args["audio_filename"] == "a.ogg"
    assert "json" not in args


async def test_a_device_error_status_raises_home_http_error(patch_proxy):
    patch_proxy(
        ToolResult(
            ok=False,
            output='{"error": "nada encontrado"}',
            error="HTTP 404",
            metadata={"status": 404},
        )
    )
    t = LanTransport(app_state=object())
    with pytest.raises(HomeHTTPError) as exc:
        await t.request("POST", "/api/play", json_body={"query": "x"})
    assert exc.value.status == 404
    assert "nada encontrado" in exc.value.body


async def test_no_client_connected_raises_home_unreachable(patch_proxy):
    patch_proxy(
        ToolResult(
            ok=False,
            error="tool 'lan_request' needs a Mac client but no Tauri WebSocket is connected",
        )
    )
    t = LanTransport(app_state=object())
    with pytest.raises(HomeUnreachable):
        await t.request("GET", "/api/status")


async def test_an_empty_body_decodes_to_an_empty_dict(patch_proxy):
    patch_proxy(ToolResult(ok=True, output="", metadata={"status": 204}))
    t = LanTransport(app_state=object())
    assert await t.request("POST", "/api/mute", json_body={}) == {}


async def test_a_non_json_body_is_returned_raw(patch_proxy):
    patch_proxy(ToolResult(ok=True, output="pong", metadata={"status": 200}))
    t = LanTransport(app_state=object())
    assert await t.request("GET", "/api/ping") == {"raw": "pong"}
```

- [ ] **Step 2: Rodar os testes para vê-los falhar**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/test_transport.py -v`
Expected: FAIL com `ModuleNotFoundError: No module named 'seraphine.home'`

- [ ] **Step 3: Implementar o transporte**

Create `seraphine/home/__init__.py` (vazio) e `seraphine/home/transport.py`:

```python
"""Transporte para os aparelhos da casa, que vivem na rede local.

O backend roda no VPS e não alcança a LAN. Toda requisição é empacotada
e enviada ao cliente Tauri pelo WebSocket de proxy de tools que já
existe; quem abre a conexão é o comando `lan_request`, de dentro de casa.

`lan_request` **não** é registrado no ToolRegistry de propósito: o LLM
nunca pode enxergar um escape hatch de HTTP genérico. É uma capacidade
do cliente, invocada só daqui.

Trocar este arquivo por um bridge outbound (v2, que funciona fora de
casa) é a migração inteira — adaptadores e tools não mudam.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

logger = logging.getLogger("seraphine.home.transport")

DEFAULT_BASE = "http://espmusic.local:8080"

# Precisa bater com ALLOWED em
# apps/seraphine/frontend/src-tauri/src/home.rs — o relé recusa
# qualquer outra base.


class HomeUnreachable(Exception):
    """Não deu para falar com a casa: sem cliente conectado, sem rede,
    ou o aparelho não respondeu."""


class HomeHTTPError(Exception):
    """A casa respondeu, mas com status de erro."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body


class LanTransport:
    def __init__(self, app_state: Any, base: str = DEFAULT_BASE) -> None:
        self._app_state = app_state
        self._base = base.rstrip("/")

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        audio: bytes | None = None,
        audio_filename: str = "aviso.wav",
    ) -> Any:
        """Executa a chamada dentro de casa e devolve o JSON decodificado.

        Levanta HomeHTTPError quando o aparelho respondeu com erro e
        HomeUnreachable quando a chamada nem chegou lá.
        """
        # Import local: o engine importa tools, que importam este módulo.
        # Importar no topo fecharia o ciclo. Também é o que permite o
        # monkeypatch nos testes.
        from seraphine.conversation.engine import _proxy_tool_via_client

        args: dict[str, Any] = {
            "base": self._base,
            "method": method.upper(),
            "path": path,
        }
        if audio is not None:
            args["audio_b64"] = base64.b64encode(audio).decode("ascii")
            args["audio_filename"] = audio_filename
        elif json_body is not None:
            args["json"] = json_body

        result = await _proxy_tool_via_client(self._app_state, "lan_request", args)

        meta = result.metadata or {}
        status = int(meta.get("status") or 0)
        # Ordem importa: um 404 também chega com ok=False, e ele é um
        # erro do aparelho, não uma falha de alcance.
        if status >= 400:
            raise HomeHTTPError(status, result.output or "")
        if not result.ok:
            logger.warning("lan_request falhou: %s", result.error)
            raise HomeUnreachable(result.error or "relay failed")

        body = result.output or ""
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"raw": body}
```

- [ ] **Step 4: Rodar os testes**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/test_transport.py -v`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/home/ apps/seraphine/backend/tests/home/
git commit -m "feat(home): LanTransport — chamadas à LAN via proxy do cliente"
```

---

### Task 5: `EspMusicAdapter` — o domínio do som da casa

Único lugar que conhece as rotas do EspMusic, os nomes das caixas e a unidade de volume.

**Files:**
- Create: `apps/seraphine/backend/seraphine/home/espmusic.py`
- Create: `apps/seraphine/backend/tests/home/test_espmusic_adapter.py`

**Interfaces:**
- Consumes: `LanTransport.request` e `HomeHTTPError` da Task 4.
- Produces:
  - `slugify_room(name: str) -> str`
  - `pct_to_db(pct: float) -> float`
  - `class UnknownRoom(Exception)`
  - `class EspMusicAdapter(transport)` com
    `async def play(query, *, room=None, mode="now") -> str`,
    `async def control(action, *, value=None, room=None) -> str`,
    `async def announce(audio: bytes, filename: str = "aviso.wav") -> str`,
    `async def status() -> str`,
    `async def select_room(room: str) -> str`

- [ ] **Step 1: Escrever o teste falhando**

Create `tests/home/test_espmusic_adapter.py`:

```python
"""Testes do adaptador do EspMusic.

O transporte é falso: cada teste declara o que o /api/status devolve e
depois confere a rota e o corpo que o adaptador montou.
"""

from __future__ import annotations

from typing import Any

import pytest

from seraphine.home.espmusic import (
    EspMusicAdapter,
    UnknownRoom,
    pct_to_db,
    slugify_room,
)
from seraphine.home.transport import HomeHTTPError

SNAPSHOT = {
    "devices": ["espmusic-banheiro", "espmusic-sala"],
    "device": "espmusic-sala",
    "device_label": "sala",
    "playing": {"title": "Flor de Lis", "artist": "Djavan"},
    "paused": False,
    "queue_len": 12,
    "radio": True,
    "volume": 0.5,
    "muted": False,
}


class FakeTransport:
    """Grava (método, path, corpo) e devolve respostas combinadas."""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.responses = responses or {}
        self.raise_on: dict[str, Exception] = {}

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        audio: bytes | None = None,
        audio_filename: str = "aviso.wav",
    ) -> Any:
        self.calls.append((method, path, audio if audio is not None else json_body))
        if path in self.raise_on:
            raise self.raise_on[path]
        return self.responses.get(path, {"ok": True})


@pytest.fixture()
def transport() -> FakeTransport:
    return FakeTransport({"/api/status": SNAPSHOT})


@pytest.fixture()
def adapter(transport: FakeTransport) -> EspMusicAdapter:
    return EspMusicAdapter(transport)


# ------------------------------------------------------------ helpers


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("sala", "sala"),
        ("Sala", "sala"),
        ("Sala de Estar", "sala-de-estar"),
        ("Cozinha ", "cozinha"),
        ("Quarto do João", "quarto-do-joao"),
        ("BANHEIRO", "banheiro"),
    ],
)
def test_slugify_room(raw: str, expected: str) -> None:
    assert slugify_room(raw) == expected


@pytest.mark.parametrize(
    "pct,expected",
    [
        (100.0, 0.0),
        (50.0, -6.02),
        (10.0, -20.0),
        (150.0, 0.0),  # acima de 100 satura em 0 dB
    ],
)
def test_pct_to_db(pct: float, expected: float) -> None:
    assert pct_to_db(pct) == pytest.approx(expected, abs=0.01)


def test_pct_to_db_clamps_zero_to_practical_silence() -> None:
    # log10(0) é -inf; o adaptador precisa devolver um número finito.
    assert pct_to_db(0.0) == -60.0


# ------------------------------------------------------------ cômodos


async def test_play_without_a_room_does_not_switch_speakers(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.play("djavan")
    paths = [p for _, p, _ in transport.calls]
    assert "/api/device" not in paths
    assert ("POST", "/api/play", {"query": "djavan", "mode": "now"}) in transport.calls


async def test_play_with_a_room_selects_the_speaker_first(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.play("djavan", room="Sala")
    assert transport.calls[0] == ("GET", "/api/status", None)
    assert transport.calls[1] == ("POST", "/api/device", {"name": "espmusic-sala"})
    assert transport.calls[2] == ("POST", "/api/play", {"query": "djavan", "mode": "now"})


async def test_an_unknown_room_lists_the_ones_that_exist(
    adapter: EspMusicAdapter,
) -> None:
    with pytest.raises(UnknownRoom) as exc:
        await adapter.play("djavan", room="garagem")
    assert "banheiro" in str(exc.value)
    assert "sala" in str(exc.value)


async def test_queue_mode_is_forwarded(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.play("djavan", mode="queue")
    assert ("POST", "/api/play", {"query": "djavan", "mode": "queue"}) in transport.calls


async def test_a_404_from_play_becomes_a_readable_message(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    transport.raise_on["/api/play"] = HomeHTTPError(404, '{"error": "nada encontrado"}')
    with pytest.raises(HomeHTTPError):
        await adapter.play("uma música que não existe")


# ------------------------------------------------------------ controle


@pytest.mark.parametrize(
    "action,path,body",
    [
        ("pause", "/api/pause", {"on": True}),
        ("resume", "/api/pause", {"on": False}),
        ("next", "/api/next", {}),
        ("stop", "/api/stop", {}),
        ("mute", "/api/mute", {}),
        ("volume_up", "/api/volume", {"delta_db": 2.0}),
        ("volume_down", "/api/volume", {"delta_db": -2.0}),
        ("radio_on", "/api/radio", {"on": True}),
        ("radio_off", "/api/radio", {"on": False}),
    ],
)
async def test_control_maps_each_action(
    adapter: EspMusicAdapter, transport: FakeTransport,
    action: str, path: str, body: dict[str, Any],
) -> None:
    await adapter.control(action)
    assert ("POST", path, body) in transport.calls


async def test_volume_set_converts_percent_to_db(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.control("volume_set", value=50)
    assert ("POST", "/api/volume", {"db": -6.02}) in transport.calls


async def test_volume_set_without_a_value_is_rejected(
    adapter: EspMusicAdapter,
) -> None:
    with pytest.raises(ValueError):
        await adapter.control("volume_set")


async def test_volume_up_ignores_a_stray_value(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    # O passo é fixo: 'value' só vale em volume_set.
    await adapter.control("volume_up", value=40)
    assert ("POST", "/api/volume", {"delta_db": 2.0}) in transport.calls


async def test_an_unknown_action_is_rejected(adapter: EspMusicAdapter) -> None:
    with pytest.raises(ValueError):
        await adapter.control("explodir")


# ------------------------------------------------------------ aviso


async def test_announce_posts_the_audio(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.announce(b"OggS...", filename="aviso.ogg")
    assert ("POST", "/api/announce", b"OggS...") in transport.calls


# ------------------------------------------------------------ estado


async def test_status_summarises_what_matters(adapter: EspMusicAdapter) -> None:
    text = await adapter.status()
    assert "sala" in text
    assert "Flor de Lis" in text
    assert "50%" in text
    assert "12" in text
    assert "rádio ligado" in text


async def test_status_says_when_nothing_is_playing(transport: FakeTransport) -> None:
    transport.responses["/api/status"] = {**SNAPSHOT, "playing": None}
    text = await EspMusicAdapter(transport).status()
    assert "nada tocando" in text
```

- [ ] **Step 2: Rodar os testes para vê-los falhar**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/test_espmusic_adapter.py -v`
Expected: FAIL com `ModuleNotFoundError: No module named 'seraphine.home.espmusic'`

- [ ] **Step 3: Implementar o adaptador**

Create `seraphine/home/espmusic.py`:

```python
"""Adaptador do EspMusic — o único lugar que conhece a API dele.

Duas traduções vivem aqui, e só aqui:

* cômodo → caixa. O usuário fala "sala de estar"; o EspMusic identifica
  as placas como `espmusic-sala-de-estar`.
* volume. A API trabalha em dB, o painel (e o usuário) em porcentagem.

Quando entrarem luzes, garagem e piscina, cada uma vira um módulo irmão
deste, compartilhando o mesmo transporte.
"""

from __future__ import annotations

import math
import unicodedata
from typing import Any

# Passo de um "aumenta o volume". Em dB de propósito: passo linear
# engana no volume baixo (5% → 10% dobra a potência).
VOLUME_STEP_DB = 2.0

# 0% seria log10(0) = -inf. -60 dB é silêncio na prática e continua um
# número que a API aceita. Não usamos /api/mute aqui porque ele é um
# alternador: chamá-lo com o som já mudo desmutaria.
SILENCE_DB = -60.0

DEVICE_PREFIX = "espmusic-"


class UnknownRoom(Exception):
    """O cômodo pedido não corresponde a nenhuma caixa conhecida."""


def slugify_room(name: str) -> str:
    """"Sala de Estar" -> "sala-de-estar" (sem acento, minúsculo)."""
    plain = unicodedata.normalize("NFKD", name)
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return "-".join(plain.strip().lower().split())


def pct_to_db(pct: float) -> float:
    """Porcentagem (como o painel mostra) para dB (como a API quer).

    Espelha `dbToPct` em web/src/api.js: pct = 10^(db/20) * 100.
    """
    if pct <= 0:
        return SILENCE_DB
    return round(20.0 * math.log10(min(float(pct), 100.0) / 100.0), 2)


def _label(device: str) -> str:
    return device.replace(DEVICE_PREFIX, "")


class EspMusicAdapter:
    def __init__(self, transport: Any) -> None:
        self._t = transport

    # ------------------------------------------------------------ caixas

    async def _snapshot(self) -> dict[str, Any]:
        return await self._t.request("GET", "/api/status")

    async def select_room(self, room: str) -> str:
        """Aponta o EspMusic para a caixa de `room`; devolve o device."""
        wanted = f"{DEVICE_PREFIX}{slugify_room(room)}"
        devices = list((await self._snapshot()).get("devices") or [])
        if wanted not in devices:
            known = ", ".join(_label(d) for d in devices) or "nenhuma"
            raise UnknownRoom(
                f"não conheço o cômodo '{room}'. Caixas disponíveis: {known}"
            )
        await self._t.request("POST", "/api/device", json_body={"name": wanted})
        return wanted

    async def _maybe_select(self, room: str | None) -> None:
        if room:
            await self.select_room(room)

    # ------------------------------------------------------------ tocar

    async def play(
        self, query: str, *, room: str | None = None, mode: str = "now"
    ) -> str:
        await self._maybe_select(room)
        wanted_mode = "queue" if mode == "queue" else "now"
        data = await self._t.request(
            "POST", "/api/play", json_body={"query": query, "mode": wanted_mode}
        )
        added = [str(t) for t in (data.get("added") or [])]
        where = f" na {room}" if room else ""
        if not added:
            return f"pedido enviado{where}"
        head = added[0]
        if len(added) > 1:
            head += f" (+{len(added) - 1} faixas)"
        verb = "na fila" if wanted_mode == "queue" else "tocando"
        return f"{verb}{where}: {head}"

    # ---------------------------------------------------------- controle

    async def control(
        self, action: str, *, value: float | None = None, room: str | None = None
    ) -> str:
        await self._maybe_select(room)

        if action == "pause":
            await self._t.request("POST", "/api/pause", json_body={"on": True})
            return "pausado"
        if action == "resume":
            await self._t.request("POST", "/api/pause", json_body={"on": False})
            return "voltou a tocar"
        if action == "next":
            await self._t.request("POST", "/api/next", json_body={})
            return "pulei a faixa"
        if action == "stop":
            await self._t.request("POST", "/api/stop", json_body={})
            return "parei e limpei a fila"
        if action == "mute":
            await self._t.request("POST", "/api/mute", json_body={})
            return "mudo alternado"
        if action == "volume_up":
            await self._t.request(
                "POST", "/api/volume", json_body={"delta_db": VOLUME_STEP_DB}
            )
            return "aumentei o volume"
        if action == "volume_down":
            await self._t.request(
                "POST", "/api/volume", json_body={"delta_db": -VOLUME_STEP_DB}
            )
            return "abaixei o volume"
        if action == "volume_set":
            if value is None:
                raise ValueError("volume_set precisa de 'value' (0 a 100)")
            await self._t.request(
                "POST", "/api/volume", json_body={"db": pct_to_db(float(value))}
            )
            return f"volume em {round(float(value))}%"
        if action in ("radio_on", "radio_off"):
            on = action == "radio_on"
            await self._t.request("POST", "/api/radio", json_body={"on": on})
            return "rádio ligado" if on else "rádio desligado"

        raise ValueError(f"ação desconhecida: {action}")

    # ------------------------------------------------------------- aviso

    async def announce(self, audio: bytes, filename: str = "aviso.wav") -> str:
        await self._t.request(
            "POST", "/api/announce", audio=audio, audio_filename=filename
        )
        return "aviso tocado na casa"

    # ------------------------------------------------------------ estado

    async def status(self) -> str:
        s = await self._snapshot()
        parts: list[str] = []

        parts.append(f"cômodo: {s.get('device_label') or 'nenhum selecionado'}")

        cur = s.get("playing") or None
        if cur:
            state = "pausado" if s.get("paused") else "tocando"
            artist = cur.get("artist") or "desconhecido"
            parts.append(f"{state}: {cur.get('title')} — {artist}")
        else:
            parts.append("nada tocando")

        volume_pct = round(float(s.get("volume") or 0.0) * 100)
        parts.append(f"volume: {volume_pct}%" + (" (mudo)" if s.get("muted") else ""))
        parts.append(f"fila: {int(s.get('queue_len') or 0)} faixa(s)")
        parts.append("rádio ligado" if s.get("radio") else "rádio desligado")

        rooms = ", ".join(_label(str(d)) for d in (s.get("devices") or []))
        parts.append(f"caixas: {rooms or 'nenhuma'}")

        return " · ".join(parts)
```

- [ ] **Step 4: Rodar os testes**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/test_espmusic_adapter.py -v`
Expected: PASS (todos — 6 de slug, 4 de dB, 5 de cômodo/tocar, 12 de controle, 1 de aviso, 2 de estado)

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/home/espmusic.py \
        apps/seraphine/backend/tests/home/test_espmusic_adapter.py
git commit -m "feat(home): EspMusicAdapter — cômodos, volume em %, estado"
```

---

### Task 6: As quatro tools e o `HomeService`

O que o LLM enxerga. Aqui também mora a síntese da voz e a tradução de exceção em frase.

**Files:**
- Create: `apps/seraphine/backend/seraphine/home/service.py`
- Create: `apps/seraphine/backend/seraphine/tools/home.py`
- Create: `apps/seraphine/backend/tests/home/test_home_tools.py`

**Interfaces:**
- Consumes: `EspMusicAdapter`, `UnknownRoom` (Task 5); `LanTransport`, `HomeUnreachable`, `HomeHTTPError`, `DEFAULT_BASE` (Task 4); `TTSAdapter.synthesize_ogg(text) -> bytes` e `TTSAdapter.synthesize_stream(text) -> AsyncIterator[bytes]` (`tts/base.py`).
- Produces:
  - `class HomeService(app_state, *, base=DEFAULT_BASE, tts=None)` com atributos `.music: EspMusicAdapter` e `.tts`
  - `HomePlayTool`, `HomeControlTool`, `HomeAnnounceTool`, `HomeStatusTool` — todas `Tool(service)`, `requires_confirmation = False`, `category = "network"`

- [ ] **Step 1: Escrever o teste falhando**

Create `tests/home/test_home_tools.py`:

```python
"""Testes das tools da casa.

O adaptador é falso: aqui interessa o contrato com o LLM (schema,
descrição, args) e a tradução de exceção em frase que a Seraphine
consegue falar.
"""

from __future__ import annotations

import io
import wave
from typing import Any, AsyncIterator

import pytest

from seraphine.home.espmusic import UnknownRoom
from seraphine.home.transport import HomeHTTPError, HomeUnreachable
from seraphine.tools.home import (
    HomeAnnounceTool,
    HomeControlTool,
    HomePlayTool,
    HomeStatusTool,
)


class FakeAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.raises: Exception | None = None

    async def _record(self, name: str, **kw: Any) -> str:
        self.calls.append((name, kw))
        if self.raises is not None:
            raise self.raises
        return f"{name} ok"

    async def play(self, query: str, *, room=None, mode="now") -> str:
        return await self._record("play", query=query, room=room, mode=mode)

    async def control(self, action: str, *, value=None, room=None) -> str:
        return await self._record("control", action=action, value=value, room=room)

    async def announce(self, audio: bytes, filename: str = "aviso.wav") -> str:
        return await self._record("announce", audio=audio, filename=filename)

    async def status(self) -> str:
        return await self._record("status")


class FakeOggTTS:
    async def synthesize_ogg(self, text: str, *, voice_id=None) -> bytes:
        return b"OggS-" + text.encode()


class FakeStreamTTS:
    """Sem ogg — só o stream PCM, como os adaptadores locais."""

    async def synthesize_ogg(self, text: str, *, voice_id=None) -> bytes:
        raise NotImplementedError

    async def synthesize_stream(self, text, *, voice_id=None) -> AsyncIterator[bytes]:
        yield b"\x01\x02" * 8
        yield b"\x03\x04" * 8


class FakeService:
    def __init__(self, tts: Any = None) -> None:
        self.music = FakeAdapter()
        self.tts = tts


# ------------------------------------------------------------- contrato


def test_every_tool_declares_a_valid_schema() -> None:
    svc = FakeService()
    for tool in (
        HomePlayTool(svc),
        HomeControlTool(svc),
        HomeAnnounceTool(svc),
        HomeStatusTool(svc),
    ):
        assert tool.name.startswith("home_")
        assert tool.json_schema["type"] == "object"
        assert tool.requires_confirmation is False


def test_descriptions_send_the_llm_to_play_music_for_the_mac() -> None:
    # Sem isso o LLM confunde com as tools de navegador de tools/browser.py.
    svc = FakeService()
    for tool in (HomePlayTool(svc), HomeControlTool(svc)):
        assert "play_music" in tool.description


def test_status_takes_no_arguments() -> None:
    assert HomeStatusTool(FakeService()).json_schema.get("properties") == {}


# ----------------------------------------------------------------- play


async def test_play_forwards_query_room_and_mode() -> None:
    svc = FakeService()
    result = await HomePlayTool(svc).execute(
        {"query": "djavan", "room": "sala", "mode": "queue"}
    )
    assert result.ok
    assert svc.music.calls == [
        ("play", {"query": "djavan", "room": "sala", "mode": "queue"})
    ]


async def test_play_requires_a_query() -> None:
    result = await HomePlayTool(FakeService()).execute({})
    assert not result.ok
    assert "query" in (result.error or "")


# -------------------------------------------------------------- control


async def test_control_forwards_action_and_value() -> None:
    svc = FakeService()
    result = await HomeControlTool(svc).execute({"action": "volume_set", "value": 40})
    assert result.ok
    assert svc.music.calls == [
        ("control", {"action": "volume_set", "value": 40, "room": None})
    ]


async def test_control_rejects_an_action_outside_the_enum() -> None:
    result = await HomeControlTool(FakeService()).execute({"action": "explodir"})
    assert not result.ok


# ------------------------------------------------------------- announce


async def test_announce_uses_ogg_when_the_backend_supports_it() -> None:
    svc = FakeService(tts=FakeOggTTS())
    result = await HomeAnnounceTool(svc).execute({"text": "o jantar chegou"})
    assert result.ok
    name, kw = svc.music.calls[0]
    assert name == "announce"
    assert kw["audio"].startswith(b"OggS-")
    assert kw["filename"].endswith(".ogg")


async def test_announce_falls_back_to_a_wav_built_from_the_pcm_stream() -> None:
    svc = FakeService(tts=FakeStreamTTS())
    result = await HomeAnnounceTool(svc).execute({"text": "oi"})
    assert result.ok
    _, kw = svc.music.calls[0]
    assert kw["filename"].endswith(".wav")
    # Precisa ser um WAV válido, mono, 16 bits, 24 kHz.
    with wave.open(io.BytesIO(kw["audio"]), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getframerate() == 24_000
        assert w.getnframes() > 0


async def test_announce_without_tts_fails_clearly() -> None:
    result = await HomeAnnounceTool(FakeService(tts=None)).execute({"text": "oi"})
    assert not result.ok
    assert "voz" in (result.error or "").lower()


async def test_announce_requires_text() -> None:
    result = await HomeAnnounceTool(FakeService(tts=FakeOggTTS())).execute({})
    assert not result.ok


# ---------------------------------------------------------------- erros


async def test_no_client_connected_becomes_a_speakable_sentence() -> None:
    svc = FakeService()
    svc.music.raises = HomeUnreachable("no Tauri WebSocket is connected")
    result = await HomePlayTool(svc).execute({"query": "x"})
    assert not result.ok
    assert "app" in (result.error or "").lower()


async def test_a_404_from_play_says_the_song_was_not_found() -> None:
    svc = FakeService()
    svc.music.raises = HomeHTTPError(404, '{"error": "nada encontrado"}')
    result = await HomePlayTool(svc).execute({"query": "x"})
    assert not result.ok
    assert "não achei" in (result.error or "").lower()


async def test_an_unknown_room_keeps_the_list_of_rooms_in_the_error() -> None:
    svc = FakeService()
    svc.music.raises = UnknownRoom(
        "não conheço o cômodo 'garagem'. Caixas disponíveis: banheiro, sala"
    )
    result = await HomePlayTool(svc).execute({"query": "x", "room": "garagem"})
    assert not result.ok
    assert "banheiro" in (result.error or "")


async def test_a_500_from_the_device_is_reported_as_a_device_error() -> None:
    svc = FakeService()
    svc.music.raises = HomeHTTPError(500, "boom")
    result = await HomeStatusTool(svc).execute({})
    assert not result.ok
    assert "casa" in (result.error or "").lower()
```

- [ ] **Step 2: Rodar os testes para vê-los falhar**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/test_home_tools.py -v`
Expected: FAIL com `ModuleNotFoundError: No module named 'seraphine.tools.home'`

- [ ] **Step 3: Implementar o `HomeService`**

Create `seraphine/home/service.py`:

```python
"""Ponto de entrada para os aparelhos da casa.

Hoje só o som (EspMusic). Luzes, garagem e piscina viram cada uma outro
atributo aqui, compartilhando o mesmo transporte — sem tocar em Rust nem
em TypeScript.
"""

from __future__ import annotations

from typing import Any

from seraphine.home.espmusic import EspMusicAdapter
from seraphine.home.transport import DEFAULT_BASE, LanTransport


class HomeService:
    def __init__(
        self, app_state: Any, *, base: str = DEFAULT_BASE, tts: Any = None
    ) -> None:
        self._transport = LanTransport(app_state, base=base)
        self.music = EspMusicAdapter(self._transport)
        # Usado pelo aviso falado; None desabilita `home_announce`.
        self.tts = tts
```

- [ ] **Step 4: Implementar as tools**

Create `seraphine/tools/home.py`:

```python
"""Tools da casa — som do EspMusic.

O que o LLM enxerga. As descrições precisam ser explícitas sobre quando
NÃO usar: a Seraphine já tem `play_music` para tocar no navegador do
Mac, e sem essa instrução ela escolhe errado.

`lan_request` (o relé HTTP do cliente) não aparece aqui de propósito —
uma tool de HTTP genérico na LAN seria um escape hatch para o modelo.
"""

from __future__ import annotations

import io
import logging
import wave
from typing import Any

from seraphine.home.espmusic import UnknownRoom
from seraphine.home.transport import HomeHTTPError, HomeUnreachable
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger("seraphine.tools.home")

# O `synthesize_stream` de todos os adaptadores devolve PCM s16le mono
# a 24 kHz (ver tts/base.py).
TTS_SAMPLE_RATE = 24_000

_ONLY_WHEN_AT_HOME = (
    "Use APENAS quando o usuário citar um cômodo ou a casa ('na sala', "
    "'no banheiro', 'nas caixas', 'na casa'). Para tocar no próprio Mac "
    "do usuário, use `play_music`, que é o padrão."
)

ACTIONS = [
    "pause",
    "resume",
    "next",
    "stop",
    "mute",
    "volume_up",
    "volume_down",
    "volume_set",
    "radio_on",
    "radio_off",
]


def _pcm_to_wav(pcm: bytes, *, rate: int = TTS_SAMPLE_RATE) -> bytes:
    """Embrulha PCM s16le mono num WAV, que o ffmpeg do EspMusic decodifica."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _failure(exc: Exception) -> ToolResult:
    """Traduz a falha em algo que a Seraphine consegue falar em voz alta."""
    if isinstance(exc, HomeUnreachable):
        return ToolResult(
            ok=False,
            error=(
                "não alcanço a casa — o app da Seraphine precisa estar "
                "aberto no Mac e na mesma rede do EspMusic"
            ),
        )
    if isinstance(exc, UnknownRoom):
        return ToolResult(ok=False, error=str(exc))
    if isinstance(exc, HomeHTTPError):
        if exc.status == 404:
            return ToolResult(ok=False, error="não achei essa música")
        return ToolResult(
            ok=False,
            error=f"o servidor da casa respondeu com erro (HTTP {exc.status})",
        )
    if isinstance(exc, ValueError):
        return ToolResult(ok=False, error=str(exc))
    logger.exception("home tool falhou")
    return ToolResult(ok=False, error=f"falha ao falar com a casa: {exc}")


class _HomeTool(Tool):
    """Base das tools da casa: injeta o serviço e centraliza os erros."""

    requires_confirmation = False
    category = "network"

    def __init__(self, service: Any) -> None:
        self._svc = service


class HomePlayTool(_HomeTool):
    name = "home_play"
    description = (
        "Toca música nas caixas de som da casa (sistema EspMusic). Aceita "
        "nome de música/artista, link do YouTube ou caminho de pasta. "
        "'room' escolhe o cômodo; sem ele, toca na caixa que já está "
        "selecionada. mode='queue' põe na fila em vez de tocar agora. "
        + _ONLY_WHEN_AT_HOME
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Música, artista, link do YouTube ou caminho.",
            },
            "room": {
                "type": "string",
                "description": "Cômodo, como o usuário fala: 'sala', 'banheiro'.",
            },
            "mode": {
                "type": "string",
                "enum": ["now", "queue"],
                "description": "'now' toca agora (padrão), 'queue' põe na fila.",
            },
        },
        "required": ["query"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            return ToolResult(ok=False, error="'query' é obrigatório")
        try:
            out = await self._svc.music.play(
                query,
                room=args.get("room") or None,
                mode=str(args.get("mode") or "now"),
            )
        except Exception as e:
            return _failure(e)
        return ToolResult(ok=True, output=out)


class HomeControlTool(_HomeTool):
    name = "home_control"
    description = (
        "Controla o som da casa: pausar, voltar, pular, parar, mudo, "
        "volume e rádio (que reabastece a fila com músicas parecidas). "
        "volume_up/volume_down andam em passos de 2 dB; volume_set usa "
        "'value' em porcentagem (0 a 100). " + _ONLY_WHEN_AT_HOME
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ACTIONS},
            "value": {
                "type": "number",
                "description": "Só para volume_set: volume alvo de 0 a 100.",
            },
            "room": {
                "type": "string",
                "description": "Cômodo; sem ele, age na caixa selecionada.",
            },
        },
        "required": ["action"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        action = str(args.get("action") or "")
        if action not in ACTIONS:
            return ToolResult(
                ok=False,
                error=f"ação desconhecida: '{action}'. Use uma de: {', '.join(ACTIONS)}",
            )
        value = args.get("value")
        try:
            out = await self._svc.music.control(
                action,
                value=float(value) if value is not None else None,
                room=args.get("room") or None,
            )
        except Exception as e:
            return _failure(e)
        return ToolResult(ok=True, output=out)


class HomeAnnounceTool(_HomeTool):
    name = "home_announce"
    description = (
        "Fala um aviso nas caixas de som da casa, com a voz da Seraphine. "
        "O aviso corta a música e ela volta do ponto exato depois. Sai na "
        "caixa que está selecionada. " + _ONLY_WHEN_AT_HOME
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "O que falar, em português, em uma ou duas frases.",
            },
        },
        "required": ["text"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        text = str(args.get("text") or "").strip()
        if not text:
            return ToolResult(ok=False, error="'text' é obrigatório")

        tts = getattr(self._svc, "tts", None)
        if tts is None:
            return ToolResult(
                ok=False, error="não tenho voz configurada para falar na casa"
            )

        # ogg é pequeno e todo adaptador que o suporta já entrega pronto;
        # os outros só têm o stream PCM, que embrulhamos num WAV.
        try:
            audio = await tts.synthesize_ogg(text)
            filename = "aviso.ogg"
        except NotImplementedError:
            try:
                pcm = b"".join([chunk async for chunk in tts.synthesize_stream(text)])
            except Exception as e:
                logger.exception("TTS stream falhou")
                return ToolResult(ok=False, error=f"não consegui gerar a voz: {e}")
            if not pcm:
                return ToolResult(ok=False, error="o TTS devolveu áudio vazio")
            audio = _pcm_to_wav(pcm)
            filename = "aviso.wav"
        except Exception as e:
            logger.exception("TTS ogg falhou")
            return ToolResult(ok=False, error=f"não consegui gerar a voz: {e}")

        if not audio:
            return ToolResult(ok=False, error="o TTS devolveu áudio vazio")

        try:
            out = await self._svc.music.announce(audio, filename=filename)
        except Exception as e:
            return _failure(e)
        return ToolResult(ok=True, output=out, metadata={"text": text})


class HomeStatusTool(_HomeTool):
    name = "home_status"
    description = (
        "Diz o que está tocando nas caixas da casa: cômodo selecionado, "
        "faixa, volume, tamanho da fila, rádio e quais caixas existem. "
        "Use antes de mudar de cômodo, ou quando o usuário perguntar o que "
        "está tocando na casa."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            out = await self._svc.music.status()
        except Exception as e:
            return _failure(e)
        return ToolResult(ok=True, output=out)
```

- [ ] **Step 5: Rodar os testes**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/ -v`
Expected: PASS — os três arquivos de teste da casa.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/home/service.py \
        apps/seraphine/backend/seraphine/tools/home.py \
        apps/seraphine/backend/tests/home/test_home_tools.py
git commit -m "feat(home): tools home_play/control/announce/status"
```

---

### Task 7: Ligar tudo no `main.py` e verificar na casa de verdade

O registro é tardio porque depende de duas coisas que só existem depois: `app.state` (para o broker de proxy) e `tts` (para a voz do aviso). É o mesmo padrão do `WhatsAppSendVoiceTool` (`main.py:753-757`).

**Files:**
- Modify: `apps/seraphine/backend/seraphine/main.py:753-757` (logo depois do registro tardio do WhatsApp)

**Interfaces:**
- Consumes: `HomeService` e as quatro tools (Task 6); `tts` e `app` do escopo do lifespan.
- Produces: as quatro tools no registry em produção.

- [ ] **Step 1: Travar o contrato que o `main.py` vai usar**

Este teste passa de primeira — o `HomeService` da Task 6 já o satisfaz. Ele existe para que uma mudança futura no serviço quebre aqui, e não só em produção. Acrescentar ao fim de `tests/home/test_home_tools.py`:

```python
def test_the_service_exposes_music_and_tts() -> None:
    # Contrato que main.py usa ao registrar as tools.
    from seraphine.home.service import HomeService

    svc = HomeService(app_state=object(), tts="fake-tts")
    assert svc.tts == "fake-tts"
    assert hasattr(svc.music, "play")
    assert hasattr(svc.music, "announce")
```

- [ ] **Step 2: Rodar o teste**

Run: `cd apps/seraphine/backend && uv run pytest tests/home/test_home_tools.py -k service_exposes -v`
Expected: PASS

- [ ] **Step 3: Registrar as tools no lifespan**

Em `seraphine/main.py`, logo depois do bloco `if whatsapp_client is not None:` que registra `WhatsAppSendVoiceTool` (`main.py:753-757`):

```python
    # ------------------------------------------------------------------
    # Casa (EspMusic) — som distribuído na rede local. Registro tardio:
    # precisa de `app.state` (o relé sai pelo proxy_broker, resolvido em
    # tempo de chamada) e de `tts` (a voz dos avisos), que só existem
    # aqui. Não é gated por nada: sem o app Tauri aberto as tools apenas
    # respondem "não alcanço a casa", que é a informação certa.
    # ------------------------------------------------------------------
    try:
        from seraphine.home.service import HomeService
        from seraphine.tools.home import (
            HomeAnnounceTool,
            HomeControlTool,
            HomePlayTool,
            HomeStatusTool,
        )

        home_service = HomeService(app.state, tts=tts)
        tools.register(HomePlayTool(home_service))
        tools.register(HomeControlTool(home_service))
        tools.register(HomeAnnounceTool(home_service))
        tools.register(HomeStatusTool(home_service))
        logger.info("Home (EspMusic) tools wired")
    except Exception as e:
        logger.warning("Home (EspMusic) tools failed (non-critical): %s", e)
```

- [ ] **Step 4: Rodar a suíte inteira do backend**

Run: `cd apps/seraphine/backend && uv run pytest -q`
Expected: PASS, sem regressão. (Se algum teste de registry contar tools, ele sobe em 4 — ajustar o número esperado nesse teste.)

- [ ] **Step 5: Rodar lint e os testes do frontend**

Run:
```bash
cd apps/seraphine/backend && uv run ruff check seraphine/home seraphine/tools/home.py
cd ../frontend && pnpm test && pnpm lint
cd src-tauri && cargo test home::
```
Expected: tudo limpo.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/main.py \
        apps/seraphine/backend/tests/home/test_home_tools.py
git commit -m "feat(home): registrar as tools da casa no lifespan"
```

- [ ] **Step 7: Deploy**

```bash
git push vps main            # backend (o hook do VPS redeploya via docker compose)
cd apps/seraphine/frontend && pnpm tauri:install   # app do Mac com o relé
```
No PC Windows, `git pull` no repo do EspMusic e reiniciar `python espmusic.py serve`.

- [ ] **Step 8: Verificação E2E manual**

Pré-condições: EspMusic no ar, ao menos uma caixa ligada, app da Seraphine aberto no Mac e na mesma rede.

Na Seraphine, pedir e conferir:

1. "o que está tocando na casa?" → `home_status` responde com cômodo, volume e caixas.
2. "toca Djavan na sala" → toca na caixa da sala.
3. "aumenta o volume da casa" → sobe ~2 dB (confirmar no painel do EspMusic).
4. "põe volume da casa em 40%" → o painel mostra ~40%.
5. "pula essa música" (falando da casa) → troca de faixa.
6. "avisa na casa que o jantar chegou" → **a voz da Seraphine** sai na caixa, a música corta e volta do ponto exato.
7. "toca Djavan na garagem" → erro listando os cômodos que existem, sem travar.
8. Fechar o app do Mac e pedir "toca algo na sala" → "não alcanço a casa — o app precisa estar aberto".
9. "toca Djavan" (sem citar cômodo) → continua tocando no **navegador** do Mac, não nas caixas. Se for para as caixas, reforçar `_ONLY_WHEN_AT_HOME` na descrição.

- [ ] **Step 9: Registrar o resultado**

Anotar no fim do spec (`docs/superpowers/specs/2026-07-30-seraphine-espmusic-design.md`) uma seção "Verificação E2E" com a data do dia e, item por item dos 9 acima, o que passou e o que não passou. Commitar junto.

---

## Notas para quem for implementar

- **Não registre `lan_request` no `ToolRegistry`.** Ela é uma capacidade do cliente. Se o LLM enxergar um HTTP genérico para a LAN, a allowlist do Rust vira a única defesa e o modelo passa a improvisar chamadas.
- **`DEFAULT_BASE` e `ALLOWED` precisam concordar.** Mudou um, muda o outro; o relé recusa qualquer base fora da lista, e o erro aparece como "host não permitido".
- **A ordem em `LanTransport.request` importa**: um 404 chega com `ok=False` e `status=404`. Checar o status antes do `ok` é o que separa "a casa respondeu erro" de "não alcancei a casa".
- **`synthesize_stream` é async generator** nos adaptadores reais (Qwen3 e ElevenLabs), e ambos aceitam `str` além de `AsyncIterator[str]`, apesar da assinatura da ABC. Por isso o `async for chunk in tts.synthesize_stream(text)` sem `await` na chamada.
