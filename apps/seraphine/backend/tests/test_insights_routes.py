"""HTTP-level tests for the /insights router.

Boots a minimal FastAPI app with only the insights router mounted and a
stubbed ``app.state.insight_engine`` so we exercise the route surface
without paying for the full lifespan wiring.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.insights import schema as insights_schema
from seraphine.insights.routes import router as insights_router
from seraphine.insights.service import InsightEngine
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "insights_routes.sqlite")
    s.register_migrator("seraphine_insights", insights_schema.migrate)
    await s.ensure_schema()
    return s


def _make_app(
    *, engine: InsightEngine | None, store: MemoryStore | None,
) -> FastAPI:
    app = FastAPI()
    app.include_router(insights_router)
    app.state.insight_engine = engine
    app.state.store = store
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_list_empty_returns_empty_array(store: MemoryStore) -> None:
    engine = InsightEngine(store)  # no service injections -> nothing to generate
    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.get("/insights")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body == {"insights": []}


async def test_refresh_returns_insights_payload(store: MemoryStore) -> None:
    # Seed an engine with a habits fake that yields exactly one insight.
    from types import SimpleNamespace as _NS  # noqa: F401

    class _FakeHabits:
        async def list_with_today_status(self) -> list[dict[str, Any]]:
            return [{
                "id": "h1",
                "title": "Ler",
                "current_streak": 7,
                "best_streak": 7,
                "active": True,
            }]

    engine = InsightEngine(store, habit_service=_FakeHabits())
    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.post("/insights/refresh", json={})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "insights" in body
        assert "generated" in body
        assert body["generated"] >= 1
        assert len(body["insights"]) >= 1
        first = body["insights"][0]
        for key in ("id", "type", "severity", "title", "description"):
            assert key in first


async def test_dismiss_hides_from_subsequent_list(store: MemoryStore) -> None:
    class _FakeHabits:
        async def list_with_today_status(self) -> list[dict[str, Any]]:
            return [{
                "id": "h1",
                "title": "Ler",
                "current_streak": 7,
                "best_streak": 7,
                "active": True,
            }]

    engine = InsightEngine(store, habit_service=_FakeHabits())
    await engine.refresh_all()
    items = await engine.list_active()
    assert items, "expected at least one insight after refresh"
    target_id = items[0].id

    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.post(f"/insights/{target_id}/dismiss", json={})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"ok": True}

        # Subsequent GET must not include the dismissed id.
        resp2 = client.get("/insights")
        assert resp2.status_code == 200
        ids = [i["id"] for i in resp2.json()["insights"]]
        assert target_id not in ids


async def test_dismiss_unknown_id_returns_404(store: MemoryStore) -> None:
    engine = InsightEngine(store)
    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.post("/insights/does-not-exist/dismiss", json={})
        assert resp.status_code == 404


async def test_weekly_report_envelope_shape(store: MemoryStore) -> None:
    engine = InsightEngine(store)
    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.get("/insights/weekly-report")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "report" in body
        report = body["report"]
        # Shape mirrors ``WeeklyReport.to_dict()``.
        for key in (
            "id", "week_start", "week_end", "tasks", "finance", "habits",
            "insights", "suggestion", "created_at",
        ):
            assert key in report, f"missing key {key} in weekly-report"
        assert isinstance(report["tasks"], dict)
        assert isinstance(report["finance"], dict)
        assert isinstance(report["habits"], dict)
        assert isinstance(report["insights"], list)
        assert set(report["habits"].keys()) >= {"maintained", "broken"}


async def test_routes_503_when_engine_missing(store: MemoryStore) -> None:
    app = _make_app(engine=None, store=store)
    with TestClient(app) as client:
        assert client.get("/insights").status_code == 503
        assert client.post("/insights/refresh", json={}).status_code == 503
        assert client.post(
            "/insights/whatever/dismiss", json={},
        ).status_code == 503
        assert client.get("/insights/weekly-report").status_code == 503


async def test_weekly_report_503_when_store_missing(store: MemoryStore) -> None:
    engine = InsightEngine(store)
    app = _make_app(engine=engine, store=None)
    with TestClient(app) as client:
        resp = client.get("/insights/weekly-report")
        assert resp.status_code == 503
