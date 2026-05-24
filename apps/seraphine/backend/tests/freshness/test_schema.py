"""Schema migration tests — verify index + column + idempotency."""

import sqlite3

from seraphine.freshness.schema import migrate


def test_migrate_creates_index(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='index' AND name='idx_tasks_status_due'"
    ).fetchall()
    assert len(rows) == 1


def test_migrate_adds_archived_at_to_facts(db):
    cols = [r[1] for r in db.execute("PRAGMA table_info(facts)").fetchall()]
    assert "archived_at" in cols


def test_migrate_is_idempotent(db):
    # db fixture already ran migrate once; calling again must not raise.
    migrate(db)
    cols = [r[1] for r in db.execute("PRAGMA table_info(facts)").fetchall()]
    assert cols.count("archived_at") == 1  # still exactly one
