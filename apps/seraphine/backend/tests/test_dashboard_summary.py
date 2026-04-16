"""Tests for GET /dashboard/summary (structured dashboard endpoint)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from unittest.mock import patch

import pytest

from seraphine.conversation.briefing import generate_dashboard_summary


# ---------------------------------------------------------------------------
# Helpers — reuse patterns from test_briefing.py
# ---------------------------------------------------------------------------

@dataclass
class FakeTask:
    id: int
    title: str
    status: str = "pending"
    due_date: str | None = None
    due_time: str | None = None
    updated_at: str | None = None


class FakeTaskService:
    def __init__(self, tasks: list[FakeTask] | None = None) -> None:
        self._tasks = tasks or []

    async def list_tasks(self, **kwargs: Any) -> list[FakeTask]:
        status = kwargs.get("status")
        if status:
            return [t for t in self._tasks if t.status == status]
        return self._tasks


class FakeFinanceService:
    def __init__(
        self,
        summary: dict | None = None,
        pending_entries: list | None = None,
    ) -> None:
        self._summary = summary or {
            "income": 0.0, "expenses": 0.0, "balance": 0.0, "by_category": [],
        }
        self._pending = pending_entries or []

    async def get_monthly_summary(self, month: int, year: int, **kw: Any) -> dict:
        return self._summary

    async def list_entries(self, **kwargs: Any) -> list:
        status = kwargs.get("status")
        if status == "pending_review":
            return self._pending
        return []


class FakeGoogleClient:
    def __init__(self, events: list[dict] | None = None) -> None:
        self._events = events or []

    async def list_events(self, **kwargs: Any) -> list[dict]:
        return self._events


# ---------------------------------------------------------------------------
# Frozen "today" for deterministic tests
# ---------------------------------------------------------------------------

def _today() -> str:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/Sao_Paulo")).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_all_services_none():
    """With no services at all, every field returns zero / empty."""
    result = await generate_dashboard_summary()

    assert "Jonathan" in result["greeting"]
    assert result["date"]  # non-empty string
    assert result["tasks_today"]["total"] == 0
    assert result["tasks_today"]["completed"] == 0
    assert result["tasks_today"]["overdue"] == 0
    assert result["tasks_today"]["pending_titles"] == []
    assert result["next_events"] == []
    assert result["finance_month"]["income"] == 0.0
    assert result["finance_month"]["expenses"] == 0.0
    assert result["finance_month"]["balance"] == 0.0
    assert result["finance_month"]["pending_review"] == 0


@pytest.mark.asyncio
async def test_tasks_pending_completed_overdue():
    """Pending, completed, and overdue tasks are counted correctly."""
    today = _today()
    tasks = [
        FakeTask(id=1, title="Cobrar FP", status="pending", due_date=today),
        FakeTask(id=2, title="Comprar refrigerante", status="pending", due_date=today, due_time="16:00"),
        FakeTask(id=3, title="Reuniao", status="pending", due_date=today),
        FakeTask(id=4, title="Atrasada", status="pending", due_date="2020-01-01"),
        FakeTask(id=5, title="Feita", status="completed", due_date=today, updated_at=f"{today}T10:00:00"),
    ]
    svc = FakeTaskService(tasks=tasks)
    result = await generate_dashboard_summary(task_service=svc)

    t = result["tasks_today"]
    assert t["overdue"] == 1
    assert t["completed"] == 1
    # pending today: 3, completed today: 1, overdue: 1 => total = 5
    assert t["total"] == 5
    assert "Cobrar FP" in t["pending_titles"]
    assert "Comprar refrigerante" in t["pending_titles"]
    assert "Reuniao" in t["pending_titles"]
    assert len(t["pending_titles"]) == 3

    # Timed task appears in next_events
    timed = [e for e in result["next_events"] if e["type"] == "task"]
    assert len(timed) == 1
    assert timed[0]["title"] == "Comprar refrigerante"
    assert timed[0]["time"] == "16:00"


@pytest.mark.asyncio
async def test_finance_data():
    """Finance monthly summary and pending review count are returned."""
    fin = FakeFinanceService(
        summary={"income": 5000.0, "expenses": 3200.0, "balance": 1800.0, "by_category": []},
        pending_entries=[{"id": 1}, {"id": 2}, {"id": 3}],
    )
    result = await generate_dashboard_summary(finance_service=fin)

    f = result["finance_month"]
    assert f["income"] == 5000.0
    assert f["expenses"] == 3200.0
    assert f["balance"] == 1800.0
    assert f["pending_review"] == 3


@pytest.mark.asyncio
async def test_greeting_changes_by_time():
    """Greeting varies by hour of day."""
    from datetime import datetime as dt
    from zoneinfo import ZoneInfo

    # Morning (9h)
    with patch("seraphine.conversation.briefing.datetime") as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: dt(2026, 4, 15, 9, 0, 0, tzinfo=tz or timezone.utc)
        mock_dt.side_effect = lambda *a, **k: dt(*a, **k)
        result = await generate_dashboard_summary()
        assert result["greeting"].startswith("Bom dia")

    # Afternoon (15h)
    with patch("seraphine.conversation.briefing.datetime") as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: dt(2026, 4, 15, 15, 0, 0, tzinfo=tz or timezone.utc)
        mock_dt.side_effect = lambda *a, **k: dt(*a, **k)
        result = await generate_dashboard_summary()
        assert result["greeting"].startswith("Boa tarde")

    # Night (21h)
    with patch("seraphine.conversation.briefing.datetime") as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: dt(2026, 4, 15, 21, 0, 0, tzinfo=tz or timezone.utc)
        mock_dt.side_effect = lambda *a, **k: dt(*a, **k)
        result = await generate_dashboard_summary()
        assert result["greeting"].startswith("Boa noite")

    # Early morning (3h)
    with patch("seraphine.conversation.briefing.datetime") as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: dt(2026, 4, 15, 3, 0, 0, tzinfo=tz or timezone.utc)
        mock_dt.side_effect = lambda *a, **k: dt(*a, **k)
        result = await generate_dashboard_summary()
        assert result["greeting"].startswith("Boa madrugada")


@pytest.mark.asyncio
async def test_calendar_events_merged_and_sorted():
    """Calendar events and timed tasks are merged and sorted by time."""
    today = _today()
    tasks = [
        FakeTask(id=1, title="Cobrar FP", status="pending", due_date=today, due_time="16:00"),
    ]
    events = [
        {"summary": "Reuniao", "start": {"dateTime": f"{today}T14:00:00-03:00"}},
    ]
    result = await generate_dashboard_summary(
        task_service=FakeTaskService(tasks=tasks),
        google_client=FakeGoogleClient(events=events),
    )

    ne = result["next_events"]
    assert len(ne) == 2
    # 14:00 agenda before 16:00 task
    assert ne[0]["time"] == "14:00"
    assert ne[0]["type"] == "agenda"
    assert ne[1]["time"] == "16:00"
    assert ne[1]["type"] == "task"


@pytest.mark.asyncio
async def test_service_exception_handled_gracefully():
    """If a service raises, the endpoint still returns defaults."""

    class BrokenTaskService:
        async def list_tasks(self, **kw: Any) -> list:
            raise RuntimeError("DB gone")

    class BrokenFinance:
        async def get_monthly_summary(self, *a: Any, **kw: Any) -> dict:
            raise RuntimeError("DB gone")
        async def list_entries(self, **kw: Any) -> list:
            raise RuntimeError("DB gone")

    result = await generate_dashboard_summary(
        task_service=BrokenTaskService(),
        finance_service=BrokenFinance(),
    )

    assert result["tasks_today"]["total"] == 0
    assert result["finance_month"]["income"] == 0.0
    assert result["finance_month"]["pending_review"] == 0
