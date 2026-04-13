"""Tests for the internal task system (TaskService + MemoryStore)."""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from seraphine.main import app
from seraphine.memory.store import MemoryStore
from seraphine.tasks.service import TaskService


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "tasks.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def service(store: MemoryStore) -> TaskService:
    return TaskService(store)


async def test_create_and_list_task(service: TaskService) -> None:
    task_id = await service.create_task(
        type="finance_import",
        title="Extrato Nubank",
        description="Um extrato chegou por email",
        source="email",
        payload={"email_id": "abc123"},
    )
    assert isinstance(task_id, int)
    assert task_id > 0

    tasks = await service.list_tasks()
    assert len(tasks) == 1
    t = tasks[0]
    assert t.id == task_id
    assert t.type == "finance_import"
    assert t.status == "pending"
    assert t.title == "Extrato Nubank"
    assert t.source == "email"
    assert t.payload == {"email_id": "abc123"}
    assert t.created_at is not None
    assert t.updated_at is not None


async def test_update_status(service: TaskService) -> None:
    task_id = await service.create_task(
        type="generic", title="t", description="d", source="system",
        payload={},
    )
    before = await service.get_task(task_id)
    assert before is not None
    assert before.status == "pending"

    await service.update_status(task_id, "approved")
    after = await service.get_task(task_id)
    assert after is not None
    assert after.status == "approved"
    assert after.updated_at is not None
    assert before.updated_at is not None
    assert after.updated_at >= before.updated_at


async def test_delete_task(service: TaskService) -> None:
    task_id = await service.create_task(
        type="generic", title="t", description="", source="system",
        payload={},
    )
    assert await service.get_task(task_id) is not None

    await service.delete_task(task_id)
    assert await service.get_task(task_id) is None


async def test_list_filters_by_status(service: TaskService) -> None:
    await service.create_task(
        type="finance_import", title="a", description="", source="email",
        payload={}, status="pending",
    )
    await service.create_task(
        type="finance_import", title="b", description="", source="email",
        payload={}, status="pending",
    )
    await service.create_task(
        type="generic", title="c", description="", source="system",
        payload={}, status="completed",
    )

    pending = await service.list_tasks(status="pending")
    assert len(pending) == 2
    assert all(t.status == "pending" for t in pending)

    completed = await service.list_tasks(status="completed")
    assert len(completed) == 1
    assert completed[0].title == "c"

    finance = await service.list_tasks(type="finance_import")
    assert len(finance) == 2

    pending_finance = await service.list_tasks(
        status="pending", type="finance_import",
    )
    assert len(pending_finance) == 2

    limited = await service.list_tasks(limit=1)
    assert len(limited) == 1


async def test_payload_roundtrip_json(service: TaskService) -> None:
    complex_payload: dict = {
        "email_id": "m-123",
        "attachment_id": "a-456",
        "filename": "extrato.pdf",
        "needs_password": True,
        "tags": ["fatura", "abril", "2026"],
        "nested": {
            "bank": "nubank",
            "amount": 1234.56,
            "meta": {"imported": False, "count": 0},
        },
    }
    task_id = await service.create_task(
        type="finance_import",
        title="Roundtrip",
        description="Testa payload aninhado",
        source="email",
        payload=complex_payload,
    )
    task = await service.get_task(task_id)
    assert task is not None
    assert task.payload == complex_payload
    # Also check list path
    listed = await service.list_tasks(type="finance_import")
    assert len(listed) == 1
    assert listed[0].payload == complex_payload


async def test_execute_unknown_type_marks_failed(service: TaskService) -> None:
    task_id = await service.create_task(
        type="calendar_add", title="ev", description="", source="system",
        payload={},
    )
    with pytest.raises(NotImplementedError):
        await service.execute_task(task_id, {})
    task = await service.get_task(task_id)
    assert task is not None
    assert task.status == "failed"


async def test_execute_missing_task() -> None:
    # No store fixture — fresh instance
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        s = MemoryStore(Path(td) / "t.sqlite")
        await s.ensure_schema()
        svc = TaskService(s)
        with pytest.raises(ValueError):
            await svc.execute_task(999, {})


# ------------------------------------------------------------------
# _execute_finance_import — mock-based tests
# ------------------------------------------------------------------

