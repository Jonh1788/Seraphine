"""TaskService.set_reminder_offsets / get_reminder_offsets.

The persistence layer is owned by mod-tasks; only the materialization
rule (auto-include 0, default to [0] on bare due_time) lives in the
routes layer. These tests exercise the raw service: it stores whatever
you give it, sorted+deduped, and the PK enforces uniqueness.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "offsets.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_set_and_get_round_trip(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    await svc.set_reminder_offsets(str(tid), "u1", [0, 15, 60])
    got = await svc.get_reminder_offsets(str(tid), "u1")
    assert got == [0, 15, 60]


async def test_set_dedupes_and_sorts(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    persisted = await svc.set_reminder_offsets(
        str(tid), "u1", [60, 60, 15, 0, 15],
    )
    assert persisted == [0, 15, 60]
    got = await svc.get_reminder_offsets(str(tid), "u1")
    assert got == [0, 15, 60]


async def test_set_replaces_existing(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    await svc.set_reminder_offsets(str(tid), "u1", [0, 15])
    await svc.set_reminder_offsets(str(tid), "u1", [60, 1440])
    got = await svc.get_reminder_offsets(str(tid), "u1")
    assert got == [60, 1440]


async def test_set_to_empty_clears(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    await svc.set_reminder_offsets(str(tid), "u1", [0, 15])
    await svc.set_reminder_offsets(str(tid), "u1", [])
    got = await svc.get_reminder_offsets(str(tid), "u1")
    assert got == []


async def test_get_empty_for_unknown_task(store: Store) -> None:
    svc = TaskService(store)
    got = await svc.get_reminder_offsets("999999", "u1")
    assert got == []


async def test_pk_uniqueness(store: Store) -> None:
    """Two INSERTs at the same offset must collide on PK."""
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    await svc.set_reminder_offsets(str(tid), "u1", [15])
    # Direct manual INSERT must fail on PK collision.
    with pytest.raises(sqlite3.IntegrityError):
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO task_reminder_offsets"
                " (task_id, user_id, offset_minutes, created_at)"
                " VALUES (?, ?, ?, '2026-05-19')",
                (str(tid), "u1", 15),
            )


async def test_task_load_includes_offsets(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    await svc.set_reminder_offsets(str(tid), "u1", [0, 15, 60])
    task = await svc.get_task(tid, user_id="u1")
    assert task is not None
    assert task.reminder_offsets == [0, 15, 60]


async def test_list_tasks_bulk_loads_offsets(store: Store) -> None:
    svc = TaskService(store)
    t1 = await svc.create_task(
        type="reminder", title="A", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    t2 = await svc.create_task(
        type="reminder", title="B", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="11:00",
    )
    await svc.set_reminder_offsets(str(t1), "u1", [0, 15])
    await svc.set_reminder_offsets(str(t2), "u1", [60])
    rows = await svc.list_tasks(user_id="u1")
    by_title = {t.title: t.reminder_offsets for t in rows}
    assert by_title["A"] == [0, 15]
    assert by_title["B"] == [60]


async def test_negative_offsets_rejected_at_db_level(store: Store) -> None:
    """The CHECK constraint guards us even if a caller skips validation."""
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    # Service strips negatives during dedup — the public method silently
    # drops them rather than raising.
    persisted = await svc.set_reminder_offsets(str(tid), "u1", [-5, 0, 15])
    assert persisted == [0, 15]
    # Direct INSERT with negative offset must hit the CHECK constraint.
    with pytest.raises(sqlite3.IntegrityError):
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO task_reminder_offsets"
                " (task_id, user_id, offset_minutes, created_at)"
                " VALUES (?, ?, ?, '2026-05-19')",
                (str(tid), "u1", -1),
            )


async def test_delete_task_cascades_offsets(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="reminder", title="t", description="", source="chat",
        payload={}, user_id="u1", due_date="2026-05-19", due_time="10:00",
    )
    await svc.set_reminder_offsets(str(tid), "u1", [0, 15, 60])
    affected = await svc.delete_task(tid, user_id="u1")
    assert affected == 1
    leftover = await svc.get_reminder_offsets(str(tid), "u1")
    assert leftover == []


async def test_schema_backfills_existing_tasks(tmp_path: Path) -> None:
    """An existing task with due_time but no offset row should be
    backfilled with offset=0 on migrate()."""
    db = tmp_path / "legacy.sqlite"
    # Simulate a pre-migration DB: create seraphine_tasks then INSERT a
    # row, then run the (new) migrate which should backfill.
    conn = sqlite3.connect(db)
    try:
        # Minimal pre-existing shape — just enough columns for migrate to
        # extend, and a task we can backfill against.
        conn.executescript(
            """
            CREATE TABLE seraphine_tasks (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              type          TEXT NOT NULL,
              status        TEXT NOT NULL DEFAULT 'pending',
              title         TEXT NOT NULL,
              description   TEXT NOT NULL,
              source        TEXT NOT NULL,
              payload       TEXT NOT NULL,
              created_at    TEXT NOT NULL,
              updated_at    TEXT NOT NULL
            );
            INSERT INTO seraphine_tasks
              (type, status, title, description, source, payload,
               created_at, updated_at)
              VALUES ('reminder', 'pending', 'legacy', '', 'chat', '{}',
                      '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
            """
        )
        conn.commit()
    finally:
        conn.close()

    # Now run the canonical migrator + an explicit due_date/due_time
    # update so the backfill criterion matches.
    conn = sqlite3.connect(db)
    try:
        tasks_schema.migrate(conn)
        conn.execute(
            "UPDATE seraphine_tasks"
            " SET due_date = '2026-05-19', due_time = '10:00', user_id = 'u1'"
        )
        conn.commit()
        # Re-run migrate to exercise the backfill (also idempotent on a
        # second pass).
        tasks_schema.migrate(conn)
        rows = conn.execute(
            "SELECT task_id, offset_minutes FROM task_reminder_offsets"
        ).fetchall()
        assert rows == [("1", 0)]
        # Idempotent: a third migrate doesn't duplicate.
        tasks_schema.migrate(conn)
        rows2 = conn.execute(
            "SELECT COUNT(*) FROM task_reminder_offsets"
        ).fetchone()
        assert rows2 == (1,)
    finally:
        conn.close()
