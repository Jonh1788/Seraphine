import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from seraphine.email_urgency import schema
from seraphine.email_urgency.service import EmailUrgencyService

SP = ZoneInfo("America/Sao_Paulo")


class FakeStore:
    """Minimal MemoryStore stand-in: shares one in-memory sqlite conn."""

    def __init__(self):
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        schema.migrate(self._conn)

    def _connect(self):
        store = self

        class _Ctx:
            def __enter__(self_):
                return store._conn

            def __exit__(self_, *a):
                store._conn.commit()
                return False

        return _Ctx()


class FakeGoogle:
    def __init__(self, messages, authed=True):
        self._messages = messages
        self._authed = authed

    async def is_authed(self):
        return self._authed

    async def list_messages(self, q=None, max_results=25):
        return self._messages


class FakeLLM:
    def __init__(self, by_subject):
        self._by_subject = by_subject  # subject -> urgency

    async def tool_call_json(self, *, system, user, tool, cache_system=False, max_tokens=1024, model=None):
        for subj, urg in self._by_subject.items():
            if subj in user:
                return {"urgency": urg, "reason": f"motivo: {urg}"}
        return {"urgency": "low", "reason": "default"}


class FakeWhatsApp:
    def __init__(self, fail=False):
        self.sent = []
        self._fail = fail

    async def send_message(self, chat_id, message, quote_msg_id=None):
        if self._fail:
            raise RuntimeError("bridge down")
        self.sent.append((chat_id, message))
        return {"ok": True}


def _msg(mid, subject, sender="Banco Inter <no@inter.com>"):
    return {"id": mid, "from": sender, "subject": subject, "snippet": "trecho"}


def _svc(store, google, llm, wa, **kw):
    defaults = dict(
        store=store, google_client=google, llm=llm, whatsapp_client=wa,
        owner_chat_id="557388836445@c.us", public_url="https://sera.jonhdev.io",
        quiet_start="22:00", quiet_end="07:00",
    )
    defaults.update(kw)
    return EmailUrgencyService(**defaults)


@pytest.mark.asyncio
async def test_high_pushes_whatsapp_with_deeplink_and_records_alerted(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    # Force a non-quiet time (12:00 SP).
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 1
    assert len(wa.sent) == 1
    chat_id, body = wa.sent[0]
    assert chat_id == "557388836445@c.us"
    assert "https://sera.jonhdev.io/?inbox=m1" in body
    row = store._conn.execute("SELECT urgency, alerted FROM email_urgency_seen WHERE message_id='m1'").fetchone()
    assert row == ("high", 1)


@pytest.mark.asyncio
async def test_medium_and_low_record_but_do_not_push(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Promo"), _msg("m2", "Reuniao")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Promo": "low", "Reuniao": "medium"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 0
    assert wa.sent == []
    seen = store._conn.execute("SELECT message_id FROM email_urgency_seen ORDER BY message_id").fetchall()
    assert seen == [("m1",), ("m2",)]


@pytest.mark.asyncio
async def test_already_seen_is_skipped(monkeypatch):
    store = FakeStore()
    store._conn.execute(
        "INSERT INTO email_urgency_seen(message_id, urgency, reason, alerted, created_at)"
        " VALUES ('m1','high','x',1,'t')"
    )
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 0
    assert wa.sent == []  # no re-push for a message already recorded


@pytest.mark.asyncio
async def test_quiet_hours_skips_scan(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 23, 30, tzinfo=SP))  # in 22:00-07:00
    pushed = await svc.scan()
    assert pushed == 0
    assert wa.sent == []
    assert store._conn.execute("SELECT COUNT(*) FROM email_urgency_seen").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_not_authed_returns_zero(monkeypatch):
    store = FakeStore()
    svc = _svc(store, FakeGoogle([], authed=False), FakeLLM({}), FakeWhatsApp())
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    assert await svc.scan() == 0


@pytest.mark.asyncio
async def test_no_whatsapp_or_no_owner_records_without_crash(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    # whatsapp_client None
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), None)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    assert await svc.scan() == 0
    assert store._conn.execute("SELECT alerted FROM email_urgency_seen WHERE message_id='m1'").fetchone() == (0,)


@pytest.mark.asyncio
async def test_whatsapp_send_failure_records_not_alerted(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp(fail=True)
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 0  # send raised → not counted
    assert store._conn.execute("SELECT alerted FROM email_urgency_seen WHERE message_id='m1'").fetchone() == (0,)


def test_quiet_hours_wraps_midnight():
    store = FakeStore()
    svc = _svc(store, FakeGoogle([]), FakeLLM({}), FakeWhatsApp(), quiet_start="22:00", quiet_end="07:00")
    assert svc._in_quiet_hours(datetime(2026, 6, 21, 23, 0, tzinfo=SP)) is True
    assert svc._in_quiet_hours(datetime(2026, 6, 21, 3, 0, tzinfo=SP)) is True
    assert svc._in_quiet_hours(datetime(2026, 6, 21, 12, 0, tzinfo=SP)) is False
    # disabled when equal/empty
    svc2 = _svc(store, FakeGoogle([]), FakeLLM({}), FakeWhatsApp(), quiet_start="", quiet_end="")
    assert svc2._in_quiet_hours(datetime(2026, 6, 21, 23, 0, tzinfo=SP)) is False
