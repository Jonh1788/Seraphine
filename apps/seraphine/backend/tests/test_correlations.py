"""Tests for the cross-domain correlation engine (SDD 085).

Covers:
- Pearson correlation math (manual + scipy paths)
- Time-series extraction from SQLite
- Significance filtering (|r| > 0.4, p < 0.05)
- Message formatting (no causality claims)
- Route: GET /insights/correlations
- Route: GET /insights?type=cross_domain
- Integration with InsightEngine.refresh_all()
"""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.insights import schema as insights_schema
from seraphine.insights.correlations import (
    CorrelationResult,
    MIN_ABS_R,
    _pearsonr,
    compute_correlations,
    format_correlation_message,
    get_weekly_correlations,
)
from seraphine.insights.routes import router as insights_router
from seraphine.insights.service import InsightEngine
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "corr_test.sqlite")
    s.register_migrator("seraphine_insights", insights_schema.migrate)

    # Register tables that the correlation engine reads from directly.
    def _health_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS health_snapshots (
              date TEXT PRIMARY KEY,
              steps INTEGER NOT NULL DEFAULT 0,
              active_calories REAL NOT NULL DEFAULT 0,
              resting_heart_rate REAL,
              sleep_minutes REAL,
              sleep_quality TEXT,
              weight_kg REAL,
              workouts_json TEXT NOT NULL DEFAULT '[]',
              synced_at TEXT NOT NULL
            );
        """)

    def _tasks_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS seraphine_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              source TEXT NOT NULL,
              payload TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              due_date TEXT,
              due_time TEXT,
              user_id TEXT,
              priority TEXT,
              tags TEXT,
              remind TEXT
            );
        """)

    def _habits_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS habits (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              frequency TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS habit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              habit_id TEXT NOT NULL,
              date TEXT NOT NULL,
              completed INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              UNIQUE(habit_id, date)
            );
        """)

    def _water_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS water_profile (
              id INTEGER PRIMARY KEY CHECK(id=1),
              weight_kg REAL NOT NULL,
              activity_level TEXT NOT NULL,
              daily_goal_ml INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS water_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              amount_ml INTEGER NOT NULL,
              date TEXT NOT NULL,
              logged_at TEXT NOT NULL
            );
        """)

    s.register_migrator("health_test", _health_schema)
    s.register_migrator("tasks_test", _tasks_schema)
    s.register_migrator("habits_test", _habits_schema)
    s.register_migrator("water_test", _water_schema)
    await s.ensure_schema()
    return s


def _seed_correlated_data(store: MemoryStore, days: int = 30) -> None:
    """Seed health + tasks with a strong positive correlation.

    More sleep -> more tasks completed (linear relationship).
    """
    today = date.today()
    with store._connect() as conn:
        for i in range(days):
            d = (today - timedelta(days=days - 1 - i)).isoformat()
            # Alternate between good and bad sleep days
            if i % 2 == 0:
                sleep_min = 480.0  # 8h
                tasks = 5
            else:
                sleep_min = 300.0  # 5h
                tasks = 1

            conn.execute(
                "INSERT OR REPLACE INTO health_snapshots"
                " (date, steps, active_calories, sleep_minutes, workouts_json, synced_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (d, 8000 + i * 100, 300.0, sleep_min, "[]", "2025-01-01T00:00:00"),
            )

            for t in range(tasks):
                conn.execute(
                    "INSERT INTO seraphine_tasks"
                    " (type, status, title, description, source, payload,"
                    "  created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "task", "completed", f"Task {t}", "", "test", "{}",
                        f"{d}T08:00:00+00:00",
                        f"{d}T17:00:00+00:00",
                    ),
                )


