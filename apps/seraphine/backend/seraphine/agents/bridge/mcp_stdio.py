"""Ponte MCP (stdio) da Seraphine: o programa que Codex e Claude Code iniciam a cada turno.

Roda como SCRIPT (``python -I -S mcp_stdio.py``), só com a biblioteca padrão, e nunca importa
o pacote ``seraphine``: o Codex segue sem ferramentas se o ``initialize`` demora mais que cerca
de 1 s, então nada pesado é importado na partida (``http.client`` só entra depois do primeiro
``initialize``: o aviso "presente" sai numa thread, depois da resposta, e a chamada importa na hora de repassar).

Recebe do harness, pelo ambiente do processo:

- ``SERAPHINE_BRIDGE_URL``    endereço do porteiro (``http://127.0.0.1:<porta>``)
- ``SERAPHINE_BRIDGE_TOKEN``  token do turno (nunca é escrito em lugar nenhum por esta ponte)
- ``SERAPHINE_BRIDGE_TOOLS``  caminho do arquivo JSON ``{"tools": [...]}`` deste turno

Protocolo: JSON-RPC 2.0, uma mensagem por linha. ``initialize`` e ``tools/list`` são
respondidos sem falar com o backend. ``tools/call`` é repassada ao porteiro; erro de ferramenta
volta como ``isError``. Pedido desconhecido (por exemplo ``server/discover``, que o Claude Code
manda antes do ``initialize``) recebe -32601; notificação desconhecida é ignorada. Na saída
padrão só sai protocolo. Termina quando a entrada padrão fecha.
"""

import json
import os
import sys
import threading

SERVER_NAME = "seraphine"
SERVER_VERSION = "1"
DEFAULT_PROTOCOL = "2025-06-18"
CALL_TIMEOUT_S = 45.0  # o porteiro corta a ferramenta em 30 s; sobra margem de transporte
HELLO_TIMEOUT_S = 5.0
TOKEN_HEADER = "X-Seraphine-Bridge-Token"

_out = sys.stdout.buffer
_out_lock = threading.Lock()
sys.stdout = sys.stderr  # qualquer print perdido vai para o erro padrão, nunca para o protocolo

_tools_cache = None
_hello_started = False


def send(obj):
    data = (json.dumps(obj, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
    with _out_lock:
        try:
            _out.write(data)
            _out.flush()
        except (OSError, ValueError):
            os._exit(0)  # quem nos iniciou já foi embora


def reply(mid, result):
    send({"jsonrpc": "2.0", "id": mid, "result": result})


def fail(mid, code, message):
    send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def tool_text(text, is_error=False):
    out = {"content": [{"type": "text", "text": text}]}
    if is_error:
        out["isError"] = True
    return out


def load_tools():
    global _tools_cache
    if _tools_cache is None:
        tools = []
        try:
            with open(os.environ.get("SERAPHINE_BRIDGE_TOOLS", ""), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict) and isinstance(data.get("tools"), list):
                tools = [t for t in data["tools"] if isinstance(t, dict)]
        except (OSError, ValueError):
            tools = []
        _tools_cache = tools
    return _tools_cache


def post(path, payload, timeout):
    """POST JSON ao porteiro. Devolve ``(status, corpo_json_ou_None)``; levanta OSError se falhar."""
    import http.client
    from urllib.parse import urlsplit

    base = urlsplit(os.environ.get("SERAPHINE_BRIDGE_URL", ""))
    if not base.hostname:
        raise OSError("endereço do porteiro ausente")
    body = json.dumps(payload).encode("utf-8")
    conn = http.client.HTTPConnection(base.hostname, base.port or 80, timeout=timeout)
    try:
        conn.request("POST", path, body=body, headers={
            "Content-Type": "application/json",
            TOKEN_HEADER: os.environ.get("SERAPHINE_BRIDGE_TOKEN", ""),
        })
        resp = conn.getresponse()
        raw = resp.read()
        try:
            return resp.status, json.loads(raw.decode("utf-8"))
        except ValueError:
            return resp.status, None
    finally:
        conn.close()


def say_hello():
    try:
        post("/agents/bridge/hello", {}, HELLO_TIMEOUT_S)
    except Exception:  # noqa: BLE001 - avisar é opcional; o motor segue sem depender disso
        pass


def start_hello_once():
    """Avisa "presente" uma vez, depois de responder ao primeiro ``initialize``: o aperto de mão
    nunca espera o backend nem a importação de ``http.client``."""
    global _hello_started
    if not _hello_started:
        _hello_started = True
        threading.Thread(target=say_hello, daemon=True).start()


def forward_call(mid, params):
    name = params.get("name") if isinstance(params, dict) else None
    arguments = params.get("arguments") if isinstance(params, dict) else None
    if not isinstance(name, str) or not name:
        reply(mid, tool_text("Pedido de ferramenta sem nome.", True))
        return
    try:
        status, data = post("/agents/bridge/call", {
            "tool": name, "arguments": arguments if isinstance(arguments, dict) else {}}, CALL_TIMEOUT_S)
    except Exception:  # noqa: BLE001
        reply(mid, tool_text("Não consegui falar com a Seraphine agora.", True))
        return
    if status != 200 or not isinstance(data, dict):
        reply(mid, tool_text("A Seraphine recusou esta chamada (a execução pode ter terminado).", True))
    elif data.get("ok") is True:
        reply(mid, tool_text(str(data.get("content") or "")))
    else:
        reply(mid, tool_text(str(data.get("error") or "A ferramenta falhou."), True))


def handle(msg):
    if not isinstance(msg, dict):
        return
    method = msg.get("method")
    if not isinstance(method, str):
        return  # resposta a algo que não pedimos
    has_id = "id" in msg
    mid = msg.get("id")
    params = msg.get("params")
    if method == "initialize":
        version = params.get("protocolVersion") if isinstance(params, dict) else None
        reply(mid, {
            "protocolVersion": version if isinstance(version, str) and version else DEFAULT_PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}})
        start_hello_once()
    elif method == "tools/list":
        reply(mid, {"tools": load_tools()})
    elif method == "tools/call" and has_id:
        threading.Thread(target=forward_call, args=(mid, params), daemon=True).start()
    elif method == "ping" and has_id:
        reply(mid, {})
    elif has_id:
        fail(mid, -32601, "Método não encontrado")
    # sem id: notificação (``notifications/initialized`` e outras); ignorada


def main():
    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode("utf-8"))
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON inválido"}})
            continue
        try:
            handle(msg)
        except Exception:  # noqa: BLE001 - uma mensagem ruim não derruba a ponte
            if isinstance(msg, dict) and "id" in msg:
                fail(msg.get("id"), -32603, "Erro interno da ponte")


if __name__ == "__main__":
    main()
