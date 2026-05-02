"""PushService fan-out: web push + WhatsApp in parallel.

These tests exercise the dispatcher's _deliver_reminder hook directly,
mocking both the push channel (_dispatch_push) and the WhatsApp service
shim, so we can verify channel orthogonality without needing a real
SQLite store, real Evolution, or real VAPID keys.
"""
from __future__ import annotations

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock


def _build_push() -> "PushService":
    from aura.push.service import PushService
    return PushService(
        store=MagicMock(),
        tasks=MagicMock(),
        vapid_subject="mailto:test@example.com",
        vapid_private_pem=None,
        vapid_public_b64=None,
    )


def _task(**kw) -> SimpleNamespace:
    defaults = dict(
        id="42", user_id="u1", title="Dentista",
        due_time="14:00", due_date="2026-05-02",
    )
    defaults.update(kw)
    return SimpleNamespace(**defaults)


@pytest.mark.asyncio
async def test_dispatcher_calls_both_channels_for_verified_user():
    push = _build_push()
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(return_value=True)
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(return_value=1)
    task = _task()
    sent = await push._deliver_reminder("u1", task)

    push._dispatch_push.assert_awaited_once()
    wa.send_reminder.assert_awaited_once_with(
        user_id="u1", task_id="42", title="Dentista", due_time="14:00",
    )
    # Both channels reported success → 2.
    assert sent == 2


@pytest.mark.asyncio
async def test_dispatcher_skips_wa_when_unverified():
    push = _build_push()
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=False)
    wa.send_reminder = AsyncMock()
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(return_value=1)
    sent = await push._deliver_reminder("u1", _task(id="43", due_time=None))

    push._dispatch_push.assert_awaited_once()
    wa.send_reminder.assert_not_called()
    assert sent == 1


@pytest.mark.asyncio
async def test_dispatcher_skips_wa_when_not_attached():
    """Boot-time: WA not configured → push only, no AttributeError."""
    push = _build_push()
    push._dispatch_push = AsyncMock(return_value=1)
    sent = await push._deliver_reminder("u1", _task())
    push._dispatch_push.assert_awaited_once()
    assert sent == 1


@pytest.mark.asyncio
async def test_dispatcher_swallows_wa_failures_does_not_block_push():
    push = _build_push()
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(side_effect=RuntimeError("evolution down"))
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(return_value=1)
    sent = await push._deliver_reminder("u1", _task(id="44", due_time=None))

    # Push still fired (1 channel succeeded).
    assert sent == 1


@pytest.mark.asyncio
async def test_dispatcher_swallows_push_failures_does_not_block_wa():
    push = _build_push()
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(return_value=True)
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(side_effect=RuntimeError("vapid signing died"))
    sent = await push._deliver_reminder("u1", _task(id="45"))

    wa.send_reminder.assert_awaited_once()
    # WA still fired (1 channel succeeded), push errored.
    assert sent == 1


@pytest.mark.asyncio
async def test_dispatcher_zero_when_both_fail():
    push = _build_push()
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(side_effect=RuntimeError("evolution down"))
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(side_effect=RuntimeError("vapid signing died"))
    sent = await push._deliver_reminder("u1", _task(id="46"))
    assert sent == 0


import logging


@pytest.mark.asyncio
async def test_dispatcher_logs_channel_label_on_failure(caplog):
    push = _build_push()
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(side_effect=RuntimeError("evolution down"))
    push.attach_whatsapp(wa)
    push._dispatch_push = AsyncMock(return_value=1)

    caplog.set_level(logging.WARNING)
    await push._deliver_reminder("u1", _task(id="50"))

    relevant = [r for r in caplog.records if "reminder channel" in r.getMessage()]
    assert any("whatsapp" in r.getMessage() for r in relevant), (
        "WA failure must be logged with the 'whatsapp' label"
    )