def _seed_uncorrelated_data(store: MemoryStore, days: int = 30) -> None:
    """Seed data with no meaningful correlation."""
    import random
    rng = random.Random(42)  # deterministic
    today = date.today()
    with store._connect() as conn:
        for i in range(days):
            d = (today - timedelta(days=days - 1 - i)).isoformat()
            conn.execute(
                "INSERT OR REPLACE INTO health_snapshots"
                " (date, steps, active_calories, sleep_minutes, workouts_json, synced_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (d, rng.randint(2000, 15000), 300.0, rng.uniform(300, 540), "[]", "now"),
            )
            for _ in range(rng.randint(0, 5)):
                conn.execute(
                    "INSERT INTO seraphine_tasks"
                    " (type, status, title, description, source, payload,"
                    "  created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ("task", "completed", "T", "", "test", "{}",
                     f"{d}T08:00:00+00:00", f"{d}T17:00:00+00:00"),
                )


def _make_app(
    *, engine: InsightEngine | None, store: MemoryStore | None,
) -> FastAPI:
    app = FastAPI()
    app.include_router(insights_router)
    app.state.insight_engine = engine
    app.state.store = store
    return app


# ---------------------------------------------------------------------------
# Unit tests: Pearson correlation math
# ---------------------------------------------------------------------------

class TestPearsonr:
    def test_perfect_positive(self):
        x = [1.0, 2.0, 3.0, 4.0, 5.0]
        y = [2.0, 4.0, 6.0, 8.0, 10.0]
        r, p = _pearsonr(x, y)
        assert abs(r - 1.0) < 1e-10
        assert p < 0.01

    def test_perfect_negative(self):
        x = [1.0, 2.0, 3.0, 4.0, 5.0]
        y = [10.0, 8.0, 6.0, 4.0, 2.0]
        r, p = _pearsonr(x, y)
        assert abs(r - (-1.0)) < 1e-10

    def test_no_correlation(self):
        x = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        y = [5.0, 3.0, 7.0, 1.0, 8.0, 2.0, 6.0, 4.0]
        r, p = _pearsonr(x, y)
        assert abs(r) < 0.5  # weak or no correlation

    def test_too_few_points_returns_zero(self):
        r, p = _pearsonr([1.0, 2.0], [3.0, 4.0])
        assert r == 0.0
        assert p == 1.0

    def test_constant_series_returns_zero(self):
        r, p = _pearsonr([5.0, 5.0, 5.0], [1.0, 2.0, 3.0])
        assert r == 0.0

    def test_mismatched_length_returns_zero(self):
        r, p = _pearsonr([1.0, 2.0, 3.0], [1.0, 2.0])
        assert r == 0.0
        assert p == 1.0


# ---------------------------------------------------------------------------
# Unit tests: message formatting
# ---------------------------------------------------------------------------

class TestFormatMessage:
    def test_positive_correlation_message(self):
        msg = format_correlation_message(
            "sleep_hours", "tasks_completed", r=0.72, n=25,
        )
        assert "correlacao positiva" in msg
        assert "r=0.72" in msg
        assert "25 dias" in msg
        # Must NOT claim causality
        assert "causa" not in msg.lower()

    def test_negative_correlation_message(self):
        msg = format_correlation_message(
            "steps", "tasks_completed", r=-0.55, n=20,
        )
        assert "correlacao negativa" in msg
        assert "causa" not in msg.lower()

    def test_strong_correlation_label(self):
        msg = format_correlation_message(
            "sleep_hours", "tasks_completed", r=0.85, n=30,
        )
        assert "forte" in msg

    def test_moderate_correlation_label(self):
        msg = format_correlation_message(
            "sleep_hours", "tasks_completed", r=0.45, n=30,
        )
        assert "moderada" in msg


# ---------------------------------------------------------------------------
# Integration: compute_correlations with seeded data
# ---------------------------------------------------------------------------

async def test_compute_correlations_strong_signal(store: MemoryStore) -> None:
    _seed_correlated_data(store, days=30)
    results = await compute_correlations(store, days=30)
    assert len(results) >= 1
    # The sleep_hours vs tasks_completed pair should be present
    sleep_tasks = [
        c for c in results
        if {c.series_a, c.series_b} == {"sleep_hours", "tasks_completed"}
    ]
    assert len(sleep_tasks) == 1
    c = sleep_tasks[0]
    assert abs(c.r) > MIN_ABS_R
    assert c.p < 0.05
    assert c.n >= 7
    assert c.message  # non-empty

    # Verify CorrelationResult.to_dict() round-trips
    d = c.to_dict()
    assert d["r"] == round(c.r, 4)
    assert d["p"] == round(c.p, 6)
    assert d["series_a"] == "sleep_hours"
    assert d["series_b"] == "tasks_completed"


