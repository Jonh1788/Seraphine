"""Recurring tasks — persistence, due logic, idempotency, isolation.

These tests exercise the service layer directly against a real SQLite
store (same pattern used by the rest of the suite) plus a lightweight
HTTP roundtrip to verify CRUD + cross-user scoping.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from core_db import Store
from mod_tasks import schema as tasks_schema
from mod_tasks.service import TaskService

# Intentionally avoid `from aura.auth import schema` — importing the
# aura.auth package runs its __init__ which pulls aura.config into
# sys.modules BEFORE the HTTP fixture has a chance to set env vars.
# That would bake the default (dev) JWT secret into aura.auth.routes
# and break the later test_auth_flow fixture when run in the same
# session. We seed the users table directly via SQL instead.
from aura.recurring import schema as recurring_schema
from aura.recurring.service import RecurringService, _is_due_today


def _migrate_users_table(conn) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        """
    )


# ---------------------------------------------------------------------------
# Service-level (no HTTP)
# ---------------------------------------------------------------------------


@pytest.fixture
async def svc(tmp_path: Path):
    store = Store(str(tmp_path / "rec.sqlite"))
    store.register_migrator("aura_users", _migrate_users_table)
    store.register_migrator("mod_tasks", tasks_schema.migrate)
    store.register_migrator("aura_recurring", recurring_schema.migrate)
    await store.ensure_schema()
    # Seed two users so FKs resolve.
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES ('u-a', 'a@x.io', 'x', '2026-04-01')"
        )
        conn.execute(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES ('u-b', 'b@x.io', 'x', '2026-04-01')"
        )
    tasks = TaskService(store)
    recurring = RecurringService(store, tasks)
    yield recurring, tasks
    await store.aclose()


async def test_create_and_list_user_scoped(svc):
    recurring, _ = svc
    r_a = await recurring.create(
        user_id="u-a", title="tirar o lixo", frequency="weekly",
        weekday=0, time="10:00",
    )
    r_b = await recurring.create(
        user_id="u-b", title="pagar boleto", frequency="monthly",
        day_of_month=5,
    )
    assert r_a.user_id == "u-a"
    assert r_a.active is True
    assert r_a.last_materialized_date is None

    a_list = await recurring.list_for_user("u-a")
    b_list = await recurring.list_for_user("u-b")
    assert [r.id for r in a_list] == [r_a.id]
    assert [r.id for r in b_list] == [r_b.id]


async def test_create_validates_frequency(svc):
    recurring, _ = svc
    with pytest.raises(ValueError):
        await recurring.create(
            user_id="u-a", title="x", frequency="hourly",  # bogus
        )
    with pytest.raises(ValueError):
        # weekly without weekday
        await recurring.create(user_id="u-a", title="x", frequency="weekly")
    with pytest.raises(ValueError):
        # monthly without day_of_month
        await recurring.create(user_id="u-a", title="x", frequency="monthly")


async def test_materialize_due_fires_on_matching_day(svc):
    recurring, tasks = svc
    # Pick a known Monday so weekday=0 matches.
    monday = datetime(2026, 4, 13, 9, 0, tzinfo=timezone.utc)  # 2026-04-13 is Mon
    assert monday.weekday() == 0

    rule = await recurring.create(
        user_id="u-a", title="tirar o lixo", frequency="weekly",
        weekday=0, time="10:00",
    )

    created = await recurring.materialize_due(monday)
    assert len(created) == 1
    assert created[0][0].id == rule.id

    task_id = created[0][1]
    task = await tasks.get_task(task_id, user_id="u-a")
    assert task is not None
    assert task.title == "tirar o lixo"
    assert task.due_date == "2026-04-13"
    assert task.due_time == "10:00"
    assert task.source == "recurring"
    assert task.status == "pending"


async def test_materialize_skips_non_matching_day(svc):
    recurring, tasks = svc
    tuesday = datetime(2026, 4, 14, 9, 0, tzinfo=timezone.utc)
    assert tuesday.weekday() == 1
    await recurring.create(
        user_id="u-a", title="tirar o lixo", frequency="weekly", weekday=0,
    )
    created = await recurring.materialize_due(tuesday)
    assert created == []
    rows = await tasks.list_tasks(user_id="u-a")
    assert rows == []


