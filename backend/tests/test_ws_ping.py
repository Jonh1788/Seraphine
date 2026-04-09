from __future__ import annotations

from fastapi.testclient import TestClient

from seraphine.main import app


def test_ws_ping_pong() -> None:
    client = TestClient(app)
    with client.websocket_connect("/ws/conversation") as ws:
        ws.send_json({"type": "ping"})
        msg = ws.receive_json()
        assert msg["type"] == "pong"
        assert "ts" in msg


def test_ws_echo_unknown() -> None:
    client = TestClient(app)
    with client.websocket_connect("/ws/conversation") as ws:
        ws.send_json({"type": "whatever", "x": 1})
        msg = ws.receive_json()
        assert msg["type"] == "echo"
        assert msg["data"] == {"type": "whatever", "x": 1}
