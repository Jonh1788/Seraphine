"""``WS /agents/ws``: handshake rules, auth frame, live frames, ping, cleanup.

Sync tests on purpose: Starlette's ``TestClient`` runs the app on its own event
loop (``client.portal``), and the service must live on that same loop.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Iterator

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from seraphine.agents import routes
from seraphine.agents import schema as agents_schema
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.service import AgentHarnessService
from seraphine.memory.store import MemoryStore

from .conftest import ORIGIN, make_settings

TOKEN_FRAME = '{"type":"auth","token":"%s"}'


class Env:
    def __init__(self, client: TestClient, svc: AgentHarnessService, tmp: Path) -> None:
        self.client, self.svc, self.tmp = client, svc, tmp

    def run(self, fn, *a, **kw):
        async def _call():
            return await fn(*a, **kw)
        return self.client.portal.call(_call)

    def auth(self, ws) -> None:
        ws.send_text(TOKEN_FRAME % self.svc.token)

    def subs(self) -> int:
        return len(self.svc._global_subs)

    def wait_subs(self, n: int, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.subs() == n:
                return
            time.sleep(0.02)
        raise AssertionError(f"_global_subs size {self.subs()} != {n}")


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        async def build():
            store = MemoryStore(tmp_path / "agents.sqlite")
            store.register_migrator("seraphine_agents", agents_schema.migrate)
            await store.ensure_schema()
            svc = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()},
                                      heartbeat_s=0.2)
            await svc.start()
            return store, svc

        store, svc = client.portal.call(build)
        app.state.agent_harness = svc

        async def teardown():
            await svc.stop()
            await store.aclose()

        try:
            yield Env(client, svc, tmp_path)
        finally:
            client.portal.call(teardown)


def _expect_close(ws, code: int) -> None:
    with pytest.raises(WebSocketDisconnect) as ei:
        ws.receive_text()
    assert ei.value.code == code


def test_disabled_closes_4404() -> None:
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client, client.websocket_connect("/agents/ws") as ws:
        _expect_close(ws, 4404)


def test_bad_origin_closes_4403(env: Env) -> None:
    with env.client.websocket_connect("/agents/ws", headers={"origin": "http://evil.example"}) as ws:
        _expect_close(ws, 4403)
    assert env.subs() == 0


def test_no_auth_within_timeout_closes_4401(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(routes, "WS_AUTH_TIMEOUT_S", 0.2)
    with env.client.websocket_connect("/agents/ws", headers={"origin": ORIGIN}) as ws:
        _expect_close(ws, 4401)


@pytest.mark.parametrize("frame", [
    '{"type":"auth","token":"nope"}',
    '{"type":"auth"}',
    '{"type":"auth","token":123}',
    '{"type":"ping"}',
    'not json',
])
def test_bad_first_frame_closes_4401(env: Env, frame: str) -> None:
    with env.client.websocket_connect("/agents/ws") as ws:
        ws.send_text(frame)
        _expect_close(ws, 4401)
    assert env.subs() == 0


def test_token_in_query_string_is_ignored(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(routes, "WS_AUTH_TIMEOUT_S", 0.2)
    with env.client.websocket_connect(f"/agents/ws?token={env.svc.token}") as ws:
        _expect_close(ws, 4401)


def test_ready_then_run_events_arrive_as_frames(env: Env) -> None:
    project_dir = env.tmp / "proj"
    project_dir.mkdir()

    async def setup():
        project = await env.svc.create_project(name="P", path=str(project_dir))
        agent = await env.svc.create_def(name="Dev", role="dev", engine="fake",
                                         project_ids=[project["id"]])
        return agent, project

    agent, project = env.run(setup)
    with env.client.websocket_connect("/agents/ws", headers={"origin": ORIGIN}) as ws:
        env.auth(ws)
        assert ws.receive_json()["type"] == "ready"
        env.wait_subs(1)
        run = env.run(env.svc.start_run, agent["id"], project["id"], "faça algo")
        seen = []
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            frame = ws.receive_json()
            if frame["type"] == "event" and frame["run_id"] == run["id"]:
                seen.append(frame)
                if frame["kind"] == "status" and frame["payload"].get("status") == "done":
                    break
        assert seen and all(isinstance(f["id"], int) for f in seen)
        assert seen[-1]["payload"]["status"] == "done"


def test_heartbeat_frames_and_ping_pong(env: Env) -> None:
    with env.client.websocket_connect("/agents/ws") as ws:
        env.auth(ws)
        assert ws.receive_json()["type"] == "ready"
        ws.send_text("garbage")  # ignored, does not kill the socket
        ws.send_text('{"type":"something-else"}')
        ws.send_text('{"type":"ping"}')
        types = []
        for _ in range(5):
            types.append(ws.receive_json()["type"])
            if "pong" in types:
                break
        assert "pong" in types
        # idle: the next frames are heartbeats (heartbeat_s = 0.2)
        assert ws.receive_json()["type"] in ("heartbeat", "pong")


def test_subscriber_removed_after_clean_close(env: Env) -> None:
    before = env.subs()
    with env.client.websocket_connect("/agents/ws") as ws:
        env.auth(ws)
        assert ws.receive_json()["type"] == "ready"
        env.wait_subs(before + 1)
        ws.close(1000)
    env.wait_subs(before)


def test_subscriber_removed_after_abrupt_disconnect(env: Env) -> None:
    """Peer vanishes (1006, no closing handshake) while the server is mid-send."""
    before = env.subs()
    with env.client.websocket_connect("/agents/ws") as ws:
        env.auth(ws)
        assert ws.receive_json()["type"] == "ready"
        env.wait_subs(before + 1)
        ws.close(1006)
    env.wait_subs(before)


def test_two_sockets_are_independent(env: Env) -> None:
    with env.client.websocket_connect("/agents/ws") as a:
        env.auth(a)
        a.receive_json()
        with env.client.websocket_connect("/agents/ws") as b:
            env.auth(b)
            b.receive_json()
            env.wait_subs(2)
            b.close(1000)
            env.wait_subs(1)
        time.sleep(0.1)  # let the handler finish before the client tears down
        a.close(1000)
        env.wait_subs(0)