async def test_materialize_is_idempotent_same_day(svc):
    recurring, tasks = svc
    monday = datetime(2026, 4, 13, 9, 0, tzinfo=timezone.utc)
    await recurring.create(
        user_id="u-a", title="tirar o lixo", frequency="weekly", weekday=0,
    )

    first = await recurring.materialize_due(monday)
    second = await recurring.materialize_due(monday)
    third = await recurring.materialize_due(monday)

    assert len(first) == 1
    assert second == []
    assert third == []

    rows = await tasks.list_tasks(user_id="u-a")
    assert len(rows) == 1


async def test_daily_frequency_fires_every_day(svc):
    recurring, tasks = svc
    rule = await recurring.create(
        user_id="u-a", title="tomar remédio", frequency="daily", time="08:00",
    )
    day1 = datetime(2026, 4, 13, 9, 0, tzinfo=timezone.utc)
    day2 = datetime(2026, 4, 14, 9, 0, tzinfo=timezone.utc)

    await recurring.materialize_due(day1)
    # Same day, second run: noop.
    assert await recurring.materialize_due(day1) == []
    # Next day: fires again.
    created = await recurring.materialize_due(day2)
    assert len(created) == 1
    assert created[0][0].id == rule.id

    rows = await tasks.list_tasks(user_id="u-a")
    assert len(rows) == 2


async def test_monthly_frequency_clamps_to_last_day_of_short_month(svc):
    recurring, _ = svc
    # Rule "day 31"; February never has 31, so it should fire on Feb 28/29.
    rule = await recurring.create(
        user_id="u-a", title="fim do mês", frequency="monthly",
        day_of_month=31,
    )
    feb_28 = datetime(2026, 2, 28, 9, 0, tzinfo=timezone.utc)
    assert _is_due_today(rule, feb_28.date()) is True


async def test_inactive_rule_does_not_materialize(svc):
    recurring, tasks = svc
    rule = await recurring.create(
        user_id="u-a", title="x", frequency="daily",
    )
    await recurring.update(rule.id, "u-a", active=False)
    day = datetime(2026, 4, 13, 9, 0, tzinfo=timezone.utc)
    assert await recurring.materialize_due(day) == []
    assert await tasks.list_tasks(user_id="u-a") == []


async def test_delete_scoped_by_user(svc):
    recurring, _ = svc
    r_a = await recurring.create(user_id="u-a", title="a", frequency="daily")

    # Bob can't delete Alice's rule.
    affected = await recurring.delete(r_a.id, "u-b")
    assert affected == 0

    # But Alice can.
    affected = await recurring.delete(r_a.id, "u-a")
    assert affected == 1
    assert await recurring.get(r_a.id, "u-a") is None


# ---------------------------------------------------------------------------
# HTTP roundtrip — full app, JWT-protected
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "aura.sqlite"))
    monkeypatch.setenv("AURA_JWT_SECRET", "test-secret-do-not-ship")

    import importlib
    import aura.config as config_mod
    import aura.main as main_mod
    importlib.reload(config_mod)
    importlib.reload(main_mod)

    with TestClient(main_mod.app) as c:
        yield c


def test_http_recurring_crud_scoped(client):
    a = client.post("/auth/register", json={"email": "a@x.io", "password": "hunter2x"}).json()
    b = client.post("/auth/register", json={"email": "b@x.io", "password": "hunter2x"}).json()
    ha = {"Authorization": f"Bearer {a['access_token']}"}
    hb = {"Authorization": f"Bearer {b['access_token']}"}

    r = client.post(
        "/recurring", headers=ha,
        json={
            "title": "tirar o lixo", "frequency": "weekly",
            "weekday": 0, "time": "10:00",
        },
    )
    assert r.status_code == 200, r.text
    rid = r.json()["id"]

    # Alice sees 1, Bob sees 0.
    la = client.get("/recurring", headers=ha).json()["recurring"]
    lb = client.get("/recurring", headers=hb).json()["recurring"]
    assert len(la) == 1 and la[0]["id"] == rid
    assert lb == []

    # Bob can't touch Alice's rule — 404 by design.
    assert client.patch(f"/recurring/{rid}", headers=hb, json={"active": False}).status_code == 404
    assert client.delete(f"/recurring/{rid}", headers=hb).status_code == 404

    # Alice can patch + delete.
    r = client.patch(f"/recurring/{rid}", headers=ha, json={"time": "09:30"})
    assert r.status_code == 200
    assert r.json()["recurring"]["time"] == "09:30"

    assert client.delete(f"/recurring/{rid}", headers=ha).status_code == 200
    assert client.get("/recurring", headers=ha).json()["recurring"] == []


def test_http_unauth_rejected(client):
    assert client.get("/recurring").status_code == 401
    assert client.post("/recurring", json={"title": "x", "frequency": "daily"}).status_code == 401
