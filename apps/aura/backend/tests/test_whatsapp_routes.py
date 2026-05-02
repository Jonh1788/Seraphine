import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock

from aura.whatsapp.routes import router as wa_router
from mod_tasks.routes import get_current_user_id


def _build_app(svc, webhook_token="hooktoken"):
    app = FastAPI()
    app.dependency_overrides[get_current_user_id] = lambda: "u1"
    app.state.whatsapp_service = svc
    app.state.whatsapp_webhook_token = webhook_token
    app.state.whatsapp_admin_token = "admintoken"
    app.include_router(wa_router)
    return app


def test_webhook_rejects_missing_token():
    svc = MagicMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/whatsapp/webhook", json={})
    assert resp.status_code == 401


def test_webhook_rejects_wrong_token():
    svc = MagicMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook", json={},
            headers={"X-Evolution-Webhook-Token": "nope"},
        )
    assert resp.status_code == 401


def test_webhook_accepts_and_dispatches_to_router():
    svc = MagicMock()
    svc.route_inbound = AsyncMock(return_value={
        "user_id": "u1",
        "conversation_id": "c1",
        "text": "oi",
    })
    svc.process_user_message = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={
                "event": "messages.upsert",
                "data": {
                    "key": {
                        "remoteJid": "5511987654321@s.whatsapp.net",
                        "fromMe": False,
                    },
                    "message": {"conversation": "oi"},
                },
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    svc.route_inbound.assert_awaited_once()
    args = svc.route_inbound.await_args[0][0]
    assert args["phone_e164"] == "+5511987654321"
    assert args["text"] == "oi"
    assert args["is_group"] is False


def test_webhook_drops_when_router_returns_none():
    svc = MagicMock()
    svc.route_inbound = AsyncMock(return_value=None)
    svc.process_user_message = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={"event": "messages.upsert",
                  "data": {"key": {"remoteJid": "x@s", "fromMe": False},
                           "message": {"conversation": "oi"}}},
        )
    assert resp.status_code == 200
    svc.process_user_message.assert_not_called()


def test_webhook_swallows_internal_errors_returns_200():
    svc = MagicMock()
    svc.route_inbound = AsyncMock(side_effect=RuntimeError("boom"))
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={"event": "messages.upsert",
                  "data": {"key": {"remoteJid": "x@s", "fromMe": False},
                           "message": {"conversation": "oi"}}},
        )
    assert resp.status_code == 200


def test_connect_start_calls_service():
    svc = MagicMock()
    svc.start_verification = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/start",
            json={"phone": "+5511987654321"},
        )
    assert resp.status_code == 200
    svc.start_verification.assert_awaited_once_with("u1", "+5511987654321")


def test_connect_start_cooldown_returns_429():
    from aura.whatsapp.service import CooldownError
    svc = MagicMock()
    svc.start_verification = AsyncMock(
        side_effect=CooldownError("aguarde alguns segundos antes de pedir outro código"),
    )
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/start",
            json={"phone": "+5511987654321"},
        )
    assert resp.status_code == 429
    assert "aguarde" in resp.json()["detail"].lower()


def test_connect_start_invalid_phone_returns_400():
    from aura.whatsapp.phone import InvalidPhone
    svc = MagicMock()
    svc.start_verification = AsyncMock(side_effect=InvalidPhone("bad"))
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/start",
            json={"phone": "abc"},
        )
    assert resp.status_code == 400


def test_connect_verify_returns_ok_when_valid():
    svc = MagicMock()
    svc.verify = AsyncMock(return_value=True)
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/verify", json={"code": "482910"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_connect_verify_returns_400_when_invalid():
    svc = MagicMock()
    svc.verify = AsyncMock(return_value=False)
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/verify", json={"code": "000000"},
        )
    assert resp.status_code == 400


def test_webhook_drops_messages_with_empty_text_before_routing():
    """The adapter should drop a messages.upsert that has no text
    payload (e.g. an image with no caption) without ever calling
    route_inbound. This keeps the service-layer router focused."""
    svc = MagicMock()
    svc.route_inbound = AsyncMock()
    svc.process_user_message = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={
                "event": "messages.upsert",
                "data": {
                    "key": {
                        "remoteJid": "5511987654321@s.whatsapp.net",
                        "fromMe": False,
                    },
                    "message": {"imageMessage": {"caption": ""}},
                },
            },
        )
    assert resp.status_code == 200
    svc.route_inbound.assert_not_called()


def test_status_returns_service_payload():
    svc = MagicMock()
    svc.get_status = AsyncMock(return_value={
        "verified": True, "phone_masked": "+55 11 9••••-••42",
    })
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/whatsapp/status")
    assert resp.status_code == 200
    assert resp.json() == {"verified": True, "phone_masked": "+55 11 9••••-••42"}


def test_disconnect_calls_service():
    svc = MagicMock()
    svc.disconnect = AsyncMock(return_value=True)
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/whatsapp/disconnect")
    assert resp.status_code == 200
    svc.disconnect.assert_awaited_once_with("u1")


def test_admin_qr_requires_admin_token():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_qr = AsyncMock(return_value=("iVBOR", None))
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/whatsapp/admin/qr")
    assert resp.status_code == 401


def test_admin_qr_returns_base64_and_state():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_qr = AsyncMock(return_value=("iVBOR", None))
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get(
            "/whatsapp/admin/qr",
            headers={"X-Aura-Admin-Token": "admintoken"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"qr": "iVBOR", "state": None}


def test_admin_qr_when_already_connected():
    """get_qr returns (None, "open") when the instance is already
    linked — the endpoint exposes that so the admin UI can show
    'connected' without falling back to /admin/status."""
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_qr = AsyncMock(return_value=(None, "open"))
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get(
            "/whatsapp/admin/qr",
            headers={"X-Aura-Admin-Token": "admintoken"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"qr": None, "state": "open"}


def test_admin_status_returns_service_state():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_status = AsyncMock(return_value={
        "connected": True, "phone": "+5511987654321", "state": "open",
    })
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get(
            "/whatsapp/admin/status",
            headers={"X-Aura-Admin-Token": "admintoken"},
        )
    assert resp.status_code == 200
    assert resp.json()["connected"] is True


def test_admin_status_requires_admin_token():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_status = AsyncMock(return_value={
        "connected": True, "phone": "+5511987654321", "state": "open",
    })
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/whatsapp/admin/status")
    assert resp.status_code == 401
