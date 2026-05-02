import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

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
