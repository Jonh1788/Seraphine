"""Tests for archive_stale — exercises the 3 tables against the test seed."""

from datetime import datetime, timedelta, timezone

from seraphine.freshness.housekeeping import archive_stale, ArchiveReport
from seraphine.freshness.policy import FreshnessPolicy


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)
POLICY = FreshnessPolicy(stale_days=30)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_archives_old_pending_task_no_due(db):
    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("comprar refrigerante", "pending", None, _iso(NOW - timedelta(days=31))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.tasks_archived == 1
    row = db.execute("SELECT status FROM seraphine_tasks").fetchone()
    assert row["status"] == "archived"


def test_preserves_old_task_with_due_date(db):
    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("reserva Cana Brava", "pending", _iso(NOW + timedelta(days=5)),
         _iso(NOW - timedelta(days=60))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.tasks_archived == 0
    row = db.execute("SELECT status FROM seraphine_tasks").fetchone()
    assert row["status"] == "pending"


def test_preserves_fresh_task(db):
    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("recente", "pending", None, _iso(NOW - timedelta(days=1))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.tasks_archived == 0


def test_preserves_already_done_task(db):
    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("antiga feita", "done", None, _iso(NOW - timedelta(days=60))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.tasks_archived == 0  # only touches pending


def test_archives_old_open_loop(db):
    db.execute(
        "INSERT INTO open_loops(text, created_at) VALUES (?, ?)",
        ("loop velho", _iso(NOW - timedelta(days=31))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.loops_archived == 1
    row = db.execute(
        "SELECT resolved_at, resolution FROM open_loops"
    ).fetchone()
    assert row["resolved_at"] is not None
    assert row["resolution"] == "auto_archived"


def test_preserves_resolved_open_loop(db):
    db.execute(
        "INSERT INTO open_loops(text, created_at, resolved_at, resolution) "
        "VALUES (?, ?, ?, ?)",
        ("antes resolvido", _iso(NOW - timedelta(days=60)), _iso(NOW),
         "manual"),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.loops_archived == 0


def test_archives_old_active_fact(db):
    db.execute(
        "INSERT INTO facts(statement, created_at) VALUES (?, ?)",
        ("usuário mora em Brasília", _iso(NOW - timedelta(days=31))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.facts_archived == 1
    row = db.execute(
        "SELECT superseded_by, archived_at FROM facts"
    ).fetchone()
    assert row["superseded_by"] == -1
    assert row["archived_at"] is not None


def test_idempotent(db):
    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("x", "pending", None, _iso(NOW - timedelta(days=31))),
    )
    db.commit()
    r1 = archive_stale(db, POLICY, now=NOW)
    r2 = archive_stale(db, POLICY, now=NOW)
    assert r1.tasks_archived == 1
    assert r2.tasks_archived == 0  # second pass = no-op


def test_report_counts(db):
    # 3 stale tasks, 2 stale loops, 1 stale fact
    for i in range(3):
        db.execute(
            "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
            "VALUES (?, ?, ?, ?)",
            (f"t{i}", "pending", None, _iso(NOW - timedelta(days=31))),
        )
    for i in range(2):
        db.execute(
            "INSERT INTO open_loops(text, created_at) VALUES (?, ?)",
            (f"l{i}", _iso(NOW - timedelta(days=31))),
        )
    db.execute(
        "INSERT INTO facts(statement, created_at) VALUES (?, ?)",
        ("f", _iso(NOW - timedelta(days=31))),
    )
    db.commit()
    report = archive_stale(db, POLICY, now=NOW)
    assert report.tasks_archived == 3
    assert report.loops_archived == 2
    assert report.facts_archived == 1
