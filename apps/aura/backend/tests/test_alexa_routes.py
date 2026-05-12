import base64
import json
import sqlite3
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aura.alexa.routes import build_router
from aura.alexa.schema import migrate


@pytest.fixture
def app():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript(
        "CREATE TABLE users (id TEXT PRIMARY KEY);"
        "INSERT INTO users (id) VALUES ('u1');"
        "CREATE TABLE aura_chat_conversations "
        "(id TEXT PRIMARY KEY, user_id TEXT, metadata TEXT, created_at TEXT);"
    )
    migrate(conn)

    async def fake_runner(**kw):
        return {"reply": "oi humano"}

    from aura.alexa.oauth import AlexaOAuth
    from aura.alexa.service import AlexaService

    oauth = AlexaOAuth(
        conn=conn,
        client_id="cid",
        client_secret="csecret",
        allowed_redirects=("https://layla.amazon.com/api/skill/link/v",),
    )
    svc = AlexaService(conn=conn, run_agentic=fake_runner, timeout_seconds=7.0)

    app = FastAPI()
    # Stub authentication: a test header X-Test-User sets the current user.
    async def stub_user_id(request):
        return request.headers.get("X-Test-User")

    app.include_router(
        build_router(
            oauth=oauth,
            service=svc,
            skill_id="amzn1.ask.skill.fake",
            verify_signature=lambda **kw: None,  # bypass crypto in tests
            get_current_user_id=stub_user_id,
        )
    )
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def _alexa_request(intent_name: str, access_token: str | None, *, app_id: str = "amzn1.ask.skill.fake"):
    return {
        "version": "1.0",
        "session": {
            "sessionId": "s-1",
            "application": {"applicationId": app_id},
            "user": ({"accessToken": access_token} if access_token else {}),
        },
        "request": {"type": "IntentRequest", "intent": {"name": intent_name}, "timestamp": "2026-05-12T12:00:00Z"},
    }


def test_authorize_redirects_to_login_when_anon(client):
    r = client.get(
        "/alexa/oauth/authorize",
        params={
            "client_id": "cid",
            "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
            "state": "xyz",
            "response_type": "code",
        },
        follow_redirects=False,
    )
    assert r.status_code in (302, 307)
    loc = r.headers["location"]
    parsed = urlparse(loc)
    assert parsed.path == "/login"
    qs = parse_qs(parsed.query)
    # The whole next= value must round-trip cleanly; no leaked siblings.
    assert list(qs.keys()) == ["next"]
    next_url = qs["next"][0]
    next_parsed = urlparse(next_url)
    assert next_parsed.path == "/alexa/oauth/authorize"
    next_qs = parse_qs(next_parsed.query)
    assert next_qs["client_id"] == ["cid"]
    assert next_qs["redirect_uri"] == ["https://layla.amazon.com/api/skill/link/v"]
    assert next_qs["state"] == ["xyz"]
    assert next_qs["response_type"] == ["code"]


def test_authorize_issues_code_when_logged_in(client):
    r = client.get(
        "/alexa/oauth/authorize",
        headers={"X-Test-User": "u1"},
        params={
            "client_id": "cid",
            "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
            "state": "xyz",
            "response_type": "code",
        },
        follow_redirects=False,
    )
    assert r.status_code in (302, 307)
    parsed = urlparse(r.headers["location"])
    qs = parse_qs(parsed.query)
    assert qs["state"] == ["xyz"]
    assert qs["code"][0]


def test_authorize_bad_redirect(client):
    r = client.get(
        "/alexa/oauth/authorize",
        headers={"X-Test-User": "u1"},
        params={
            "client_id": "cid",
            "redirect_uri": "https://evil.com/",
            "state": "x",
            "response_type": "code",
        },
    )
    assert r.status_code == 400


def test_token_exchange_full_flow(client):
    r1 = client.get(
        "/alexa/oauth/authorize",
        headers={"X-Test-User": "u1"},
        params={"client_id": "cid", "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
                "state": "x", "response_type": "code"},
        follow_redirects=False,
    )
    code = parse_qs(urlparse(r1.headers["location"]).query)["code"][0]

    basic = base64.b64encode(b"cid:csecret").decode()
    r2 = client.post(
        "/alexa/oauth/token",
        headers={"Authorization": f"Basic {basic}"},
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
        },
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["token_type"] == "Bearer"
    assert body["access_token"]


