"""HTTP guard (404 disabled / 401 token / 403 origin) and /agents/bootstrap rules."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService

from .conftest import ORIGIN, setup_agent, wait_run


def _client(app: FastAPI, host: str = "127.0.0.1") -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, client=(host, 50000))
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000")


@pytest.fixture
def app(svc: AgentHarnessService) -> FastAPI:
    a = FastAPI()
    a.include_router(router)
    a.state.agent_harness = svc
    return a


@pytest.fixture
def disabled_app() -> FastAPI:
    a = FastAPI()
    a.include_router(router)
    a.state.agent_harness = None
    return a


@pytest.mark.parametrize("path", ["/agents/overview", "/agents/engines",
                                  "/agents/projects", "/agents/defs", "/agents/runs",
                                  "/agents/approvals", "/agents/tasks"])
async def test_disabled_returns_404(disabled_app: FastAPI, path: str):
    async with _client(disabled_app) as c:
        r = await c.get(path, headers={"Origin": ORIGIN})
    assert r.status_code == 404
    assert r.json() == {"detail": "agents harness disabled"}


async def test_disabled_bootstrap_returns_404(disabled_app: FastAPI):
    async with _client(disabled_app) as c:
        r = await c.post("/agents/bootstrap", headers={"Origin": ORIGIN})
    assert r.status_code == 404
    assert r.json() == {"detail": "agents harness disabled"}


async def test_disabled_post_404_even_with_token(disabled_app: FastAPI):
    async with _client(disabled_app) as c:
        r = await c.post("/agents/projects", json={"name": "x", "path": "/"},
                         headers={TOKEN_HEADER: "whatever"})
    assert r.status_code == 404


async def test_missing_and_wrong_token_401(app: FastAPI):
    async with _client(app) as c:
        assert (await c.get("/agents/engines")).status_code == 401
        assert (await c.get("/agents/engines", headers={TOKEN_HEADER: "nope"})).status_code == 401
        assert (await c.get("/agents/engines", headers={TOKEN_HEADER: ""})).status_code == 401


async def test_valid_token_ok_and_bad_origin_403(app: FastAPI, svc: AgentHarnessService):
    h = {TOKEN_HEADER: svc.token}
    async with _client(app) as c:
        r = await c.get("/agents/engines", headers=h)
        assert r.status_code == 200
        names = {e["name"] for e in r.json()["engines"]}
        assert {"fake", "fake2"} <= names
        # no Origin header (non-browser client) is fine; an allowed Origin is fine
        assert (await c.get("/agents/engines", headers={**h, "Origin": ORIGIN})).status_code == 200
        # a disallowed Origin is rejected even with the right token
        r = await c.get("/agents/engines", headers={**h, "Origin": "https://evil.example"})
        assert r.status_code == 403
        # ... and wins over a missing token
        r = await c.get("/agents/engines", headers={"Origin": "https://evil.example"})
        assert r.status_code == 403


async def test_token_is_persisted_and_stable(svc: AgentHarnessService, store):
    assert svc.token and len(svc.token) >= 32
    assert await store.get_kv("agents.token") == svc.token
    assert await svc.ensure_token() == svc.token


# -- bootstrap ---------------------------------------------------------------


async def test_bootstrap_ok(app: FastAPI, svc: AgentHarnessService):
    async with _client(app) as c:
        r = await c.post("/agents/bootstrap", headers={"Origin": ORIGIN})
        assert r.status_code == 200
        assert r.json() == {"token": svc.token}
        assert r.headers["cache-control"] == "no-store"
        # tauri origin and the localhost host name also pass
        r = await c.post("/agents/bootstrap", headers={"Origin": "tauri://localhost", "Host": "localhost:8000"})
        assert r.status_code == 200
        # the handed-out token opens the guarded routes
        h = {TOKEN_HEADER: r.json()["token"]}
        assert (await c.get("/agents/overview", headers=h)).status_code == 200


async def test_bootstrap_ipv6_loopback_client_ok(app: FastAPI):
    async with _client(app, host="::1") as c:
        r = await c.post("/agents/bootstrap", headers={"Origin": ORIGIN})
    assert r.status_code == 200


async def test_bootstrap_non_loopback_client_403(app: FastAPI):
    async with _client(app, host="192.168.1.20") as c:
        r = await c.post("/agents/bootstrap", headers={"Origin": ORIGIN})
    assert r.status_code == 403
    assert "token" not in r.text


@pytest.mark.parametrize("header", ["X-Forwarded-For", "X-Real-IP", "Forwarded",
                                    "CF-Connecting-IP", "X-Forwarded-Host"])
async def test_bootstrap_forwarding_headers_403(app: FastAPI, header: str):
    async with _client(app) as c:
        r = await c.post("/agents/bootstrap", headers={"Origin": ORIGIN, header: "1.2.3.4"})
    assert r.status_code == 403


@pytest.mark.parametrize("host", ["evil.example", "192.168.1.5:8000", "127.0.0.1.evil.example"])
async def test_bootstrap_bad_host_403(app: FastAPI, host: str):
    async with _client(app) as c:
        r = await c.post("/agents/bootstrap", headers={"Origin": ORIGIN, "Host": host})
    assert r.status_code == 403


async def test_bootstrap_missing_origin_403(app: FastAPI):
    async with _client(app) as c:
        r = await c.post("/agents/bootstrap")
    assert r.status_code == 403


async def test_bootstrap_foreign_origin_403(app: FastAPI):
    async with _client(app) as c:
        for origin in ("https://evil.example", "null", "http://127.0.0.1:9999"):
            r = await c.post("/agents/bootstrap", headers={"Origin": origin})
            assert r.status_code == 403, origin
            assert "token" not in r.text


async def test_bootstrap_get_is_405(app: FastAPI, svc: AgentHarnessService):
    """GET must not hand out the token (probe-able from <img>/<link>)."""
    async with _client(app) as c:
        for headers in ({"Origin": ORIGIN}, {}):
            r = await c.get("/agents/bootstrap", headers=headers)
            assert r.status_code == 405
            assert svc.token not in r.text


# -- Cache-Control: no-store on every harness response -----------------------


async def test_guarded_get_and_post_are_no_store(app: FastAPI, svc: AgentHarnessService, project_dir):
    h = {TOKEN_HEADER: svc.token}
    async with _client(app) as c:
        for path in ("/agents/overview", "/agents/projects", "/agents/defs", "/agents/approvals"):
            r = await c.get(path, headers=h)
            assert r.status_code == 200 and r.headers["cache-control"] == "no-store", path
        r = await c.post("/agents/projects", headers=h,
                         json={"name": "P", "path": str(project_dir)})
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"


async def test_ndjson_streams_keep_no_store(app: FastAPI, svc: AgentHarnessService, project_dir):
    from seraphine.agents.routes import _stream

    async def _none():
        return
        yield  # pragma: no cover

    assert _stream(_none()).headers["cache-control"] == "no-store"
    # the finished-run stream, over HTTP (the global one never ends)
    h = {TOKEN_HEADER: svc.token}
    async with _client(app) as c:
        agent, project = await setup_agent(svc, project_dir)
        run = await svc.start_run(agent["id"], project["id"], "x")
        await wait_run(svc, run["id"], ("done", "failed"))
        r = await c.get(f"/agents/runs/{run['id']}/stream", headers=h)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        assert r.headers["content-type"].startswith("application/x-ndjson")