class _FakeToolResult:
    """Stand-in for the real pydantic ToolResult used by the tool registry."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        return dict(self._data)


class _RecordingImportTool:
    """Captures the ``file_path`` argument and returns a fixed result."""

    def __init__(self) -> None:
        self.received_path: str | None = None
        self.path_existed_during_call: bool | None = None

    async def execute(self, args: dict[str, Any]) -> _FakeToolResult:
        self.received_path = args.get("file_path")
        self.path_existed_during_call = (
            self.received_path is not None and os.path.exists(self.received_path)
        )
        return _FakeToolResult({"ok": True, "rows": 3})


class _FakeToolRegistry:
    def __init__(self, mapping: dict[str, Any]) -> None:
        self._mapping = mapping

    def get(self, name: str) -> Any:
        return self._mapping.get(name)


class _FakeGoogleClient:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.calls: list[tuple[str, str]] = []

    async def download_attachment(self, email_id: str, attachment_id: str) -> bytes:
        self.calls.append((email_id, attachment_id))
        return self._payload


async def test_execute_finance_import_cleans_temp_file(store: MemoryStore) -> None:
    """Happy path: tool receives a real file path and it is unlinked after."""
    tool = _RecordingImportTool()
    app_state = SimpleNamespace(tools=_FakeToolRegistry({"import_financial_pdf": tool}))
    google = _FakeGoogleClient(b"%PDF-fake-bytes")
    svc = TaskService(store, google_client=google, app_state=app_state)

    task_id = await svc.create_task(
        type="finance_import",
        title="Extrato",
        description="",
        source="email",
        payload={
            "email_id": "m-1",
            "attachment_id": "a-1",
            "filename": "extrato.pdf",
        },
    )

    result = await svc.execute_task(task_id, {})

    assert google.calls == [("m-1", "a-1")]
    assert tool.received_path is not None
    assert tool.path_existed_during_call is True
    # After execute, the temp file must be gone.
    assert not os.path.exists(tool.received_path)
    assert result["imported"] is True
    assert result["result"] == {"ok": True, "rows": 3}
    assert "file_path" not in result

    task = await svc.get_task(task_id)
    assert task is not None
    assert task.status == "completed"


async def test_execute_finance_import_cleans_temp_file_on_tool_error(
    store: MemoryStore,
) -> None:
    """Tool raises → temp file must still be cleaned up + task marked failed."""

    captured: dict[str, str] = {}

    class _BoomTool:
        async def execute(self, args: dict[str, Any]) -> Any:
            captured["path"] = args["file_path"]
            # Confirm it was actually materialized on disk.
            assert os.path.exists(args["file_path"])
            raise RuntimeError("pdf parse boom")

    app_state = SimpleNamespace(
        tools=_FakeToolRegistry({"import_financial_pdf": _BoomTool()}),
    )
    google = _FakeGoogleClient(b"bytes")
    svc = TaskService(store, google_client=google, app_state=app_state)

    task_id = await svc.create_task(
        type="finance_import", title="x", description="", source="email",
        payload={"email_id": "m", "attachment_id": "a", "filename": "x.pdf"},
    )

    with pytest.raises(RuntimeError, match="pdf parse boom"):
        await svc.execute_task(task_id, {})

    assert "path" in captured
    assert not os.path.exists(captured["path"])

    task = await svc.get_task(task_id)
    assert task is not None
    assert task.status == "failed"


async def test_execute_finance_import_fails_when_tool_missing(
    store: MemoryStore,
) -> None:
    """If import tool isn't registered, task must be marked ``failed``."""
    app_state = SimpleNamespace(tools=_FakeToolRegistry({}))  # empty registry
    google = _FakeGoogleClient(b"bytes")
    svc = TaskService(store, google_client=google, app_state=app_state)

    task_id = await svc.create_task(
        type="finance_import", title="x", description="", source="email",
        payload={"email_id": "m", "attachment_id": "a", "filename": "x.pdf"},
    )

    with pytest.raises(RuntimeError):
        await svc.execute_task(task_id, {})

    task = await svc.get_task(task_id)
    assert task is not None
    assert task.status == "failed"


async def test_execute_finance_import_fails_when_app_state_missing(
    store: MemoryStore,
) -> None:
    """If app_state is None the tool registry is unavailable → ``failed``."""
    google = _FakeGoogleClient(b"bytes")
    svc = TaskService(store, google_client=google, app_state=None)

    task_id = await svc.create_task(
        type="finance_import", title="x", description="", source="email",
        payload={"email_id": "m", "attachment_id": "a", "filename": "x.pdf"},
    )

    with pytest.raises(RuntimeError):
        await svc.execute_task(task_id, {})

    task = await svc.get_task(task_id)
    assert task is not None
    assert task.status == "failed"