def test_alexa_endpoint_without_token_returns_link_account(client):
    r = client.post("/alexa", json=_alexa_request("PerguntarIntent", None))
    assert r.status_code == 200
    body = r.json()
    assert body["response"]["card"] == {"type": "LinkAccount"}


def test_alexa_endpoint_with_token_runs_intent(client):
    # First, mint a token via the OAuth flow.
    r1 = client.get(
        "/alexa/oauth/authorize",
        headers={"X-Test-User": "u1"},
        params={"client_id": "cid", "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
                "state": "x", "response_type": "code"},
        follow_redirects=False,
    )
    code = parse_qs(urlparse(r1.headers["location"]).query)["code"][0]
    basic = base64.b64encode(b"cid:csecret").decode()
    tok = client.post(
        "/alexa/oauth/token",
        headers={"Authorization": f"Basic {basic}"},
        data={"grant_type": "authorization_code", "code": code,
              "redirect_uri": "https://layla.amazon.com/api/skill/link/v"},
    ).json()

    body = _alexa_request("PerguntarIntent", tok["access_token"])
    body["request"]["intent"]["slots"] = {"query": {"value": "qual minha agenda"}}
    r = client.post("/alexa", json=body)
    assert r.status_code == 200
    assert "oi humano" in r.json()["response"]["outputSpeech"]["ssml"]


def test_alexa_endpoint_rejects_wrong_app_id(client):
    body = _alexa_request("PerguntarIntent", "doesnt-matter", app_id="amzn1.ask.skill.OTHER")
    r = client.post("/alexa", json=body)
    assert r.status_code == 400


def test_status_endpoint(client):
    r = client.get("/alexa/status", headers={"X-Test-User": "u1"})
    assert r.status_code == 200
    assert r.json() == {"linked": False, "amazon_email_masked": None}


def test_disconnect_endpoint(client):
    r = client.post("/alexa/disconnect", headers={"X-Test-User": "u1"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_token_endpoint_invalid_grant_on_unknown_code(client):
    basic = base64.b64encode(b"cid:csecret").decode()
    r = client.post(
        "/alexa/oauth/token",
        headers={"Authorization": f"Basic {basic}"},
        data={
            "grant_type": "authorization_code",
            "code": "not-a-real-code",
            "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
        },
    )
    assert r.status_code == 400
    assert r.json() == {"error": "invalid_grant"}


def test_token_endpoint_refresh_grant_rotates(client):
    # Authorize → code → access+refresh tokens.
    r1 = client.get(
        "/alexa/oauth/authorize",
        headers={"X-Test-User": "u1"},
        params={"client_id": "cid", "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
                "state": "x", "response_type": "code"},
        follow_redirects=False,
    )
    code = parse_qs(urlparse(r1.headers["location"]).query)["code"][0]
    basic = base64.b64encode(b"cid:csecret").decode()
    first = client.post(
        "/alexa/oauth/token",
        headers={"Authorization": f"Basic {basic}"},
        data={"grant_type": "authorization_code", "code": code,
              "redirect_uri": "https://layla.amazon.com/api/skill/link/v"},
    ).json()
    # Now refresh the access token.
    second = client.post(
        "/alexa/oauth/token",
        headers={"Authorization": f"Basic {basic}"},
        data={"grant_type": "refresh_token", "refresh_token": first["refresh_token"]},
    )
    assert second.status_code == 200
    body = second.json()
    assert body["access_token"]
    assert body["access_token"] != first["access_token"]
    assert body["refresh_token"] != first["refresh_token"]
    # Old refresh now consumed.
    replay = client.post(
        "/alexa/oauth/token",
        headers={"Authorization": f"Basic {basic}"},
        data={"grant_type": "refresh_token", "refresh_token": first["refresh_token"]},
    )
    assert replay.status_code == 400
    assert replay.json() == {"error": "invalid_grant"}


def test_token_endpoint_missing_basic_auth(client):
    r = client.post(
        "/alexa/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": "anything",
            "redirect_uri": "https://layla.amazon.com/api/skill/link/v",
        },
    )
    assert r.status_code == 401
    assert r.json() == {"error": "invalid_client"}
