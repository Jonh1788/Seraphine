"""Regression tests for the per-chat / per-manager race fixes.

These exercise the locking added in:
- whatsapp/task_detector.py (_buffers/_timers per chat_id)
- background_tasks/runner.py (MAX_CONCURRENT gate vs DB insert)

They use ``asyncio.gather`` to fan out concurrent calls and assert that
state stays consistent.
"""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any

import pytest

from seraphine.background_tasks.runner import BackgroundTaskManager
from seraphine.whatsapp.task_detector import WhatsAppTaskDetector


# ── WhatsApp task detector ─────────────────────────────────────────


class _StubAppState:
    def __init__(self) -> None:
        self.store = None
        self.ws_clients: set = set()


@pytest.mark.asyncio
async def test_concurrent_messages_same_chat_do_not_lose_buffer() -> None:
    """Hammer on_message for the same chat from N coroutines and assert
    every message was buffered (no lost append) and exactly one timer
    is alive at the end."""
    detector = WhatsAppTaskDetector(
        app_state=_StubAppState(),
        whatsapp_client=None,
        llm_client=None,
    )

    chat_id = "557399999999@c.us"

    async def fire(i: int) -> None:
        await detector.on_message(
            chat_id=chat_id,
            chat_name="Test",
            author="557399999999",
            body=f"please buy item #{i} for me",
            message_id=f"msg-{i}",
            timestamp=1700000000.0 + i,
            from_me=False,
        )

    await asyncio.gather(*[fire(i) for i in range(50)])

    assert len(detector._buffers[chat_id]) == 50
    assert chat_id in detector._timers
    assert not detector._timers[chat_id].done()

    # Cleanup: cancel timer so the loop doesn't leak it.
    detector._timers[chat_id].cancel()
    try:
        await detector._timers[chat_id]
    except (asyncio.CancelledError, BaseException):
        pass


# ── Background task manager ────────────────────────────────────────


class _ConnCtx:
    """Context-manager wrapper around a shared sqlite3.Connection."""

    def __init__(self, conn: sqlite3.Connection, lock: asyncio.Lock | None = None) -> None:
        self._conn = conn

    def __enter__(self) -> sqlite3.Connection:
        return self._conn

    def __exit__(self, *_exc: Any) -> None:
        # Don't close — the parent _FakeStore owns the connection.
        return None


class _FakeStore:
    """Tiny in-memory sqlite that satisfies BackgroundTaskManager."""

    def __init__(self) -> None:
        # check_same_thread=False so to_thread workers can use it.
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE background_tasks ("
            " id TEXT PRIMARY KEY, goal TEXT, status TEXT,"
            " started_at TEXT, finished_at TEXT, max_duration_min INTEGER,"
            " progress TEXT, iterations INTEGER, result TEXT)"
        )
        self._conn.commit()

    def _connect(self) -> _ConnCtx:
        return _ConnCtx(self._conn)


class _NoopLLM:
    """Hangs forever inside chat() so the spawned task occupies its
    slot for the duration of the test — otherwise tasks complete
    immediately and free their slot, masking the race."""

    async def chat(self, *_args: Any, **_kw: Any):  # type: ignore[no-untyped-def]
        await asyncio.sleep(3600)
        if False:
            yield None  # pragma: no cover


class _NoopRegistry:
    def list(self) -> list[Any]:
        return []


@pytest.mark.asyncio
async def test_concurrent_start_respects_max_concurrent() -> None:
    """Ten coroutines call start() at once. Only MAX_CONCURRENT (3)
    should succeed; the rest must raise. Without the lock, the gate
    check + register sequence is not atomic and more than 3 can pass."""
    mgr = BackgroundTaskManager(
        store=_FakeStore(), llm=_NoopLLM(), tool_registry=_NoopRegistry(),
    )

    async def fire() -> str | None:
        try:
            return await mgr.start(goal="dummy", max_duration_min=1)
        except RuntimeError:
            return None

    results = await asyncio.gather(*[fire() for _ in range(10)])
    started = [r for r in results if r is not None]
    assert len(started) == BackgroundTaskManager.MAX_CONCURRENT

    # Cancel everything we started so the loop doesn't trail tasks.
    for tid in started:
        await mgr.cancel(tid)
    for t in list(mgr._running.values()):
        t.cancel()
        try:
            await t
        except BaseException:
            pass
