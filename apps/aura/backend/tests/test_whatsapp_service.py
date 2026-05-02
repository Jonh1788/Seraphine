import sqlite3
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from aura.whatsapp.client import EvolutionError
from aura.whatsapp.schema import migrate
from aura.whatsapp.service import WhatsAppService


class _FakeStore:
    def __init__(self) -> None:
        # ``check_same_thread=False`` because the service funnels SQLite
        # work through ``asyncio.to_thread``; the fake keeps a single
        # in-memory connection shared across threads.
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.row_factory = None
        migrate(self._conn)

    def _connect(self) -> sqlite3.Connection:  # noqa: D401
        return self._conn


class _FakeClient:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.fail_next = False

    async def send_text(self, phone: str, text: str) -> str:
        if self.fail_next:
            self.fail_next = False
            raise EvolutionError(status_code=502, body="x", reason="boom")
        self.sent.append((phone, text))
        return "MSG1"


@pytest.fixture
def svc():
    store = _FakeStore()
    client = _FakeClient()
    return WhatsAppService(
        store=store,
        client=client,
        code_factory=lambda: "482910",
        now=lambda: datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc),
    )


@pytest.mark.asyncio
async def test_start_verification_persists_code_and_sends_message(svc):
    await svc.start_verification("u1", "+55 11 98765-4321")
    rows = svc._store._connect().execute(
        "SELECT user_id, phone_e164, code, attempts FROM aura_whatsapp_verification"
    ).fetchall()
    assert rows == [("u1", "+5511987654321", "482910", 0)]
    assert svc._client.sent == [(
        "+5511987654321",
        "Aura: seu código de verificação é 482910 (válido por 5 min).",
    )]


@pytest.mark.asyncio
async def test_start_verification_replaces_existing_code(svc):
    await svc.start_verification("u1", "+5511987654321")
    # cooldown bypassed: advance "now" past the 60s throttle window
    base = svc._now()
    svc._now = lambda: base + timedelta(seconds=61)
    await svc.start_verification("u1", "+5511987654321")
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification"
    ).fetchone()
    assert rows == (1,)


@pytest.mark.asyncio
async def test_start_verification_rejects_invalid_phone(svc):
    from aura.whatsapp.phone import InvalidPhone
    with pytest.raises(InvalidPhone):
        await svc.start_verification("u1", "abc")


@pytest.mark.asyncio
async def test_verify_happy_path(svc):
    await svc.start_verification("u1", "+5511987654321")
    ok = await svc.verify("u1", "482910")
    assert ok is True
    bound = svc._store._connect().execute(
        "SELECT phone_e164 FROM aura_user_whatsapp WHERE user_id='u1'"
    ).fetchone()
    assert bound == ("+5511987654321",)
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_verify_wrong_code_increments_attempts(svc):
    await svc.start_verification("u1", "+5511987654321")
    ok = await svc.verify("u1", "000000")
    assert ok is False
    attempts = svc._store._connect().execute(
        "SELECT attempts FROM aura_whatsapp_verification WHERE user_id='u1'"
    ).fetchone()
    assert attempts == (1,)


