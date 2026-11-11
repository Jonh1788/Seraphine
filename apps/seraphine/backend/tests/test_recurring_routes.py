"""HTTP-level tests for the /recurring router.

Boots a minimal FastAPI app with only the recurring router mounted and a real
``RecurringService`` over a temp store, so the route surface is exercised
without paying for the full lifespan wiring.

The reason this file exists: ``POST /recurring/{rule_id}/today/complete`` must
be registered BEFORE ``PATCH/DELETE /recurring/{rule_id}`` and after the
``/recurring/routines/...`` block, so the static segments win over the path
parameter. That ordering is invisible to the service-level tests -- if someone
moves the routes around, the iOS notification button silently 404s and nothing
else in the suite notices.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.memory.store import MemoryStore
from seraphine.recurring import schema as recurring_schema
from seraphine.recurring.routes import router as recurring_router
from seraphine.recurring.service import RecurringService
from tests.test_recurring import _FakeTaskService


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "recurring_routes.sqlite")
    s.register_migrator("seraphine_recurring", recurring_schema.migrate)
    await s.ensure_schema()
    return s


def _make_app(svc: RecurringService | None) -> FastAPI:
    app = FastAPI()
    app.include_router(recurring_router)
    app.state.recurring_service = svc
    return app


async def test_complete_today_route_reaches_the_service(
    store: MemoryStore,
) -> None:
    """The POST must land on complete_today, not on the /{rule_id} routes."""
    tasks = _FakeTaskService()
    svc = RecurringService(store, tasks)
    app = _make_app(svc)
    with TestClient(app) as client:
        created = client.post(
            "/recurring",
            json={"title": "Apoiar Aline", "frequency": "daily", "time": "10:00"},
        )
        assert created.status_code == 200, created.text
        rule_id = created.json()["id"]

        # Materialize today's occurrence through the service (the background
        # loop's job), then complete it through the HTTP surface. The route
        # reads the clock itself, so "today" must be the real today here.
        await svc.materialize_due(datetime.now(timezone.utc))
        assert tasks.created, "expected today's occurrence to exist"

        resp = client.post(f"/recurring/{rule_id}/today/complete")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"ok": True, "task_id": 1}
        assert tasks.updated == [(1, {"status": "completed"})]


async def test_complete_today_route_is_declared_before_the_rule_id_routes(
    store: MemoryStore,
) -> None:
    """Registration order is the contract; assert it directly.

    A 200 in the test above could in principle be produced by a lucky match,
    so pin the ordering itself: the three-segment static path must come before
    the bare ``/{rule_id}`` parameter routes.
    """
    app = _make_app(RecurringService(store, _FakeTaskService()))
    paths = [
        getattr(r, "path", "") for r in app.routes
        if getattr(r, "path", "").startswith("/recurring")
    ]
    assert "/recurring/{rule_id}/today/complete" in paths
    assert paths.index("/recurring/{rule_id}/today/complete") < paths.index(
        "/recurring/{rule_id}",
    ), f"complete route must precede /recurring/{{rule_id}}; got {paths}"


async def test_complete_today_route_404s_without_an_occurrence(
    store: MemoryStore,
) -> None:
    """Nothing materialized today -> 404, and no task is touched."""
    tasks = _FakeTaskService()
    app = _make_app(RecurringService(store, tasks))
    with TestClient(app) as client:
        resp = client.post("/recurring/nao-existe/today/complete")
        assert resp.status_code == 404, resp.text
        assert tasks.updated == []


async def test_complete_today_route_503_when_service_missing() -> None:
    app = _make_app(None)
    with TestClient(app) as client:
        resp = client.post("/recurring/whatever/today/complete")
        assert resp.status_code == 503
