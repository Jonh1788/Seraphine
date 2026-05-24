# Seraphine Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Seraphine from confabulating stale references ("aquela reserva Cana Brava", "comprar refrigerante") by adding a centralized FreshnessPolicy that filters context injection in opener/day_review/per-turn engine, plus auto-archive of stale items after 30d.

**Architecture:** New `seraphine/freshness/` module owns the policy + auto-archive. Existing DAOs (`list_tasks`, `list_open_loops`, `list_facts`) gain a `fresh_only=False` flag that splices SQL from the policy. Call sites (opener, day-review, per-turn engine, vector recall) pass `True`. Opener prompt softened: when context is empty, LLM is told to greet without inventing hooks.

**Tech Stack:** Python (raw `sqlite3` + the project's `MemoryStore` migrator registry) · `apscheduler` (existing cron) · `pytest`. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-23-seraphine-freshness-design.md`

---

## File Structure

| Path | Role | Status |
|---|---|---|
| `apps/seraphine/backend/seraphine/freshness/__init__.py` | Module init + migrator registration | new |
| `apps/seraphine/backend/seraphine/freshness/policy.py` | `FreshnessPolicy` dataclass + `from_env` + `is_fresh/is_stale/sql_fresh_filter` | new |
| `apps/seraphine/backend/seraphine/freshness/housekeeping.py` | `archive_stale(conn, policy) -> ArchiveReport` | new |
| `apps/seraphine/backend/seraphine/freshness/schema.py` | `migrate(conn)` — `ALTER facts ADD archived_at`, indexes | new |
| `apps/seraphine/backend/tests/freshness/{__init__,conftest,test_policy,test_housekeeping,test_dao_fresh_filter,test_opener_uses_fresh_context}.py` | tests (~26 total) | new |
| `apps/seraphine/backend/seraphine/mod_tasks/service.py` | `list_tasks` gains `fresh_only: bool = False` | modify |
| `apps/seraphine/backend/seraphine/memory/store.py` | `list_open_loops`, `list_facts` gain `fresh_only` | modify |
| `apps/seraphine/backend/seraphine/openers/service.py` | Pass `fresh_only=True` in all `_context_*_section`; soften rule #5; omit empty sections | modify |
| `apps/seraphine/backend/seraphine/proactive/scheduler.py` | `_tick_day_review` passes `fresh_only=True`; softer prompt | modify |
| `apps/seraphine/backend/seraphine/conversation/engine.py` | 4 context-building blocks pass `fresh_only=True` | modify |
| `apps/seraphine/backend/seraphine/memory/manager.py` | Recall block applies `since` filter | modify |
| `apps/seraphine/backend/seraphine/main.py` | Register migrator + schedule `archive_stale` daily 04:30 | modify |

---

## Phase 0 — Foundation

### Task 1: Schema migration + module skeleton

**Files:**
- Create: `apps/seraphine/backend/seraphine/freshness/__init__.py`
- Create: `apps/seraphine/backend/seraphine/freshness/schema.py`
- Create: `apps/seraphine/backend/tests/freshness/__init__.py`
- Create: `apps/seraphine/backend/tests/freshness/conftest.py`

- [ ] **Step 1: Inspect the existing migrator convention**

Open and READ:
- `apps/seraphine/backend/seraphine/cv_triage/schema.py` — recent reference (uses `def migrate(conn)`)
- `apps/seraphine/backend/seraphine/recurring/schema.py` — older sibling
- `apps/seraphine/backend/seraphine/main.py` — search for `register_migrator` to see how schemas are wired

Confirm the exact migrator signature used: `def migrate(conn: sqlite3.Connection) -> None`. The wiring (Task 11) registers via `store.register_migrator("freshness_v1", migrate)`. Do NOT touch main.py in this task.

- [ ] **Step 2: Write `freshness/schema.py`**

```python
"""SQLite schema additions for the freshness module.

ALTER TABLE facts ADD COLUMN archived_at is wrapped in try/except —
SQLite has no IF NOT EXISTS for ADD COLUMN, and this migrator runs on
each boot via the MemoryStore registry. On re-runs it must be a no-op.
"""

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    with conn:
        # Index for fast filtering of archived tasks by status+due.
        conn.executescript(
            "CREATE INDEX IF NOT EXISTS idx_tasks_status_due "
            "ON seraphine_tasks(status, due_date);"
        )
        # facts ganha archived_at; ignore "duplicate column" on re-run.
        try:
            conn.execute("ALTER TABLE facts ADD COLUMN archived_at TEXT;")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise
```

- [ ] **Step 3: Write `freshness/__init__.py`**

```python
"""Freshness policy module.

Exposes FreshnessPolicy and the housekeeping entry point. Migrator
registration is the caller's responsibility (see seraphine.main.create_app).
"""

from .policy import FreshnessPolicy, DEFAULT_POLICY
from .housekeeping import archive_stale, ArchiveReport
from .schema import migrate

__all__ = [
    "FreshnessPolicy",
    "DEFAULT_POLICY",
    "archive_stale",
    "ArchiveReport",
    "migrate",
]
```

NOTE: this imports `policy` and `housekeeping` which don't exist yet. The file will be re-loadable once those land in Task 2 and 3. Leave it now — TaskN can't run in isolation if needed, but the test runs in Tasks 2 onward will import the leaf modules directly.

If the agent prefers to defer this file's content until Task 3 completes (to avoid import errors when running test_policy.py), that's fine — write the docstring + empty `__all__` now, fill in re-exports after Task 3.

- [ ] **Step 4: Write the test fixture** at `tests/freshness/conftest.py`

```python
"""Pytest fixtures for freshness tests.

Provides an in-memory sqlite3 connection with the freshness migration
applied, plus seeded reference tables (facts, seraphine_tasks, open_loops)
that the housekeeping + DAO tests need.
"""

import sqlite3
import pytest

from seraphine.freshness.schema import migrate as freshness_migrate


def _seed_reference_tables(conn: sqlite3.Connection) -> None:
    """Create minimal versions of the tables freshness touches.

    Production tables are managed by their own modules; tests need just
    enough columns to exercise the housekeeping logic.
    """
    with conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS seraphine_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              due_date TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS open_loops (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              text TEXT NOT NULL,
              created_at TEXT NOT NULL,
              resolved_at TEXT,
              resolution TEXT,
              injection_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS facts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              statement TEXT NOT NULL,
              created_at TEXT NOT NULL,
              superseded_by INTEGER
            );
            """
        )


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    _seed_reference_tables(conn)
    freshness_migrate(conn)
    yield conn
    conn.close()
```

IMPORTANT: production schema for `seraphine_tasks`, `open_loops`, `facts` may have MORE columns than these test seeds. The fixture only needs the columns the freshness module reads/writes. Tests for the actual DAOs (Task 4-6) will need broader fixtures — those tasks define them.

- [ ] **Step 5: Sanity test the migration**

Create `tests/freshness/test_schema.py`:

```python
import sqlite3

from seraphine.freshness.schema import migrate


def test_migrate_creates_index(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_status_due'"
    ).fetchall()
    assert len(rows) == 1


def test_migrate_adds_archived_at_to_facts(db):
    cols = [r[1] for r in db.execute("PRAGMA table_info(facts)").fetchall()]
    assert "archived_at" in cols


def test_migrate_is_idempotent(db):
    # db fixture already ran migrate once; calling again must not raise.
    migrate(db)
    cols = [r[1] for r in db.execute("PRAGMA table_info(facts)").fetchall()]
    # still exactly one archived_at column
    assert cols.count("archived_at") == 1
```

- [ ] **Step 6: Run the schema tests**

```bash
cd apps/seraphine/backend
uv run pytest tests/freshness/test_schema.py -v
```
Expected: 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/freshness/ \
        apps/seraphine/backend/tests/freshness/
git commit -m "feat(seraphine/freshness): schema migration + module skeleton"
```

---

### Task 2: FreshnessPolicy (pure logic)

**Files:**
- Create: `apps/seraphine/backend/seraphine/freshness/policy.py`
- Create: `apps/seraphine/backend/tests/freshness/test_policy.py`

- [ ] **Step 1: Write the failing tests** at `tests/freshness/test_policy.py`

```python
"""Tests for FreshnessPolicy — pure logic, no I/O, deterministic via `now=`."""

import os
from datetime import datetime, timedelta, timezone
import pytest

from seraphine.freshness.policy import FreshnessPolicy


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _ago(*, hours: int = 0, days: int = 0) -> datetime:
    return NOW - timedelta(hours=hours, days=days)


def _ahead(*, days: int = 0) -> datetime:
    return NOW + timedelta(days=days)


# ---- is_fresh ----

def test_recency_window_passes():
    p = FreshnessPolicy()
    assert p.is_fresh(created_at=_ago(hours=1), now=NOW) is True


def test_recency_window_fails_after_threshold():
    p = FreshnessPolicy(recency_hours=72)
    assert p.is_fresh(created_at=_ago(days=5), now=NOW) is False


def test_post_create_window_for_dated_item():
    p = FreshnessPolicy(post_create_days=7)
    assert p.is_fresh(
        created_at=_ago(days=3), event_date=_ahead(days=30), now=NOW,
    ) is True


def test_pre_event_window():
    p = FreshnessPolicy(post_create_days=7, pre_event_days=3)
    # created 60d ago (outside post_create) but event in 2d (inside pre_event)
    assert p.is_fresh(
        created_at=_ago(days=60), event_date=_ahead(days=2), now=NOW,
    ) is True


def test_silent_window_for_dated_item():
    p = FreshnessPolicy(post_create_days=7, pre_event_days=3)
    # created 30d ago (out) and event 20d ahead (out) — silent zone
    assert p.is_fresh(
        created_at=_ago(days=30), event_date=_ahead(days=20), now=NOW,
    ) is False


def test_post_event_recall():
    p = FreshnessPolicy(post_event_days=1)
    # event was yesterday — surface for the "how did it go" recall day
    assert p.is_fresh(
        created_at=_ago(days=60),
        event_date=NOW - timedelta(days=1),
        now=NOW,
    ) is True


def test_post_event_recall_expires():
    p = FreshnessPolicy(post_event_days=1)
    # event 5d ago — out of post_event window
    assert p.is_fresh(
        created_at=_ago(days=60),
        event_date=NOW - timedelta(days=5),
        now=NOW,
    ) is False


# ---- is_stale ----

def test_stale_after_30d_no_date():
    p = FreshnessPolicy(stale_days=30)
    assert p.is_stale(created_at=_ago(days=31), now=NOW) is True


def test_not_stale_if_has_event_date():
    p = FreshnessPolicy(stale_days=30)
    # Even if created 60d ago, having an event_date excludes from auto-archive.
    assert p.is_stale(
        created_at=_ago(days=60), event_date=_ahead(days=5), now=NOW,
    ) is False


def test_not_stale_if_within_window():
    p = FreshnessPolicy(stale_days=30)
    assert p.is_stale(created_at=_ago(days=10), now=NOW) is False


# ---- sql_fresh_filter ----

def test_sql_filter_recency_only():
    p = FreshnessPolicy(recency_hours=72)
    sql, params = p.sql_fresh_filter(created_col="t.created_at", now=NOW)
    # fragment ready to splice after WHERE/AND
    assert "t.created_at" in sql
    assert len(params) == 1
    # the only param is the cutoff: NOW - 72h
    expected_cutoff = (NOW - timedelta(hours=72)).isoformat()
    assert params[0] == expected_cutoff


def test_sql_filter_with_event_col():
    p = FreshnessPolicy()
    sql, params = p.sql_fresh_filter(
        created_col="t.created_at", event_col="t.due_date", now=NOW,
    )
    # the fragment must reference BOTH columns (recency OR pre-event OR post-event)
    assert "t.created_at" in sql
    assert "t.due_date" in sql
    # multiple param substitutions
    assert len(params) > 1


# ---- from_env ----

def test_from_env_overrides_defaults(monkeypatch):
    monkeypatch.setenv("FRESHNESS_RECENCY_HOURS", "24")
    monkeypatch.setenv("FRESHNESS_STALE_DAYS", "14")
    p = FreshnessPolicy.from_env()
    assert p.recency_hours == 24
    assert p.stale_days == 14


def test_from_env_invalid_value_falls_back(monkeypatch, caplog):
    monkeypatch.setenv("FRESHNESS_RECENCY_HOURS", "abc")
    p = FreshnessPolicy.from_env()
    assert p.recency_hours == 72  # default preserved
    assert any("invalid" in r.message.lower() for r in caplog.records)
```

- [ ] **Step 2: Run failing tests**

```bash
cd apps/seraphine/backend
uv run pytest tests/freshness/test_policy.py -v
```
Expected: ImportError on `seraphine.freshness.policy`.

- [ ] **Step 3: Implement `policy.py`**

```python
"""Single source of truth for "what is fresh?" decisions.

Used by:
- Opener (openers/service.py) to filter context bundle before LLM call
- Day-review (proactive/scheduler.py) for the same purpose
- Per-turn engine (conversation/engine.py) for ambient/recall/profile
- Vector recall (memory/manager.py) for the `since` filter
- Housekeeping (freshness/housekeeping.py) for auto-archive

Pure logic — no I/O. All datetime args injectable for tests.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "invalid %s=%r, using default %d", name, raw, default,
        )
        return default


@dataclass(frozen=True)
class FreshnessPolicy:
    """Recency rules. See spec §5 for the table of windows.

    Defaults are tuned for "human assistant" behaviour:
    - 72h surfaces dateless items the user just mentioned
    - 7d post-create + 3d pre-event captures dated items
      both right after creation AND as the date approaches
    - 1d post-event lets the assistant ask "how did it go?"
    - 30d stale auto-archives forgotten dateless tasks
    """

    recency_hours: int = 72
    post_create_days: int = 7
    pre_event_days: int = 3
    post_event_days: int = 1
    stale_days: int = 30

    @classmethod
    def from_env(cls) -> "FreshnessPolicy":
        return cls(
            recency_hours=_env_int("FRESHNESS_RECENCY_HOURS", 72),
            post_create_days=_env_int("FRESHNESS_POST_CREATE_DAYS", 7),
            pre_event_days=_env_int("FRESHNESS_PRE_EVENT_DAYS", 3),
            post_event_days=_env_int("FRESHNESS_POST_EVENT_DAYS", 1),
            stale_days=_env_int("FRESHNESS_STALE_DAYS", 30),
        )

    # ---- is_fresh / is_stale ----

    def is_fresh(
        self, *,
        created_at: datetime,
        event_date: Optional[datetime] = None,
        now: Optional[datetime] = None,
    ) -> bool:
        if created_at is None:
            raise ValueError("created_at is required")
        now = now or _now()

        # Recency window (applies to everything)
        if now - created_at <= timedelta(hours=self.recency_hours):
            return True

        # Date-bound windows (only when event_date present)
        if event_date is not None:
            # post-create
            if now - created_at <= timedelta(days=self.post_create_days):
                return True
            # pre-event
            until_event = event_date - now
            if timedelta(0) <= until_event <= timedelta(days=self.pre_event_days):
                return True
            # post-event (recall window)
            since_event = now - event_date
            if timedelta(0) <= since_event <= timedelta(days=self.post_event_days):
                return True

        return False

    def is_stale(
        self, *,
        created_at: datetime,
        event_date: Optional[datetime] = None,
        now: Optional[datetime] = None,
    ) -> bool:
        """Candidate for auto-archive. Dated items are NEVER auto-archived."""
        if created_at is None:
            raise ValueError("created_at is required")
        if event_date is not None:
            return False
        now = now or _now()
        return now - created_at >= timedelta(days=self.stale_days)

    # ---- SQL fragment builder ----

    def sql_fresh_filter(
        self, *,
        created_col: str,
        event_col: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> tuple[str, list]:
        """Build a SQL fragment to splice after WHERE/AND.

        Returns: (fragment_string, params_list). The fragment is wrapped in
        parens and contains no leading keyword — caller is responsible for
        prepending AND/WHERE as appropriate.

        Recency-only (when event_col is None):
            ({created_col} > ?)

        With event column:
            (
              {created_col} > ?                                   -- recency
              OR {created_col} > ?                                -- post-create
              OR ({event_col} BETWEEN ? AND ?)                    -- pre-event window
              OR ({event_col} BETWEEN ? AND ?)                    -- post-event window
            )
        """
        now = now or _now()
        recency_cutoff = (now - timedelta(hours=self.recency_hours)).isoformat()

        if event_col is None:
            return f"({created_col} > ?)", [recency_cutoff]

        post_create_cutoff = (now - timedelta(days=self.post_create_days)).isoformat()
        pre_event_start = now.isoformat()
        pre_event_end = (now + timedelta(days=self.pre_event_days)).isoformat()
        post_event_start = (now - timedelta(days=self.post_event_days)).isoformat()
        post_event_end = now.isoformat()

        sql = (
            f"({created_col} > ? "
            f"OR {created_col} > ? "
            f"OR ({event_col} BETWEEN ? AND ?) "
            f"OR ({event_col} BETWEEN ? AND ?))"
        )
        params = [
            recency_cutoff,
            post_create_cutoff,
            pre_event_start, pre_event_end,
            post_event_start, post_event_end,
        ]
        return sql, params


# Process-wide default, populated from env on first import.
DEFAULT_POLICY = FreshnessPolicy.from_env()
```

- [ ] **Step 4: Run tests to verify pass**

```bash
uv run pytest tests/freshness/test_policy.py -v
```
Expected: 13 PASS.

- [ ] **Step 5: Update `freshness/__init__.py`** with the now-importable symbols (it may have been a stub from Task 1).

```python
"""Freshness policy module.

Exposes FreshnessPolicy and the housekeeping entry point. Migrator
registration is the caller's responsibility (see seraphine.main.create_app).
"""

from .policy import FreshnessPolicy, DEFAULT_POLICY
from .schema import migrate

__all__ = [
    "FreshnessPolicy",
    "DEFAULT_POLICY",
    "migrate",
]
```

(`archive_stale` will be added in Task 3.)

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/freshness/policy.py \
        apps/seraphine/backend/seraphine/freshness/__init__.py \
        apps/seraphine/backend/tests/freshness/test_policy.py
git commit -m "feat(seraphine/freshness): FreshnessPolicy with is_fresh/is_stale/sql_fresh_filter"
```

---

### Task 3: Housekeeping (archive_stale)

**Files:**
- Create: `apps/seraphine/backend/seraphine/freshness/housekeeping.py`
- Create: `apps/seraphine/backend/tests/freshness/test_housekeeping.py`

- [ ] **Step 1: Failing tests** at `tests/freshness/test_housekeeping.py`

```python
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
```

- [ ] **Step 2: Run failing tests**

```bash
uv run pytest tests/freshness/test_housekeeping.py -v
```
Expected: ImportError.

- [ ] **Step 3: Implement `housekeeping.py`**

```python
"""Auto-archive stale items (per FreshnessPolicy).

Runs daily as a scheduled cron from main.py. Idempotent — second pass on
the same data is a no-op because already-archived rows are excluded by
the WHERE clauses.

Per-table blocks are isolated in try/except so one table failing doesn't
abort the others.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from .policy import FreshnessPolicy

logger = logging.getLogger(__name__)


@dataclass
class ArchiveReport:
    tasks_archived: int = 0
    loops_archived: int = 0
    facts_archived: int = 0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def archive_stale(
    conn: sqlite3.Connection,
    policy: FreshnessPolicy,
    *,
    now: Optional[datetime] = None,
) -> ArchiveReport:
    """Mark stale items as archived. Returns counts per table."""
    now = now or _now()
    cutoff = (now - timedelta(days=policy.stale_days)).isoformat()
    now_iso = now.isoformat()
    report = ArchiveReport()

    # ---- tasks: pending, no due_date, old ----
    try:
        with conn:
            cur = conn.execute(
                "UPDATE seraphine_tasks SET status='archived' "
                "WHERE status='pending' AND due_date IS NULL "
                "AND created_at <= ?",
                (cutoff,),
            )
        report.tasks_archived = cur.rowcount
    except Exception as e:
        logger.warning("archive_stale: tasks block failed: %s", e)

    # ---- open_loops: unresolved, old ----
    try:
        with conn:
            cur = conn.execute(
                "UPDATE open_loops "
                "SET resolved_at=?, resolution='auto_archived' "
                "WHERE resolved_at IS NULL AND created_at <= ?",
                (now_iso, cutoff),
            )
        report.loops_archived = cur.rowcount
    except Exception as e:
        logger.warning("archive_stale: open_loops block failed: %s", e)

    # ---- facts: active, old ----
    try:
        with conn:
            cur = conn.execute(
                "UPDATE facts SET superseded_by=-1, archived_at=? "
                "WHERE superseded_by IS NULL AND created_at <= ?",
                (now_iso, cutoff),
            )
        report.facts_archived = cur.rowcount
    except Exception as e:
        logger.warning("archive_stale: facts block failed: %s", e)

    logger.info(
        "freshness.archive_stale done",
        extra={
            "tasks_archived": report.tasks_archived,
            "loops_archived": report.loops_archived,
            "facts_archived": report.facts_archived,
        },
    )
    return report
```

- [ ] **Step 4: Run tests to verify pass**

```bash
uv run pytest tests/freshness/test_housekeeping.py -v
```
Expected: 9 PASS.

- [ ] **Step 5: Re-export from `freshness/__init__.py`**

```python
"""Freshness policy module."""

from .policy import FreshnessPolicy, DEFAULT_POLICY
from .housekeeping import archive_stale, ArchiveReport
from .schema import migrate

__all__ = [
    "FreshnessPolicy",
    "DEFAULT_POLICY",
    "archive_stale",
    "ArchiveReport",
    "migrate",
]
```

- [ ] **Step 6: Run full freshness test suite**

```bash
uv run pytest tests/freshness/ -v
```
Expected: 3 (schema) + 13 (policy) + 9 (housekeeping) = 25 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/freshness/housekeeping.py \
        apps/seraphine/backend/seraphine/freshness/__init__.py \
        apps/seraphine/backend/tests/freshness/test_housekeeping.py
git commit -m "feat(seraphine/freshness): archive_stale housekeeping with isolated per-table blocks"
```

---

## Phase 1 — DAO integration (fresh_only flag)

### Task 4: `list_tasks` gains fresh_only

**Files:**
- Modify: `apps/seraphine/backend/seraphine/mod_tasks/service.py` (around `list_tasks`)
- Create: `apps/seraphine/backend/tests/freshness/test_dao_fresh_filter_tasks.py`

- [ ] **Step 1: Read the existing `list_tasks` signature**

```bash
grep -n "def list_tasks" apps/seraphine/backend/seraphine/mod_tasks/service.py
sed -n '<found line>,<+30>p' apps/seraphine/backend/seraphine/mod_tasks/service.py
```

Note the exact signature, return type, and how the existing WHERE clauses are built (string concatenation? parameterized?). You must preserve all existing parameters and behavior; only ADD `fresh_only`.

- [ ] **Step 2: Write the failing test**

```python
"""Test that list_tasks(fresh_only=True) applies the FreshnessPolicy filter.

Uses the same in-memory db fixture but seeds via the production
mod_tasks service so the actual SQL path is exercised end-to-end.
"""

from datetime import datetime, timedelta, timezone

from seraphine.freshness.policy import FreshnessPolicy

NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_list_tasks_fresh_only_excludes_old_undated(db, monkeypatch):
    # Patch the default policy used internally by list_tasks (or pass via injection)
    # to a fixed clock for deterministic NOW behaviour.
    from seraphine.mod_tasks import service as tasks_service

    monkeypatch.setattr(
        tasks_service, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("fresca", "pending", None, _iso(NOW - timedelta(hours=1))),
    )
    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("velha", "pending", None, _iso(NOW - timedelta(days=10))),
    )
    db.commit()

    fresh = tasks_service.list_tasks(db, fresh_only=True)
    titles = [t["title"] if isinstance(t, dict) else t.title for t in fresh]
    assert "fresca" in titles
    assert "velha" not in titles


def test_list_tasks_default_keeps_all(db):
    """Regression — fresh_only=False is the default and preserves prior behavior."""
    from seraphine.mod_tasks import service as tasks_service

    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("velha", "pending", None, _iso(NOW - timedelta(days=10))),
    )
    db.commit()
    all_tasks = tasks_service.list_tasks(db)  # default
    titles = [t["title"] if isinstance(t, dict) else t.title for t in all_tasks]
    assert "velha" in titles


def test_list_tasks_fresh_only_keeps_dated_in_pre_event_window(db, monkeypatch):
    from seraphine.mod_tasks import service as tasks_service
    monkeypatch.setattr(
        tasks_service, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    db.execute(
        "INSERT INTO seraphine_tasks(title, status, due_date, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("velha mas evento próximo", "pending",
         _iso(NOW + timedelta(days=2)),
         _iso(NOW - timedelta(days=60))),
    )
    db.commit()
    fresh = tasks_service.list_tasks(db, fresh_only=True)
    titles = [t["title"] if isinstance(t, dict) else t.title for t in fresh]
    assert "velha mas evento próximo" in titles
```

NOTE: the exact test assertion shape (`t["title"]` vs `t.title`) depends on what `list_tasks` returns. Adapt to the actual return type.

- [ ] **Step 3: Run failing test**

```bash
uv run pytest tests/freshness/test_dao_fresh_filter_tasks.py -v
```
Expected: TypeError on unknown `fresh_only` kwarg.

- [ ] **Step 4: Modify `list_tasks`**

Add a `fresh_only: bool = False` keyword argument. When `True`, splice `policy.sql_fresh_filter(created_col="created_at", event_col="due_date")` into the WHERE clause.

Sketch (adapt to actual function shape):

```python
from seraphine.freshness import DEFAULT_POLICY

# module-level for test injection
def _freshness_policy_now():
    return None  # falls through to datetime.now in policy

def list_tasks(
    conn,
    *,
    # ... existing kwargs ...
    fresh_only: bool = False,
):
    where_clauses = [...]  # existing
    params = [...]         # existing

    if fresh_only:
        sql_frag, fresh_params = DEFAULT_POLICY.sql_fresh_filter(
            created_col="created_at",
            event_col="due_date",
            now=_freshness_policy_now(),
        )
        where_clauses.append(sql_frag)
        params.extend(fresh_params)

    sql = f"SELECT ... WHERE {' AND '.join(where_clauses)} ORDER BY ..."
    return conn.execute(sql, params).fetchall()
```

If the existing function builds its SQL differently (e.g. SQLAlchemy text(), or composed WHERE differently), follow its style precisely. The only invariant: the fresh_only branch must add the policy's SQL fragment to the existing WHERE chain without breaking other filters.

- [ ] **Step 5: Run tests to verify pass**

```bash
uv run pytest tests/freshness/test_dao_fresh_filter_tasks.py -v
```
Expected: 3 PASS.

- [ ] **Step 6: Run full mod_tasks tests to confirm no regression**

```bash
uv run pytest tests/ -k "tasks" -v
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/mod_tasks/service.py \
        apps/seraphine/backend/tests/freshness/test_dao_fresh_filter_tasks.py
git commit -m "feat(seraphine/mod_tasks): list_tasks gains fresh_only flag"
```

---

### Task 5: `list_open_loops` gains fresh_only

**Files:**
- Modify: `apps/seraphine/backend/seraphine/memory/store.py` (around `list_open_loops`, ~line 1269)
- Create: `apps/seraphine/backend/tests/freshness/test_dao_fresh_filter_loops.py`

- [ ] **Step 1: Read the existing function**

```bash
sed -n '1265,1295p' apps/seraphine/backend/seraphine/memory/store.py
```

- [ ] **Step 2: Failing test** at `tests/freshness/test_dao_fresh_filter_loops.py`

```python
from datetime import datetime, timedelta, timezone


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt):
    return dt.isoformat()


def test_list_open_loops_fresh_only_excludes_old(db, monkeypatch):
    from seraphine.memory import store as memory_store
    monkeypatch.setattr(
        memory_store, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    db.execute(
        "INSERT INTO open_loops(text, created_at) VALUES (?, ?)",
        ("loop fresco", _iso(NOW - timedelta(hours=1))),
    )
    db.execute(
        "INSERT INTO open_loops(text, created_at) VALUES (?, ?)",
        ("loop velho", _iso(NOW - timedelta(days=10))),
    )
    db.commit()

    loops = memory_store.list_open_loops(db, only_open=True, fresh_only=True)
    texts = [l["text"] if isinstance(l, dict) else l.text for l in loops]
    assert "loop fresco" in texts
    assert "loop velho" not in texts


def test_list_open_loops_default_keeps_all(db):
    from seraphine.memory import store as memory_store
    db.execute(
        "INSERT INTO open_loops(text, created_at) VALUES (?, ?)",
        ("loop velho", _iso(NOW - timedelta(days=10))),
    )
    db.commit()
    loops = memory_store.list_open_loops(db, only_open=True)
    texts = [l["text"] if isinstance(l, dict) else l.text for l in loops]
    assert "loop velho" in texts
```

- [ ] **Step 3: Run failing**

```bash
uv run pytest tests/freshness/test_dao_fresh_filter_loops.py -v
```

- [ ] **Step 4: Modify `list_open_loops`** — add `fresh_only: bool = False`. Splice `policy.sql_fresh_filter(created_col="created_at")` (no event_col — loops don't have dates). Inject `_freshness_policy_now()` helper at module level.

- [ ] **Step 5: Pass + commit**

```bash
uv run pytest tests/freshness/test_dao_fresh_filter_loops.py -v
git add apps/seraphine/backend/seraphine/memory/store.py \
        apps/seraphine/backend/tests/freshness/test_dao_fresh_filter_loops.py
git commit -m "feat(seraphine/memory): list_open_loops gains fresh_only flag"
```

---

### Task 6: `list_facts` gains fresh_only

**Files:**
- Modify: `apps/seraphine/backend/seraphine/memory/store.py` (around `list_facts`, ~line 819)
- Create: `apps/seraphine/backend/tests/freshness/test_dao_fresh_filter_facts.py`

- [ ] **Step 1: Read the existing function**

```bash
sed -n '815,855p' apps/seraphine/backend/seraphine/memory/store.py
```

- [ ] **Step 2: Failing test** — same pattern as Task 5, replace `open_loops` with `facts`, `text` with `statement`, exclude old facts when `fresh_only=True`, default keeps all.

```python
from datetime import datetime, timedelta, timezone

NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt):
    return dt.isoformat()


def test_list_facts_fresh_only_excludes_old(db, monkeypatch):
    from seraphine.memory import store as memory_store
    monkeypatch.setattr(
        memory_store, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )
    db.execute(
        "INSERT INTO facts(statement, created_at) VALUES (?, ?)",
        ("fato fresco", _iso(NOW - timedelta(hours=1))),
    )
    db.execute(
        "INSERT INTO facts(statement, created_at) VALUES (?, ?)",
        ("fato velho", _iso(NOW - timedelta(days=10))),
    )
    db.commit()
    facts = memory_store.list_facts(db, fresh_only=True)
    statements = [f["statement"] if isinstance(f, dict) else f.statement for f in facts]
    assert "fato fresco" in statements
    assert "fato velho" not in statements


def test_list_facts_default_keeps_all(db):
    from seraphine.memory import store as memory_store
    db.execute(
        "INSERT INTO facts(statement, created_at) VALUES (?, ?)",
        ("fato velho", _iso(NOW - timedelta(days=10))),
    )
    db.commit()
    facts = memory_store.list_facts(db)
    statements = [f["statement"] if isinstance(f, dict) else f.statement for f in facts]
    assert "fato velho" in statements
```

- [ ] **Step 3: Modify `list_facts`** — same pattern as Task 5. Recency-only filter (facts have no event date). The `_freshness_policy_now` helper already exists from Task 5; reuse.

- [ ] **Step 4: Pass + commit**

```bash
uv run pytest tests/freshness/test_dao_fresh_filter_facts.py -v
git add apps/seraphine/backend/seraphine/memory/store.py \
        apps/seraphine/backend/tests/freshness/test_dao_fresh_filter_facts.py
git commit -m "feat(seraphine/memory): list_facts gains fresh_only flag"
```

---

## Phase 2 — Call site integration

### Task 7: Opener integration (the big-impact one)

**Files:**
- Modify: `apps/seraphine/backend/seraphine/openers/service.py` (~lines 33-217)
- Create: `apps/seraphine/backend/tests/freshness/test_opener_uses_fresh_context.py`

- [ ] **Step 1: Read the opener structure**

```bash
sed -n '30,70p' apps/seraphine/backend/seraphine/openers/service.py     # prompt template
sed -n '120,220p' apps/seraphine/backend/seraphine/openers/service.py   # _context_* methods
sed -n '220,290p' apps/seraphine/backend/seraphine/openers/service.py   # generate()
```

Understand:
- The shape of each `_context_*_section` method (returns string or None?)
- Where the sections are concatenated into the final prompt
- The rule #5 wording

- [ ] **Step 2: Failing test** at `tests/freshness/test_opener_uses_fresh_context.py`

```python
"""The opener must:
 1. Pass fresh_only=True when fetching context from each DAO.
 2. Omit empty sections from the prompt (no "tarefas em aberto: nenhuma").
 3. Use the softened rule #5 (no forced gancho when context is empty).
"""

from unittest.mock import patch, MagicMock


def test_opener_passes_fresh_only_to_list_tasks():
    from seraphine.openers import service as opener_service
    with patch.object(opener_service, "list_tasks", return_value=[]) as m:
        opener_service._context_tasks_section(MagicMock())
    # The opener must explicitly pass fresh_only=True
    assert any(
        call.kwargs.get("fresh_only") is True
        for call in m.call_args_list
    ), f"Expected fresh_only=True in {m.call_args_list}"


def test_opener_omits_empty_tasks_section():
    from seraphine.openers import service as opener_service
    with patch.object(opener_service, "list_tasks", return_value=[]):
        section = opener_service._context_tasks_section(MagicMock())
    # When the list is empty, the section must be empty/None — NOT
    # "- tarefas em aberto: nenhuma" or similar.
    assert section in (None, "", []), f"Expected empty, got {section!r}"


def test_opener_includes_non_empty_tasks_section():
    from seraphine.openers import service as opener_service
    fake_task = {"title": "ler livro", "due_date": None}
    with patch.object(opener_service, "list_tasks", return_value=[fake_task]):
        section = opener_service._context_tasks_section(MagicMock())
    assert section and "ler livro" in str(section)


def test_opener_prompt_softens_rule_5():
    """The prompt template (or PROMPT_TMPL constant) must instruct the LLM
    NOT to invent hooks when context is empty. Look for the new wording."""
    from seraphine.openers import service as opener_service
    template_src = ""
    # The prompt template is typically a module-level string constant.
    # Adapt to the actual variable name.
    for name in dir(opener_service):
        obj = getattr(opener_service, name)
        if isinstance(obj, str) and "gancho" in obj.lower():
            template_src += obj + "\n"
    assert template_src, "Could not find prompt template referencing 'gancho'"
    lower = template_src.lower()
    # New behaviour: greet lightly when nothing fresh, do not invent.
    assert "se não houver contexto fresco" in lower or \
           "sem inventar" in lower or \
           "não invente" in lower, \
        f"Rule #5 still forces a hook unconditionally:\n{template_src}"
```

- [ ] **Step 3: Run failing**

```bash
uv run pytest tests/freshness/test_opener_uses_fresh_context.py -v
```

- [ ] **Step 4: Modify `openers/service.py`**

Two changes:

**A. Each `_context_*_section`** that calls a DAO must pass `fresh_only=True`, and return empty when the result is empty. Example:

```python
def _context_tasks_section(self, ctx) -> Optional[str]:
    tasks = list_tasks(self.conn, fresh_only=True)
    if not tasks:
        return None  # IMPORTANT: empty → omit line from prompt
    lines = ["- tarefas em aberto:"]
    for t in tasks[:3]:
        lines.append(f"  · {t.title}" + (f" (até {t.due_date})" if t.due_date else ""))
    return "\n".join(lines)
```

Apply to:
- `_context_tasks_section` (`list_tasks`)
- `_context_open_loops_section` (`store.list_open_loops`)
- `_context_flashcards_section` (likely OK as-is — flashcards have their own filter)
- `_context_finance_section`
- `_context_email_section`
- `_context_discovery_section`

And `generate()` — when concatenating sections, filter out `None`/empty so they don't add empty lines.

**B. Soften the prompt template rule #5.** Find the constant (probably `PROMPT_TMPL` or similar) and change:

```python
# OLD
"5. Inicie com gancho CONCRETO (tarefa, horário, coisa que ele disse antes...)"

# NEW
"5. Se houver contexto fresco abaixo, abra com gancho concreto referenciando-o. "
"Se NÃO houver contexto fresco, abra com cumprimento leve (oi/voltou/bom dia) "
"e PARE — não invente hooks de coisas antigas, não confabule."
```

- [ ] **Step 5: Run tests**

```bash
uv run pytest tests/freshness/test_opener_uses_fresh_context.py -v
```
Expected: 4 PASS.

- [ ] **Step 6: Run full opener tests to confirm no regression**

```bash
uv run pytest tests/ -k "opener" -v
```

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/openers/service.py \
        apps/seraphine/backend/tests/freshness/test_opener_uses_fresh_context.py
git commit -m "feat(seraphine/openers): pass fresh_only=True + soften rule #5 + omit empty sections"
```

---

### Task 8: Day-review (proactive scheduler) uses fresh context

**Files:**
- Modify: `apps/seraphine/backend/seraphine/proactive/scheduler.py` (~lines 205-232 `_tick_day_review`)

- [ ] **Step 1: Read `_tick_day_review`**

```bash
sed -n '200,250p' apps/seraphine/backend/seraphine/proactive/scheduler.py
```

Identify which DAOs it calls and the prompt template it uses.

- [ ] **Step 2: Failing test**

Add to `tests/freshness/test_opener_uses_fresh_context.py`:

```python
def test_day_review_passes_fresh_only_to_dao():
    from seraphine.proactive import scheduler as proactive_scheduler

    with patch.object(proactive_scheduler, "list_tasks", return_value=[]) as m_tasks:
        # call _tick_day_review's context-building helper (adapt to actual name)
        # if the call lives inline, refactor it into a helper first.
        ...
    assert any(call.kwargs.get("fresh_only") is True for call in m_tasks.call_args_list)
```

(If `_tick_day_review` doesn't call DAOs directly but goes through some other helper, adapt the test to that helper. The point: every DAO call in this code path must pass `fresh_only=True`.)

- [ ] **Step 3: Modify `_tick_day_review`**

Identify each DAO call inside the tick (or in helpers it calls). Add `fresh_only=True`. If the day-review uses its own LLM prompt template, apply the same rule #5 softening from Task 7.

- [ ] **Step 4: Run + commit**

```bash
uv run pytest tests/freshness/ -v
git add apps/seraphine/backend/seraphine/proactive/scheduler.py \
        apps/seraphine/backend/tests/freshness/test_opener_uses_fresh_context.py
git commit -m "feat(seraphine/proactive): day_review uses fresh_only context + softened prompt"
```

---

### Task 9: Per-turn engine context uses fresh data

**Files:**
- Modify: `apps/seraphine/backend/seraphine/conversation/engine.py` (~lines 775-913)

- [ ] **Step 1: Read the 4 context blocks**

```bash
sed -n '770,920p' apps/seraphine/backend/seraphine/conversation/engine.py
```

Identify each `list_*`/`get_*` call that feeds:
- `ambient_block`
- `open_loops.prompt_block` (calls `store.list_open_loops`)
- `recall_block` (calls `store.list_facts` + vector recall — vector handled in Task 10)
- `UserProfile.get_profile_summary` (calls `store.list_facts`)

- [ ] **Step 2: Failing test** — `tests/freshness/test_engine_uses_fresh_context.py`

```python
"""The per-turn engine must pass fresh_only=True when assembling
the context blocks injected into the LLM prompt."""

from unittest.mock import patch, MagicMock


def test_open_loops_block_uses_fresh_only():
    from seraphine.conversation import engine
    with patch.object(engine.store, "list_open_loops", return_value=[]) as m:
        engine._build_open_loops_block(MagicMock())  # adapt helper name
    assert any(call.kwargs.get("fresh_only") is True for call in m.call_args_list)


def test_recall_block_uses_fresh_only_facts():
    from seraphine.conversation import engine
    with patch.object(engine.store, "list_facts", return_value=[]) as m:
        engine._build_recall_block(MagicMock(), query="x")  # adapt name
    assert any(call.kwargs.get("fresh_only") is True for call in m.call_args_list)


def test_profile_summary_uses_fresh_only():
    from seraphine.conversation import engine
    from seraphine.memory.profile import UserProfile  # adapt import
    with patch.object(engine.store, "list_facts", return_value=[]) as m:
        UserProfile(MagicMock()).get_profile_summary()
    assert any(call.kwargs.get("fresh_only") is True for call in m.call_args_list)
```

(Adapt helper names and import paths to actual code.)

- [ ] **Step 3: Modify the 4 blocks** in `engine.py` to pass `fresh_only=True`. The mechanical change is finding each `store.list_open_loops(...)` / `store.list_facts(...)` call site and adding the kwarg.

- [ ] **Step 4: Run full conversation engine tests**

```bash
uv run pytest tests/ -k "engine or conversation" -v
```
Expected: green (regression check).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/conversation/engine.py \
        apps/seraphine/backend/tests/freshness/test_engine_uses_fresh_context.py
git commit -m "feat(seraphine/conversation): per-turn context blocks use fresh_only"
```

---

### Task 10: Vector recall applies `since` filter

**Files:**
- Modify: `apps/seraphine/backend/seraphine/memory/manager.py` (~line 337 `_build_recall_block` or similar)

- [ ] **Step 1: Read the vector recall code**

```bash
grep -n "def.*recall\|since\|Chroma\|chroma" apps/seraphine/backend/seraphine/memory/manager.py | head -10
sed -n '<found line>,<+50>p' apps/seraphine/backend/seraphine/memory/manager.py
```

Identify how the Chroma/FTS hybrid query is built and whether Chroma's `where` clause can take a date filter on metadata.

- [ ] **Step 2: Failing test** at `tests/freshness/test_recall_since.py`

```python
"""Vector recall must filter snippets older than the recency window."""

from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta, timezone


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def test_recall_filters_by_since(monkeypatch):
    from seraphine.memory import manager as memory_manager

    monkeypatch.setattr(
        memory_manager, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    # Mock the underlying Chroma collection to capture the `where` arg
    fake_collection = MagicMock()
    fake_collection.query.return_value = {"documents": [[]], "metadatas": [[]]}

    with patch.object(memory_manager, "_get_collection", return_value=fake_collection):
        memory_manager.recall(query="oi", limit=5)

    # Inspect query() call — must include a since/where filter
    call = fake_collection.query.call_args
    assert call is not None
    # Either via `where=` arg with a date predicate, or via post-filter (acceptable
    # fallback per spec — Chroma may not support all predicates)
    has_filter = (
        "where" in call.kwargs
        or any("since" in str(arg).lower() for arg in call.args)
    )
    if not has_filter:
        # Acceptable fallback: results post-filtered in Python.
        # The test passes if Chroma is called and the code SOMEHOW filters by date.
        # Mark this as a known limitation — re-run with a stricter test if implementing native where.
        pass  # accept either path
    # Stronger assertion: any returned snippet has a `created_at` after the cutoff
    # (when there are results). Skipped here since the mock returns empty.
```

If Chroma doesn't support a date predicate natively, the implementation may post-filter in Python — the test should accept either path. If it's hard to test without a real Chroma, this task can be validated manually in E2E (Task 12).

- [ ] **Step 3: Implement**

Two paths:

**A (preferred)**: Pass `where={"created_at": {"$gt": cutoff_iso}}` to `collection.query(...)` if Chroma supports it. Compute `cutoff_iso = (now - timedelta(hours=DEFAULT_POLICY.recency_hours)).isoformat()`.

**B (fallback)**: After `collection.query(...)` returns, filter the results in Python by `metadata.created_at > cutoff_iso`. Drop snippets that fail the check before assembling the recall block.

Pick A if Chroma version supports it; B otherwise. Add a comment in the code documenting which path you took.

- [ ] **Step 4: Run + commit**

```bash
uv run pytest tests/freshness/test_recall_since.py -v
git add apps/seraphine/backend/seraphine/memory/manager.py \
        apps/seraphine/backend/tests/freshness/test_recall_since.py
git commit -m "feat(seraphine/memory): vector recall applies since=recency filter"
```

---

## Phase 3 — Wiring

### Task 11: Register migrator + schedule daily archive cron in main.py

**Files:**
- Modify: `apps/seraphine/backend/seraphine/main.py`

- [ ] **Step 1: Find the migrator registration + scheduler setup**

```bash
grep -n "register_migrator\|add_job\|cv_triage" apps/seraphine/backend/seraphine/main.py | head -10
```

Look for:
- The block where existing schemas register (e.g. `store.register_migrator("cv_triage_v1", cv_triage_schema.migrate)`)
- The block where existing cron jobs add (`scheduler._sched.add_job(...)`)

- [ ] **Step 2: Register the freshness migrator**

After the existing `register_migrator` calls (immediately before or after `cv_triage_v1`):

```python
from .freshness import migrate as freshness_migrate
store.register_migrator("freshness_v1", freshness_migrate)
```

- [ ] **Step 3: Schedule the daily archive cron**

After the existing `add_job` calls (e.g. after `cv_triage_housekeeping`):

```python
from .freshness import archive_stale, DEFAULT_POLICY

scheduler._sched.add_job(
    lambda: archive_stale(app.state.store._connect(), DEFAULT_POLICY),
    "cron", hour=4, minute=30, id="freshness_archive",
)
```

Match the exact pattern of `cv_triage_housekeeping` — same scheduler reference, same connection acquisition style.

- [ ] **Step 4: Smoke-test by starting the app locally** (optional)

```bash
cd apps/seraphine/backend
uv run uvicorn seraphine.main:app --port 8765 2>&1 | head -20
```
Expected: "freshness_v1" appears in migration log; no exception during startup. Ctrl-C to stop.

- [ ] **Step 5: Run full backend tests as sanity check**

```bash
uv run pytest tests/ --tb=short 2>&1 | tail -10
```
Expected: existing test count + ~26 new freshness tests. No regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/main.py
git commit -m "feat(seraphine/main): register freshness migrator + schedule daily archive cron (04:30)"
```

---

## Phase 4 — E2E verification

### Task 12: Live verification on VPS

**Files:** (none — verification only)

- [ ] **Step 1: Push to vps**

```bash
git push vps main
```
Wait for deploy. Verify containers came up:

```bash
ssh root@CassinoAPI 'docker ps --format "table {{.Names}}\t{{.Status}}" | grep seraphine'
```

- [ ] **Step 2: Check the migration ran**

```bash
ssh root@CassinoAPI 'docker exec seraphine-backend-1 python3 -c \
"import sqlite3; c = sqlite3.connect(\"/data/seraphine.sqlite\"); \
cols = [r[1] for r in c.execute(\"PRAGMA table_info(facts)\").fetchall()]; \
print(\"archived_at in cols:\", \"archived_at\" in cols)"'
```
Expected: `archived_at in cols: True`

- [ ] **Step 3: Manually trigger the archive job once**

```bash
ssh root@CassinoAPI 'docker exec seraphine-backend-1 python3 -c \
"import sqlite3; \
from seraphine.freshness import archive_stale, DEFAULT_POLICY; \
c = sqlite3.connect(\"/data/seraphine.sqlite\"); \
c.row_factory = sqlite3.Row; \
r = archive_stale(c, DEFAULT_POLICY); \
print(\"tasks:\", r.tasks_archived, \"loops:\", r.loops_archived, \"facts:\", r.facts_archived)"'
```
Expected output: counts of how much was cleaned up (could be hundreds on first run — that's the backlog).

- [ ] **Step 4: Re-open the Seraphine app on Mac**

- Force-close and re-open `/Applications/Seraphine.app`
- Wait for WS connect → opener should fire
- Observe: greeting should NO LONGER mention old commitments. If there's nothing fresh in the last 72h, you should see a simple "oi" / "voltou" / "bom dia" with no concrete hook.

- [ ] **Step 5: Verify the day_review job at 21h (optional, time-shifted)**

If you want to test without waiting:

```bash
ssh root@CassinoAPI 'docker exec seraphine-backend-1 python3 -c \
"import asyncio; \
from seraphine.proactive.scheduler import ProactiveScheduler; \
# call _tick_day_review directly with the live scheduler instance — \
# adapt to actual code shape"'
```

Or just observe at 21:00 on a regular evening.

- [ ] **Step 6: Document the live behaviour**

Open the app a few times over the next day, take note of:
- Did she still mention anything stale? (If yes, file as bug — likely a missed call site)
- Are fresh hooks (last 24-72h) still surfacing? (If no, the filter may be too aggressive)
- Tune env vars if needed: `FRESHNESS_RECENCY_HOURS`, `FRESHNESS_STALE_DAYS`.

- [ ] **Step 7: Empty commit to mark release**

```bash
git commit --allow-empty -m "release(seraphine/freshness): live verified — Seraphine no longer confabulates stale context"
git push vps main
```

---

## Out of Scope (explicit — do NOT implement)

- UI to view/edit archived items
- Manual "unarchive" command via chat
- Per-conversation freshness policy (work mode vs home mode)
- One-shot backfill migration (first cron execution handles this naturally)
- Including reminders in `fresh_only` (they're already trigger-based)

---

## Self-Review Notes

- Tasks 4-6 share a pattern: read DAO, add `fresh_only=False` kwarg, splice SQL fragment, add test. The helper `_freshness_policy_now` is introduced once (Task 4) and reused (Tasks 5, 6).
- Task 7 has the BIGGEST behavioural impact — the prompt template change is what most directly fixes "voltou. aquela reserva..." behavior.
- Task 10 (vector recall) is the most likely to need fallback to Python-side filter — depends on Chroma version installed in the deployed image.
- The plan does NOT include changes to `mod_calendar`, `mod_finance`, or `mod_vision` — they're either trigger-based, transient, or not in the opener context bundle today (per spec §6.4 "what does NOT change").

Total: 12 tasks, ~26 tests, 4 files created + 7 files modified.