@pytest.mark.asyncio
async def test_verify_after_3_attempts_drops_row(svc):
    await svc.start_verification("u1", "+5511987654321")
    for _ in range(3):
        await svc.verify("u1", "000000")
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification WHERE user_id='u1'"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_verify_after_expiry_returns_false_and_clears():
    store = _FakeStore()
    client = _FakeClient()
    now = datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc)
    svc = WhatsAppService(
        store=store, client=client,
        code_factory=lambda: "482910", now=lambda: now,
    )
    await svc.start_verification("u1", "+5511987654321")
    # advance past TTL
    svc._now = lambda: now + timedelta(minutes=10)
    ok = await svc.verify("u1", "482910")
    assert ok is False
    rows = store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_disconnect_removes_binding(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    affected = await svc.disconnect("u1")
    assert affected is True
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_user_whatsapp"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_get_status_when_unverified(svc):
    s = await svc.get_status("u1")
    assert s == {"verified": False, "phone_masked": None}


@pytest.mark.asyncio
async def test_get_status_when_verified(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    s = await svc.get_status("u1")
    assert s["verified"] is True
    assert "•" in s["phone_masked"]
    assert s["phone_masked"].endswith("21")


@pytest.mark.asyncio
async def test_is_verified(svc):
    assert await svc.is_verified("u1") is False
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    assert await svc.is_verified("u1") is True


@pytest.mark.asyncio
async def test_start_verification_throttled(svc):
    await svc.start_verification("u1", "+5511987654321")
    with pytest.raises(RuntimeError) as exc:
        await svc.start_verification("u1", "+5511987654321")
    assert "aguarde" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_start_verification_cooldown_boundary(svc):
    from datetime import timedelta
    await svc.start_verification("u1", "+5511987654321")
    base = svc._now()
    # 59s elapsed — still within cooldown.
    svc._now = lambda: base + timedelta(seconds=59)
    import pytest
    with pytest.raises(RuntimeError):
        await svc.start_verification("u1", "+5511987654321")
    # 60s elapsed — re-issuance allowed (strict less-than check).
    svc._now = lambda: base + timedelta(seconds=60)
    await svc.start_verification("u1", "+5511987654321")  # must not raise


@pytest.mark.asyncio
async def test_find_or_create_conversation_creates_on_miss(svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    cid1 = await svc.find_or_create_conversation("u1")
    cid2 = await svc.find_or_create_conversation("u1")
    assert cid1 == cid2
    row = svc._store._connect().execute(
        "SELECT json_extract(metadata, '$.channel') FROM conversations"
        " WHERE id = ?",
        (cid1,),
    ).fetchone()
    assert row == ("whatsapp",)


@pytest.mark.asyncio
async def test_route_inbound_drops_unknown_phone(svc):
    out = await svc.route_inbound({
        "phone_e164": "+5511000000000",
        "text": "oi",
        "is_group": False,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_drops_group_messages(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "+5511987654321",
        "text": "oi",
        "is_group": True,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_drops_empty_text(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "+5511987654321",
        "text": "   ",
        "is_group": False,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_returns_user_and_conversation_for_verified(svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "+5511987654321",
        "text": "lembra de comprar pão",
        "is_group": False,
    })
    assert out is not None
    assert out["user_id"] == "u1"
    assert isinstance(out["conversation_id"], str)
    assert out["text"] == "lembra de comprar pão"


@pytest.mark.asyncio
async def test_route_inbound_drops_malformed_phone(svc):
    out = await svc.route_inbound({
        "phone_e164": "not-a-phone",
        "text": "oi",
        "is_group": False,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_normalizes_phone_before_lookup(svc):
    """Webhook adapter accidentally sent the bare digits — Aura must
    still find the verified binding because route_inbound normalizes
    defensively before querying."""
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "5511987654321",  # no leading '+'
        "text": "oi",
        "is_group": False,
    })
    assert out is not None
    assert out["user_id"] == "u1"


@pytest.mark.asyncio
async def test_process_user_message_sends_reply_via_client(monkeypatch, svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())

    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    cid = await svc.find_or_create_conversation("u1")

    captured: dict = {}

    async def fake_collect(**kwargs):
        captured.update(kwargs)
        return {
            "reply": "Anotado!",
            "transactions": [],
            "tasks": [],
            "recurring": [],
            "chips": [],
            "title": None,
        }

    import aura.chat.routes as chat_routes
    monkeypatch.setattr(chat_routes, "_run_agentic_collect", fake_collect)

    fake_conv_svc = AsyncMock()
    fake_conv_svc.add_message = AsyncMock(return_value="m1")
    fake_conv_svc.get_messages_for_llm = AsyncMock(return_value=[
        {"role": "user", "content": "lembra de comprar pão"},
    ])

    svc.bind_dependencies(
        llm=MagicMock(),
        finance=AsyncMock(),
        tasks=AsyncMock(),
        recurring=AsyncMock(),
        projects=None, habits=None, knowledge=None, goals=None,
        conversations=fake_conv_svc,
    )

    await svc.process_user_message("u1", cid, "lembra de comprar pão")

    assert svc._client.sent[-1] == ("+5511987654321", "Anotado!")
    fake_conv_svc.add_message.assert_any_await(
        cid, "u1", "user", "lembra de comprar pão", metadata=None,
    )
    assert captured["uid"] == "u1"
    assert captured["conversation_id"] == cid


@pytest.mark.asyncio
async def test_process_user_message_rate_limited(monkeypatch, svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    cid = await svc.find_or_create_conversation("u1")

    async def fake_collect(**kwargs):
        return {
            "reply": "ok",
            "transactions": [], "tasks": [], "recurring": [],
            "chips": [], "title": None,
        }

    import aura.chat.routes as chat_routes
    monkeypatch.setattr(chat_routes, "_run_agentic_collect", fake_collect)

    fake_conv_svc = AsyncMock()
    fake_conv_svc.add_message = AsyncMock(return_value="m")
    fake_conv_svc.get_messages_for_llm = AsyncMock(return_value=[])

    svc.bind_dependencies(
        llm=MagicMock(), finance=AsyncMock(), tasks=AsyncMock(),
        recurring=AsyncMock(), projects=None, habits=None,
        knowledge=None, goals=None, conversations=fake_conv_svc,
    )

    # Push 30 fake recent timestamps into the limiter window.
    for _ in range(30):
        svc._mark_user_send("u1")

    await svc.process_user_message("u1", cid, "more")
    assert ("+5511987654321", "ok") not in svc._client.sent
    fake_conv_svc.add_message.assert_not_called()


@pytest.mark.asyncio
async def test_rate_limit_window_evicts_old_entries(svc):
    """A timestamp older than RATE_LIMIT_WINDOW must be evicted on the
    next _is_over_cap check, allowing fresh sends."""
    from aura.whatsapp.service import RATE_LIMIT_WINDOW
    from datetime import timedelta

    base = svc._now()
    svc._rate = {"u1": deque([base - RATE_LIMIT_WINDOW - timedelta(seconds=1)] * 30)}
    # All 30 timestamps are stale → evicted → not over cap.
    assert svc._is_over_cap("u1") is False


@pytest.mark.asyncio
async def test_process_user_message_unbound_is_silent_noop(svc, caplog):
    """If process_user_message fires before bind_dependencies (boot
    race / misconfig), the call must log and return without touching
    the client or any DB row."""
    import logging
    caplog.set_level(logging.ERROR)
    # NOTE: svc fixture does NOT call bind_dependencies — _conversations is None.
    await svc.process_user_message("u1", "c1", "oi")
    assert svc._client.sent == []
    assert any(
        "before bind_dependencies" in record.message
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_send_reminder_writes_dispatch_and_sends(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    sent = await svc.send_reminder(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    assert sent is True
    assert svc._client.sent[-1] == ("+5511987654321", "*Dentista* às 14:00")
    rows = svc._store._connect().execute(
        "SELECT task_id, user_id FROM aura_whatsapp_dispatches"
    ).fetchall()
    assert rows == [(42, "u1")]


@pytest.mark.asyncio
async def test_send_reminder_idempotent(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    await svc.send_reminder(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    sent_count_before = len(svc._client.sent)
    again = await svc.send_reminder(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    assert again is False
    assert len(svc._client.sent) == sent_count_before


@pytest.mark.asyncio
async def test_send_reminder_no_time_uses_hoje(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    await svc.send_reminder(
        user_id="u1", task_id=43, title="Pagar boleto", due_time=None,
    )
    assert svc._client.sent[-1] == ("+5511987654321", "*Pagar boleto* hoje")


@pytest.mark.asyncio
async def test_send_reminder_skips_unverified(svc):
    sent = await svc.send_reminder(
        user_id="u-nope", task_id=99, title="X", due_time=None,
    )
    assert sent is False
    assert svc._client.sent == []


@pytest.mark.asyncio
async def test_send_reminder_rolls_back_claim_on_evolution_failure(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    # Force the next send to fail.
    svc._client.fail_next = True
    sent = await svc.send_reminder(
        user_id="u1", task_id=77, title="X", due_time="09:00",
    )
    assert sent is False
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_dispatches WHERE task_id = 77"
    ).fetchone()
    assert rows == (0,)
    # Retry on the next cycle should succeed.
    again = await svc.send_reminder(
        user_id="u1", task_id=77, title="X", due_time="09:00",
    )
    assert again is True


@pytest.mark.asyncio
async def test_send_reminder_fk_violation_surfaces(svc):
    """When PRAGMA foreign_keys = ON and the user row doesn't exist,
    the dispatch INSERT must NOT be silently swallowed as 'already
    dispatched' — that would leave the dispatcher with no retry path
    and no breadcrumb. The corrected ON CONFLICT … DO NOTHING form
    only handles the PK collision, so an FK violation surfaces.
    """
    import sqlite3 as sqlite3_mod
    conn = svc._store._connect()
    # Bind the WA phone first (FKs still off in the fixture, so we can
    # populate aura_user_whatsapp without a parent users(id) row — that
    # mirrors the production scenario where the user row was deleted
    # mid-flight after the binding was created).
    await svc.start_verification("u-orphan", "+5511987654321")
    await svc.verify("u-orphan", "482910")
    # Now mirror production: enable FKs and create the parent table so
    # the dispatch INSERT must satisfy the FK to users(id).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS users ("
        " id TEXT PRIMARY KEY"
        ")"
    )
    conn.execute("PRAGMA foreign_keys = ON")
    with pytest.raises(sqlite3_mod.IntegrityError):
        await svc.send_reminder(
            user_id="u-orphan", task_id=999, title="X", due_time=None,
        )