async def test_compute_correlations_no_data_returns_empty(
    store: MemoryStore,
) -> None:
    # Empty tables -> no correlations
    results = await compute_correlations(store, days=30)
    assert results == []


async def test_get_weekly_correlations_respects_top_n(
    store: MemoryStore,
) -> None:
    _seed_correlated_data(store, days=30)
    top = await get_weekly_correlations(store, top_n=1)
    assert len(top) <= 1


# ---------------------------------------------------------------------------
# Integration: InsightEngine.analyze_correlations()
# ---------------------------------------------------------------------------

async def test_analyze_correlations_creates_cross_domain_insights(
    store: MemoryStore,
) -> None:
    _seed_correlated_data(store, days=30)
    engine = InsightEngine(store)
    insights = await engine.analyze_correlations()
    assert len(insights) >= 1
    for i in insights:
        assert i.type == "cross_domain"
        assert i.severity in ("positive", "info")
        assert "r" in i.data
        assert "p" in i.data
        assert "causa" not in i.description.lower()


async def test_refresh_all_includes_correlations(
    store: MemoryStore,
) -> None:
    _seed_correlated_data(store, days=30)
    engine = InsightEngine(store)
    all_insights = await engine.refresh_all()
    cross_domain = [i for i in all_insights if i.type == "cross_domain"]
    assert len(cross_domain) >= 1

    # Verify they were persisted
    active = await engine.list_active(type_filter="cross_domain")
    assert len(active) >= 1


# ---------------------------------------------------------------------------
# Route tests
# ---------------------------------------------------------------------------

async def test_get_insights_type_filter(store: MemoryStore) -> None:
    _seed_correlated_data(store, days=30)
    engine = InsightEngine(store)
    await engine.refresh_all()
    app = _make_app(engine=engine, store=store)

    with TestClient(app) as client:
        # All insights
        resp = client.get("/insights")
        assert resp.status_code == 200
        all_items = resp.json()["insights"]

        # Only cross_domain
        resp = client.get("/insights?type=cross_domain")
        assert resp.status_code == 200
        cd_items = resp.json()["insights"]
        assert len(cd_items) >= 1
        assert all(i["type"] == "cross_domain" for i in cd_items)
        assert len(cd_items) <= len(all_items)


async def test_get_insights_invalid_type_returns_400(
    store: MemoryStore,
) -> None:
    engine = InsightEngine(store)
    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.get("/insights?type=nonsense")
        assert resp.status_code == 400


async def test_get_correlations_endpoint(store: MemoryStore) -> None:
    _seed_correlated_data(store, days=30)
    engine = InsightEngine(store)
    app = _make_app(engine=engine, store=store)

    with TestClient(app) as client:
        resp = client.get("/insights/correlations")
        assert resp.status_code == 200
        body = resp.json()
        assert "days" in body
        assert body["days"] == 30
        assert "correlations" in body
        assert isinstance(body["correlations"], list)
        if body["correlations"]:
            c = body["correlations"][0]
            for key in ("series_a", "series_b", "r", "p", "n", "message"):
                assert key in c


async def test_get_correlations_custom_days(store: MemoryStore) -> None:
    engine = InsightEngine(store)
    app = _make_app(engine=engine, store=store)
    with TestClient(app) as client:
        resp = client.get("/insights/correlations?days=14")
        assert resp.status_code == 200
        assert resp.json()["days"] == 14


async def test_get_correlations_503_when_engine_missing(
    store: MemoryStore,
) -> None:
    app = _make_app(engine=None, store=store)
    with TestClient(app) as client:
        resp = client.get("/insights/correlations")
        assert resp.status_code == 503
