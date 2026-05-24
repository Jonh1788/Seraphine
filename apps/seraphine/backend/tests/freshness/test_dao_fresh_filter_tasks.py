"""Test that TaskService.list_tasks(fresh_only=True) applies the
FreshnessPolicy filter.

NOTE on shape vs the plan's sketch:
    The Freshness implementation plan sketched a synchronous
    ``tasks_service.list_tasks(db, fresh_only=True)`` against the raw
    conftest ``db`` fixture. The real ``list_tasks`` lives at
    ``mod_tasks.service.TaskService.list_tasks`` — it is an async
    instance method driven by an injected ``Store`` and accepts only
    keyword args.

    Adapting the test to the real surface keeps the contract intent
    (fresh_only must filter stale undated rows, default must keep them,
    dated pre-event rows must survive) while exercising the production
    code path the rest of the freshness work will integrate with.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema
from mod_tasks import service as tasks_service


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _insert_task(
    store: Store,
    *,
    title: str,
    created_at: str,
    due_date: str | None = None,
    status: str = "pending",
) -> None:
    """Direct INSERT bypassing create_task so we can backdate created_at.
    The service stamps created_at = now(), which would defeat the test."""
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO seraphine_tasks"
            " (type, status, title, description, source, payload,"
            "  created_at, updated_at, due_date)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "generic", status, title, "", "test", "{}",
                created_at, created_at, due_date,
            ),
        )


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "fresh_tasks.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
def service(store: Store) -> TaskService:
    return TaskService(store)


async def test_list_tasks_fresh_only_excludes_old_undated(
    store: Store, service: TaskService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Inject fixed NOW via the module-level helper (added in this task).
    monkeypatch.setattr(
        tasks_service, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    _insert_task(
        store, title="fresca", created_at=_iso(NOW - timedelta(hours=1)),
    )
    _insert_task(
        store, title="velha", created_at=_iso(NOW - timedelta(days=10)),
    )

    fresh = await service.list_tasks(fresh_only=True)
    titles = [t.title for t in fresh]
    assert "fresca" in titles
    assert "velha" not in titles


async def test_list_tasks_default_keeps_all(
    store: Store, service: TaskService,
) -> None:
    """Regression: fresh_only=False (default) preserves prior behavior."""
    _insert_task(
        store, title="velha", created_at=_iso(NOW - timedelta(days=10)),
    )
    all_tasks = await service.list_tasks()  # default
    titles = [t.title for t in all_tasks]
    assert "velha" in titles


async def test_list_tasks_fresh_only_keeps_dated_in_pre_event_window(
    store: Store, service: TaskService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tasks_service, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    _insert_task(
        store,
        title="velha mas evento proximo",
        created_at=_iso(NOW - timedelta(days=60)),
        due_date=_iso(NOW + timedelta(days=2)),
    )

    fresh = await service.list_tasks(fresh_only=True)
    titles = [t.title for t in fresh]
    assert "velha mas evento proximo" in titles
