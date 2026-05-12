import asyncio
import sqlite3

import pytest

from aura.alexa.schema import migrate
from aura.alexa.service import AlexaService


class FakeRunner:
    """Stand-in for _run_agentic_collect."""

    def __init__(self, reply: str = "ok", delay: float = 0.0, raises: Exception | None = None):
        self.reply = reply
        self.delay = delay
        self.raises = raises
        self.calls: list[dict] = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.raises:
            raise self.raises
        return {"reply": self.reply}


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.executescript(
        "CREATE TABLE users (id TEXT PRIMARY KEY);"
        "INSERT INTO users (id) VALUES ('u1');"
        "CREATE TABLE aura_chat_conversations (id TEXT PRIMARY KEY, user_id TEXT, metadata TEXT, created_at TEXT);"
    )
    migrate(c)
    return c


async def test_process_query_routes_through_runner(conn):
    runner = FakeRunner(reply="Sua agenda está vazia.")
    svc = AlexaService(conn=conn, run_agentic=runner, timeout_seconds=7.0)
    reply = await svc.process_query(user_id="u1", session_id="s1", query_text="qual minha agenda")
    assert reply == "Sua agenda está vazia."
    assert len(runner.calls) == 1
    assert runner.calls[0]["uid"] == "u1"
    assert runner.calls[0]["user_text"] == "qual minha agenda"


async def test_same_session_reuses_conversation(conn):
    runner = FakeRunner()
    svc = AlexaService(conn=conn, run_agentic=runner, timeout_seconds=7.0)
    await svc.process_query(user_id="u1", session_id="s1", query_text="oi")
    await svc.process_query(user_id="u1", session_id="s1", query_text="tchau")
    cid_first = runner.calls[0]["conversation_id"]
    cid_second = runner.calls[1]["conversation_id"]
    assert cid_first == cid_second


async def test_different_sessions_get_different_conversations(conn):
    runner = FakeRunner()
    svc = AlexaService(conn=conn, run_agentic=runner, timeout_seconds=7.0)
    await svc.process_query(user_id="u1", session_id="s1", query_text="oi")
    await svc.process_query(user_id="u1", session_id="s2", query_text="oi")
    assert runner.calls[0]["conversation_id"] != runner.calls[1]["conversation_id"]


async def test_timeout_yields_friendly_message(conn):
    runner = FakeRunner(delay=0.5)
    svc = AlexaService(conn=conn, run_agentic=runner, timeout_seconds=0.1)
    reply = await svc.process_query(user_id="u1", session_id="s1", query_text="oi")
    assert "demorei" in reply.lower()


async def test_runner_exception_yields_friendly_message(conn):
    runner = FakeRunner(raises=RuntimeError("boom"))
    svc = AlexaService(conn=conn, run_agentic=runner, timeout_seconds=7.0)
    reply = await svc.process_query(user_id="u1", session_id="s1", query_text="oi")
    assert "deu errado" in reply.lower()


async def test_status_returns_link_state(conn):
    svc = AlexaService(conn=conn, run_agentic=FakeRunner(), timeout_seconds=7.0)
    assert svc.get_status("u1") == {"linked": False, "amazon_email_masked": None}
    conn.execute(
        "INSERT INTO aura_user_alexa (user_id, amazon_user_id, linked_at, created_at, updated_at)"
        " VALUES ('u1', 'amzn1.account.A', 't', 't', 't')"
    )
    conn.commit()
    s = svc.get_status("u1")
    assert s["linked"] is True


async def test_disconnect_removes_link_and_revokes_tokens(conn):
    svc = AlexaService(conn=conn, run_agentic=FakeRunner(), timeout_seconds=7.0)
    conn.execute(
        "INSERT INTO aura_user_alexa (user_id, amazon_user_id, linked_at, created_at, updated_at)"
        " VALUES ('u1', 'amzn1.account.A', 't', 't', 't')"
    )
    conn.execute(
        "INSERT INTO aura_alexa_tokens"
        " (refresh_token, access_token, user_id, access_expires_at, created_at)"
        " VALUES ('r1', 'a1', 'u1', '9999-01-01T00:00:00Z', 't')"
    )
    conn.commit()
    svc.disconnect("u1")
    assert conn.execute("SELECT COUNT(*) FROM aura_user_alexa WHERE user_id='u1'").fetchone()[0] == 0
    revoked = conn.execute(
        "SELECT revoked_at FROM aura_alexa_tokens WHERE refresh_token='r1'"
    ).fetchone()[0]
    assert revoked is not None
