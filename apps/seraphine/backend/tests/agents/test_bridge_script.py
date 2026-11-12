"""The MCP bridge script (``agents/bridge/mcp_stdio.py``) driven as a real subprocess over stdio,
against a throw-away HTTP server standing in for the gateway."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterator

import pytest

from seraphine.agents.gateway import SCRIPT_PATH

TOKEN = "tok-de-teste-nao-secreto"


class _Stub(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.seen: list[dict[str, Any]] = []
        self.status = 200
        self.reply: Callable[[dict[str, Any]], dict[str, Any]] = lambda body: {"ok": True, "content": "olá"}

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        server: _Stub = self.server  # type: ignore[assignment]
        server.seen.append({"path": self.path, "token": self.headers.get("X-Seraphine-Bridge-Token"),
                            "origin": self.headers.get("Origin"), "body": body})
        payload = json.dumps(server.reply(body) if self.path.endswith("/call") else {"ok": True}).encode()
        self.send_response(server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: Any) -> None:  # silence
        pass


@pytest.fixture
def stub() -> Iterator[_Stub]:
    server = _Stub()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


class Bridge:
    def __init__(self, url: str, tools_file: Path | None) -> None:
        env = {**os.environ, "SERAPHINE_BRIDGE_URL": url, "SERAPHINE_BRIDGE_TOKEN": TOKEN,
               "SERAPHINE_BRIDGE_TOOLS": str(tools_file) if tools_file else str(Path(url).name) + "-ausente"}
        self.proc = subprocess.Popen(
            [sys.executable, "-I", "-S", str(SCRIPT_PATH)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env)
        self.raw: list[bytes] = []

    def send(self, obj: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(obj) + "\n").encode())
        self.proc.stdin.flush()

    def read(self) -> dict[str, Any]:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        self.raw.append(line)
        return json.loads(line)

    def ask(self, mid: int, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.send({"jsonrpc": "2.0", "id": mid, "method": method, **({"params": params} if params else {})})
        return self.read()

    def close(self) -> int:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        return self.proc.wait(timeout=10)


@pytest.fixture
def tools_file(tmp_path: Path) -> Path:
    path = tmp_path / "tools.json"
    path.write_text(json.dumps({"tools": [
        {"name": "ping", "description": "Teste: acentuação ok", "inputSchema": {"type": "object"}}]}),
        encoding="utf-8")
    return path


@pytest.fixture
def bridge(stub: _Stub, tools_file: Path) -> Iterator[Bridge]:
    b = Bridge(stub.url, tools_file)
    yield b
    if b.proc.poll() is None:
        b.proc.kill()
    b.proc.wait()
    for stream in (b.proc.stdin, b.proc.stdout, b.proc.stderr):
        if stream:
            stream.close()


def _wait(pred: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return
        time.sleep(0.02)
    raise AssertionError("condition not met in time")


def test_handshake_is_fast_and_the_tools_come_from_the_file(bridge: Bridge, stub: _Stub):
    started = time.perf_counter()
    init = bridge.ask(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    elapsed = time.perf_counter() - started
    assert init["id"] == 1 and init["result"]["protocolVersion"] == "2025-06-18"
    assert init["result"]["serverInfo"]["name"] == "seraphine"
    assert init["result"]["capabilities"] == {"tools": {"listChanged": False}}
    assert elapsed < 1.0, f"initialize took {elapsed:.3f}s (Codex gives up after about 1s)"
    bridge.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    tools = bridge.ask(2, "tools/list")
    assert [t["name"] for t in tools["result"]["tools"]] == ["ping"]
    assert tools["result"]["tools"][0]["description"] == "Teste: acentuação ok"
    # the handshake never needed the backend: only the (optional) hello went there
    assert all(s["path"].endswith("/hello") for s in stub.seen)


def test_a_call_is_forwarded_with_the_turn_token_and_answers_text(bridge: Bridge, stub: _Stub):
    bridge.ask(1, "initialize", {})
    stub.reply = lambda body: {"ok": True, "content": f"achei {body['arguments']['query']}"}
    res = bridge.ask(2, "tools/call", {"name": "search_notes", "arguments": {"query": "orçamento"}})
    assert res["result"] == {"content": [{"type": "text", "text": "achei orçamento"}]}
    call = next(s for s in stub.seen if s["path"] == "/agents/bridge/call")
    assert call["token"] == TOKEN and call["origin"] is None
    assert call["body"] == {"tool": "search_notes", "arguments": {"query": "orçamento"}}


def test_a_tool_error_becomes_an_mcp_tool_error_with_the_gateway_sentence(bridge: Bridge, stub: _Stub):
    bridge.ask(1, "initialize", {})
    stub.reply = lambda body: {"ok": False, "error": "Sem acesso: este agente não pode usar o grupo «Wiki»."}
    res = bridge.ask(2, "tools/call", {"name": "wiki_search", "arguments": {"query": "x"}})
    assert res["result"]["isError"] is True
    assert res["result"]["content"][0]["text"] == "Sem acesso: este agente não pode usar o grupo «Wiki»."
    stub.status = 401  # a revoked token: a tool error too, and the bridge stays alive
    res = bridge.ask(3, "tools/call", {"name": "ping", "arguments": {"text": "x"}})
    assert res["result"]["isError"] is True and "recusou" in res["result"]["content"][0]["text"]
    assert bridge.ask(4, "ping")["result"] == {}


def test_an_unreachable_gateway_is_a_tool_error_not_a_crash(tools_file: Path):
    b = Bridge("http://127.0.0.1:9", tools_file)  # nothing listens on port 9
    try:
        b.ask(1, "initialize", {})
        res = b.ask(2, "tools/call", {"name": "ping", "arguments": {}})
        assert res["result"]["isError"] is True
        assert b.ask(3, "tools/list")["result"]["tools"]
    finally:
        assert b.close() == 0


def test_server_discover_gets_method_not_found_and_the_bridge_lives_on(bridge: Bridge):
    first = bridge.ask(7, "server/discover")  # Claude Code sends this BEFORE initialize
    assert first["id"] == 7 and first["error"]["code"] == -32601
    assert bridge.ask(8, "initialize", {"protocolVersion": "2025-03-26"})["result"]["serverInfo"]["name"] == "seraphine"
    assert bridge.ask(9, "resources/list")["error"]["code"] == -32601
    assert bridge.proc.poll() is None


def test_unknown_notifications_and_stray_replies_are_ignored(bridge: Bridge):
    bridge.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}})
    bridge.send({"jsonrpc": "2.0", "method": "whatever/else"})
    bridge.send({"jsonrpc": "2.0", "id": 5, "result": {}})  # a reply to something we never asked
    # nothing came back for any of them: the next line out belongs to the ping
    assert bridge.ask(10, "ping") == {"jsonrpc": "2.0", "id": 10, "result": {}}


def test_hello_is_sent_once_with_the_token(bridge: Bridge, stub: _Stub):
    bridge.ask(1, "initialize", {})
    bridge.ask(2, "initialize", {})
    _wait(lambda: any(s["path"] == "/agents/bridge/hello" for s in stub.seen))
    time.sleep(0.3)
    hellos = [s for s in stub.seen if s["path"] == "/agents/bridge/hello"]
    assert len(hellos) == 1 and hellos[0]["token"] == TOKEN and hellos[0]["origin"] is None


def test_stdin_closing_ends_the_bridge_cleanly_and_stdout_is_only_protocol(bridge: Bridge):
    bridge.ask(1, "initialize", {})
    bridge.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    bridge.ask(2, "tools/list")
    assert bridge.proc.stdin is not None
    bridge.proc.stdin.write(b"isto nao e json\n")
    bridge.proc.stdin.flush()
    bad = bridge.read()
    assert bad["error"]["code"] == -32700 and bad["id"] is None
    assert bridge.close() == 0
    rest = bridge.proc.stdout.read() if bridge.proc.stdout else b""
    assert rest == b""
    for line in bridge.raw:
        msg = json.loads(line)  # every line is one JSON-RPC message, nothing else
        assert msg["jsonrpc"] == "2.0" and ("result" in msg or "error" in msg)
    assert TOKEN not in (bridge.proc.stderr.read().decode() if bridge.proc.stderr else "")


def test_a_missing_tools_file_gives_an_empty_list(stub: _Stub):
    b = Bridge(stub.url, None)
    try:
        assert b.ask(1, "tools/list")["result"] == {"tools": []}
    finally:
        assert b.close() == 0
