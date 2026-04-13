"""Tests for the internal task system (TaskService)."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import pytest

from seraphine.tasks.models import SeraphineTask
from seraphine.tasks.service import TaskService


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "test_tasks.sqlite"


@pytest.fixture()
def service(db_path: Path) -> TaskService:
    return TaskService(db_path=db_path)


def _make_task(**overrides: object) -> SeraphineTask:
    defaults = dict(
        id=None,
        type="finance_import",
        status="pending",
        title="Test task",
        description="desc",
        source="email",
        payload='{"key": "value"}',
    )
    defaults.update(overrides)
    return SeraphineTask(**defaults)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_ensure_tables(service: TaskService) -> None:
    await service.ensure_tables()
    # Should be idempotent
    await service.ensure_tables()
    await service.aclose()


@pytest.mark.asyncio
async def test_create_and_list(service: TaskService) -> None:
    await service.ensure_tables()
    task = _make_task()
    task_id = await service.create_task(task)
    assert isinstance(task_id, int)
    assert task_id > 0

    tasks = await service.list_tasks()
    assert len(tasks) == 1
    assert tasks[0].id == task_id
    assert tasks[0].type == "finance_import"
    assert tasks[0].status == "pending"
    assert tasks[0].title == "Test task"
    assert tasks[0].created_at is not None
    assert tasks[0].updated_at is not None
    await service.aclose()


@pytest.mark.asyncio
async def test_list_with_filters(service: TaskService) -> None:
    await service.ensure_tables()
    await service.create_task(_make_task(type="finance_import", status="pending"))
    await service.create_task(_make_task(type="generic", status="pending"))
    await service.create_task(_make_task(type="finance_import", status="approved"))

    # Filter by status
    pending = await service.list_tasks(status="pending")
    assert len(pending) == 2

    # Filter by type
    finance = await service.list_tasks(type="finance_import")
    assert len(finance) == 2

    # Filter by both
    finance_pending = await service.list_tasks(status="pending", type="finance_import")
    assert len(finance_pending) == 1

    # Limit
    limited = await service.list_tasks(limit=1)
    assert len(limited) == 1

    await service.aclose()


@pytest.mark.asyncio
async def test_update_status(service: TaskService) -> None:
    await service.ensure_tables()
    task_id = await service.create_task(_make_task())
    task_before = await service.get_task(task_id)
    assert task_before is not None
    assert task_before.status == "pending"

    await service.update_status(task_id, "approved")
    task_after = await service.get_task(task_id)
    assert task_after is not None
    assert task_after.status == "approved"
    # updated_at should change
    assert task_after.updated_at >= task_before.updated_at  # type: ignore[operator]
    await service.aclose()


@pytest.mark.asyncio
async def test_delete(service: TaskService) -> None:
    await service.ensure_tables()
    task_id = await service.create_task(_make_task())
    assert await service.get_task(task_id) is not None

    await service.delete_task(task_id)
    assert await service.get_task(task_id) is None
    await service.aclose()


@pytest.mark.asyncio
async def test_get_task(service: TaskService) -> None:
    await service.ensure_tables()
    # Non-existent task
    assert await service.get_task(999) is None

    task_id = await service.create_task(_make_task(
        title="Specific task",
        description="Detailed description",
        payload='{"email_id": "abc123"}',
    ))
    task = await service.get_task(task_id)
    assert task is not None
    assert task.title == "Specific task"
    assert task.description == "Detailed description"
    assert task.payload == '{"email_id": "abc123"}'
    assert task.source == "email"
    await service.aclose()