# ------------------------------------------------------------------
# HTTP routes — FastAPI TestClient
# ------------------------------------------------------------------

def _reset_task_service(svc: TaskService | None) -> None:
    app.state.task_service = svc


def test_routes_503_when_service_unconfigured() -> None:
    # Lifespan startup populates app.state.task_service, so wipe it AFTER
    # entering the TestClient context (which triggers lifespan).
    with TestClient(app) as client:
        prev = getattr(app.state, "task_service", None)
        _reset_task_service(None)
        try:
            resp = client.get("/tasks")
            assert resp.status_code == 503
            resp = client.post("/tasks", json={"type": "generic", "title": "t"})
            assert resp.status_code == 503
            resp = client.patch("/tasks/1", json={"status": "completed"})
            assert resp.status_code == 503
            resp = client.delete("/tasks/1")
            assert resp.status_code == 503
            resp = client.post("/tasks/1/execute", json={"params": {}})
            assert resp.status_code == 503
        finally:
            _reset_task_service(prev)


def test_routes_crud_and_404_for_missing_task(tmp_path: Path) -> None:
    import asyncio

    store_ = MemoryStore(tmp_path / "routes.sqlite")
    asyncio.new_event_loop().run_until_complete(store_.ensure_schema())
    svc = TaskService(store_)
    with TestClient(app) as client:
        prev = getattr(app.state, "task_service", None)
        _reset_task_service(svc)
        try:
            # POST — valid type
            resp = client.post(
                "/tasks",
                json={
                    "type": "generic",
                    "title": "hello",
                    "description": "d",
                    "source": "system",
                    "payload": {"k": "v"},
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["ok"] is True
            task_id = body["id"]
            assert isinstance(task_id, int)

            # POST — unknown type → 422
            resp = client.post(
                "/tasks",
                json={"type": "not_a_type", "title": "x"},
            )
            assert resp.status_code == 422

            # GET list
            resp = client.get("/tasks")
            assert resp.status_code == 200
            listed = resp.json()["tasks"]
            assert len(listed) == 1
            assert listed[0]["id"] == task_id
            assert listed[0]["type"] == "generic"

            # PATCH existing task → ok
            resp = client.patch(
                f"/tasks/{task_id}", json={"status": "approved"},
            )
            assert resp.status_code == 200
            assert resp.json() == {"ok": True}

            # PATCH missing task → 404
            resp = client.patch(
                "/tasks/99999", json={"status": "approved"},
            )
            assert resp.status_code == 404

            # PATCH invalid status → 422
            resp = client.patch(
                f"/tasks/{task_id}", json={"status": "nope"},
            )
            assert resp.status_code == 422

            # DELETE missing task → 404
            resp = client.delete("/tasks/99999")
            assert resp.status_code == 404

            # DELETE existing task → ok
            resp = client.delete(f"/tasks/{task_id}")
            assert resp.status_code == 200
            assert resp.json() == {"ok": True}

            # DELETE again (now gone) → 404
            resp = client.delete(f"/tasks/{task_id}")
            assert resp.status_code == 404
        finally:
            _reset_task_service(prev)


def test_routes_execute_shape(tmp_path: Path) -> None:
    import asyncio

    store_ = MemoryStore(tmp_path / "exec.sqlite")
    asyncio.new_event_loop().run_until_complete(store_.ensure_schema())
    svc = TaskService(store_)
    # Seed a calendar_add task before entering TestClient (avoids nested loops).
    task_id = asyncio.new_event_loop().run_until_complete(
        svc.create_task(
            type="calendar_add", title="ev", description="",
            source="system", payload={},
        )
    )
    with TestClient(app) as client:
        prev = getattr(app.state, "task_service", None)
        _reset_task_service(svc)
        try:
            # execute on missing task → 404
            resp = client.post("/tasks/99999/execute", json={"params": {}})
            assert resp.status_code == 404

            # type unsupported by execute_task → 501
            resp = client.post(f"/tasks/{task_id}/execute", json={"params": {}})
            assert resp.status_code == 501
        finally:
            _reset_task_service(prev)
