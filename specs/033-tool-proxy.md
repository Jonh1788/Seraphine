# 033 — Tool Proxy to Mac Client

## Context

Com o backend rodando na VPS, Seraphine perdeu acesso direto ao Mac
do usuário. Ferramentas que precisam executar *localmente* (screen
capture, click, shell, filesystem, clipboard nativo) não podem rodar
no container Linux.

Em vez de duplicar o backend no Mac, inverter o fluxo: a VPS pede, o
`.app` executa localmente, e devolve o resultado pela WS que já está
aberta. O LLM continua no servidor, mas as "mãos" dele ficam no Mac.

## Design

### Flag no Tool base

```python
class Tool(ABC):
    ...
    proxy_to_client: bool = False
```

Tools que precisam do Mac setam `proxy_to_client = True`. São
escolhidas tool-a-tool; o default continua executando no server.

### Fluxo

```
LLM → tool_call → dispatcher
                      │
                      ├─ proxy_to_client? ──┐
                      │                     │
               NO (exec local)         YES (proxy)
                      │                     │
                      │            send tool_proxy_request
                      │                     │
                      │              (wait for WS reply)
                      │                     │
              ToolResult ────────── tool_proxy_response
                      │
                      └──→ back to LLM
```

### Mensagens WS

**Server → Client:**
```json
{
  "type": "tool_proxy_request",
  "request_id": "uuid",
  "tool": "screen_capture",
  "args": {}
}
```

**Client → Server:**
```json
{
  "type": "tool_proxy_response",
  "request_id": "uuid",
  "ok": true,
  "output": "<text or base64>",
  "error": null,
  "metadata": {}
}
```

### Timeout

90s hard timeout. Se expira, tool retorna erro mas conversa continua.
A VPS não trava.

### Segurança

- Aprovação humana nos tools destrutivos segue via `approval_request`
  (infra existente) — antes de enviar o proxy_request.
- Rust-side, cada comando valida args (ex: path dentro de
  `allowed_roots`, shell com timeout).
- Proxy só dispara se há WS ativa do Tauri (detectado por
  header `X-Tauri: 1` ou um registro `client_info`).

## Escopo MVP

Ferramentas a proxy:

1. **run_shell** (executado no Mac, não no container)
2. **read_file / write_file / list_dir** (filesystem do Mac)
3. **screen_capture** (screencapture via subprocess no Mac)
4. **read_clipboard / write_clipboard** (já existe parcial)

Out of scope MVP (follow-up):

- `screen_click` / `screen_type` — precisam cliclick / accessibility
  permission; complexo mas factível.
- `browser_*` Mac-local — já roda via VPS/Chromium, sem urgência.

## Entregáveis

- [ ] Spec (este arquivo).
- [ ] `Tool.proxy_to_client` flag em base.
- [ ] `ProxyBroker` server-side com future registry.
- [ ] WS handler pra `tool_proxy_response`.
- [ ] Frontend listener em `App.tsx` → dispatch → Tauri invoke →
      send `tool_proxy_response`.
- [ ] Rust commands: `run_shell_local`, `read_clipboard`,
      `write_clipboard`, `screen_capture_local`, filesystem básico.
- [ ] Engine dispatcher respeita a flag.
- [ ] Marcar os tools existentes (screen, shell, filesystem,
      clipboard) com `proxy_to_client=True`.

## Riscos

- **WS disconnect mid-proxy**: timeout expira → tool retorna erro.
  OK. Não deixa LLM travado.
- **Multiple clients**: se há mais de uma WS conectada (ex: Mac + web
  aberto ao mesmo tempo), broadcast pro primeiro, o primeiro que
  responder vence. No MVP, assume single-client.
- **Rust panic**: catch em cada cmd, retorna Err string.
- **Arg schema drift**: tool args no server e Tauri cmd args precisam
  casar. Test manual cobre o golden path.
