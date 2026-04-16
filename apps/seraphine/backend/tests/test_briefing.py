"""Tests for the daily briefing generator (011-D)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from seraphine.conversation.briefing import generate_briefing


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@dataclass
class FakeTask:
    id: int
    title: str
    status: str = "pending"
    due_date: str | None = None
    due_time: str | None = None


@dataclass
class FakeEntry:
    id: int
    description: str
    status: str = "pending_review"


@dataclass
class FakeFact:
    text: str


class FakeTaskService:
    def __init__(self, tasks: list[FakeTask] | None = None) -> None:
        self._tasks = tasks or []

    async def list_tasks(self, **kwargs: Any) -> list[FakeTask]:
        status = kwargs.get("status")
        if status:
            return [t for t in self._tasks if t.status == status]
        return self._tasks


class FakeFinanceService:
    def __init__(self, entries: list[FakeEntry] | None = None) -> None:
        self._entries = entries or []

    async def list_entries(self, **kwargs: Any) -> list[FakeEntry]:
        status = kwargs.get("status")
        if status:
            return [e for e in self._entries if e.status == status]
        return self._entries


class FakeGoogleClient:
    def __init__(self, events: list[dict] | None = None) -> None:
        self._events = events or []

    async def list_events(self, **kwargs: Any) -> list[dict]:
        return self._events


class FakeStore:
    def __init__(self, facts: list[FakeFact] | None = None) -> None:
        self._facts = facts or []

    async def list_facts(self, limit: int = 10) -> list[FakeFact]:
        return self._facts[:limit]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def _today() -> str:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/Sao_Paulo")).strftime("%Y-%m-%d")


@pytest.mark.asyncio
async def test_no_tasks():
    """With no tasks, the briefing says 'Dia livre'."""
    svc = FakeTaskService(tasks=[])
    result = await generate_briefing(task_service=svc)
    assert "Nenhuma tarefa" in result or "Dia livre" in result


@pytest.mark.asyncio
async def test_pending_tasks_listed():
    """Three pending tasks for today are listed."""
    today = _today()
    tasks = [
        FakeTask(id=1, title="Comprar leite", due_date=today),
        FakeTask(id=2, title="Reuniao com cliente", due_date=today, due_time="14:00"),
        FakeTask(id=3, title="Enviar relatorio", due_date=today),
    ]
    svc = FakeTaskService(tasks=tasks)
    result = await generate_briefing(task_service=svc)
    assert "Comprar leite" in result
    assert "Reuniao com cliente" in result
    assert "Enviar relatorio" in result
    assert "Tarefas de hoje (3)" in result


@pytest.mark.asyncio
async def test_overdue_tasks_warned():
    """Two overdue tasks are warned about."""
    tasks = [
        FakeTask(id=1, title="Pagar conta", due_date="2020-01-01"),
        FakeTask(id=2, title="Entregar projeto", due_date="2020-06-15"),
    ]
    svc = FakeTaskService(tasks=tasks)
    result = await generate_briefing(task_service=svc)
    assert "Atrasadas (2)" in result
    assert "Pagar conta" in result
    assert "Entregar projeto" in result


@pytest.mark.asyncio
async def test_finance_pending():
    """Finance pending entries are mentioned with count."""
    entries = [
        FakeEntry(id=1, description="Nubank"),
        FakeEntry(id=2, description="Itau"),
        FakeEntry(id=3, description="PIX recebido"),
    ]
    fin = FakeFinanceService(entries=entries)
    result = await generate_briefing(finance_service=fin)
    assert "3 lancamento(s) pendente(s)" in result


@pytest.mark.asyncio
async def test_greeting_changes_by_time():
    """Greeting varies by hour of day."""
    from unittest.mock import patch
    from datetime import datetime as dt
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("America/Sao_Paulo")

    # Morning
    with patch(
        "seraphine.conversation.briefing.datetime",
    ) as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: dt(2026, 4, 15, 9, 0, 0, tzinfo=tz or timezone.utc)
        mock_dt.side_effect = lambda *a, **k: dt(*a, **k)
        result = await generate_briefing()
        assert "Bom dia" in result

    # Evening
    with patch(
        "seraphine.conversation.briefing.datetime",
    ) as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: dt(2026, 4, 15, 20, 0, 0, tzinfo=tz or timezone.utc)
        mock_dt.side_effect = lambda *a, **k: dt(*a, **k)
        result = await generate_briefing()
        assert "Boa noite" in result


@pytest.mark.asyncio
async def test_calendar_events():
    """Google calendar events are listed."""
    events = [
        {
            "summary": "Standup",
            "start": {"dateTime": "2026-04-15T09:00:00-03:00"},
        },
        {
            "summary": "Almoco",
            "start": {"date": "2026-04-15"},
        },
    ]
    gc = FakeGoogleClient(events=events)
    result = await generate_briefing(google_client=gc)
    assert "Standup" in result
    assert "09:00" in result
    assert "Almoco" in result
    assert "dia inteiro" in result


@pytest.mark.asyncio
async def test_all_services_none():
    """Briefing with no services still returns a greeting."""
    result = await generate_briefing()
    assert "resumo de hoje" in result


@pytest.mark.asyncio
async def test_emotional_context():
    """Emotional keywords from memory facts appear as context."""
    store = FakeStore(facts=[
        FakeFact(text="O usuario se sente estressado com prazos"),
    ])
    result = await generate_briefing(store=store)
    assert "estressado" in result
    assert "Contexto" in result
