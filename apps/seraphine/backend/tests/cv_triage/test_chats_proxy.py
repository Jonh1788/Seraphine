"""Proxy test for GET /whatsapp/chats — used by cv_triage Mac wizard."""

from __future__ import annotations

import httpx
import respx
from fastapi.testclient import TestClient

import seraphine.config
import seraphine.main
from seraphine.main import create_app


def test_chats_proxy_returns_bridge_payload(monkeypatch, tmp_path):
    monkeypatch.setenv("SERAPHINE_WHATSAPP_BRIDGE_URL", "http://bridge")
    monkeypatch.setenv("SERAPHINE_SQLITE_PATH", str(tmp_path / "t.sqlite"))
    monkeypatch.setenv("SERAPHINE_API_KEY", "k")
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    # Re-instantiate settings (same pattern as test_routes.py uses).
    seraphine.config.settings = seraphine.config.Settings()
    seraphine.main.settings = seraphine.config.settings
    client = TestClient(create_app())
    with respx.mock(assert_all_called=True) as m:
        m.get("http://bridge/api/chats").mock(
            return_value=httpx.Response(
                200,
                json=[
                    {"id": "g@g.us", "name": "RH", "isGroup": True},
                    {"id": "1@c.us", "name": "Ana", "isGroup": False},
                ],
            )
        )
        r = client.get("/whatsapp/chats", headers={"X-API-Key": "k"})
        assert r.status_code == 200, r.text
        chats = r.json()
        assert any(c.get("isGroup") for c in chats)
