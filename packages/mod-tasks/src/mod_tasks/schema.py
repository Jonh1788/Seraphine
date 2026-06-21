"""Schema migrator for mod-tasks.

Registers ``seraphine_tasks`` table + indexes on the shared core-db
Store. Idempotent — safe to call repeatedly.

Multi-tenancy column ``user_id`` is added in two ways for safety:
- New DBs: created directly in the CREATE TABLE.
- Existing DBs (Seraphine): ALTER TABLE adds the column with NULL
  default, preserving every existing row as single-tenant.
"""

from __future__ import annotations

import json
import sqlite3
import unicodedata

# Finance taxonomy keys the frontend chip maps against (CATEGORY_COLORS in
# apps/seraphine/frontend/src/finance/types.ts). A task's `category` only
# lights a chip when it normalizes to one of these. Kept in sync manually.
_CATEGORY_KEYS = frozenset(
    {
        "moradia", "alimentacao", "transporte", "saude", "lazer",
        "educacao", "salario", "freelance", "investimento", "outros",
    }
)


def _normalize_category(raw: str | None) -> str:
    """Mirror the frontend normalizeCategory(): lowercase, strip accents,
    trim. Returns "" for falsy input."""
    if not raw:
        return ""
    text = unicodedata.normalize("NFD", str(raw))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return text.lower().strip()


def _derive_category(tags_json: str | None, type_: str | None) -> str | None:
    """Pick the first tag (then the type) that normalizes to a known
    finance-taxonomy key. Returns the normalized key, or None when nothing
    maps — same precedence the frontend categoryChipForCard() uses."""
    candidates: list[str] = []
    if tags_json:
        try:
            parsed = json.loads(tags_json)
            if isinstance(parsed, list):
                candidates.extend(str(t) for t in parsed)
        except (json.JSONDecodeError, TypeError):
            pass
    if type_:
        candidates.append(str(type_))
    for cand in candidates:
        key = _normalize_category(cand)
        if key in _CATEGORY_KEYS:
            return key
    return None


def migrate(conn: sqlite3.Connection) -> None:
    # Step 1: create the table if it doesn't exist. New DBs get the full
    # schema in one shot. Existing DBs (legacy) keep whatever shape they
    # had — Step 2 brings them up to date.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS seraphine_tasks (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending',
          title         TEXT NOT NULL,
          description   TEXT NOT NULL,
          source        TEXT NOT NULL,
          payload       TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          due_date      TEXT,
          due_time      TEXT,
          user_id       TEXT,
          priority      TEXT,
          tags          TEXT,
          remind        TEXT,
          category      TEXT
        )
        """
    )
    # Step 2: idempotent ADD COLUMN for legacy DBs that pre-date
    # user_id / due_date / priority / tags. SQLite has no IF NOT EXISTS
    # for ALTER, so we swallow the duplicate-column error. MUST run
    # before CREATE INDEX on those columns or the index DDL fails on
    # the legacy table.
    for ddl in (
        "ALTER TABLE seraphine_tasks ADD COLUMN due_date TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN due_time TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN user_id TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN priority TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN tags TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN remind TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    # Aura task sharing — completed_by tracks who closed the task.
    try:
        conn.execute("ALTER TABLE seraphine_tasks ADD COLUMN completed_by TEXT")
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise
    # store-categories — persisted task category (finance-taxonomy key).
    # NULL until set/backfilled; the frontend chip lights only for known keys.
    category_is_new = False
    try:
        conn.execute("ALTER TABLE seraphine_tasks ADD COLUMN category TEXT")
        category_is_new = True
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise
    # Backfill: derive category from each row's tags/type (same precedence
    # the frontend chip uses) for rows that don't yet have one. Runs on the
    # first migration that adds the column and is a no-op afterwards (the
    # WHERE clause skips already-populated rows).
    if category_is_new:
        rows = conn.execute(
            "SELECT id, tags, type FROM seraphine_tasks"
            " WHERE category IS NULL"
        ).fetchall()
        for row_id, tags_json, type_ in rows:
            derived = _derive_category(tags_json, type_)
            if derived is not None:
                conn.execute(
                    "UPDATE seraphine_tasks SET category = ? WHERE id = ?",
                    (derived, row_id),
                )
    # Step 3: indexes — safe now that all columns exist.
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_status
          ON seraphine_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_type
          ON seraphine_tasks(type);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_due_date
          ON seraphine_tasks(due_date);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_user
          ON seraphine_tasks(user_id);

        CREATE TABLE IF NOT EXISTS task_participants (
          task_id    INTEGER NOT NULL,
          user_id    TEXT    NOT NULL,
          role       TEXT    NOT NULL DEFAULT 'member',
          joined_at  TEXT    NOT NULL,
          PRIMARY KEY (task_id, user_id),
          FOREIGN KEY (task_id) REFERENCES seraphine_tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_participants_user
          ON task_participants(user_id);
        CREATE INDEX IF NOT EXISTS idx_task_participants_task
          ON task_participants(task_id);
        """
    )
    # Backfill: every Aura task gets an 'owner' participant row.
    # Idempotent via INSERT OR IGNORE.
    conn.execute(
        "INSERT OR IGNORE INTO task_participants (task_id, user_id, role, joined_at)"
        " SELECT id, user_id, 'owner', created_at FROM seraphine_tasks"
        " WHERE user_id IS NOT NULL"
    )
    # Step 4: per-task reminder offsets. One row per (task, offset_minutes).
    # offset_minutes = minutes BEFORE due_time (0 = at due_time). Backfill
    # every existing task with a due_time so the current "fire at due" UX
    # is preserved after this schema rev rolls out.
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS task_reminder_offsets (
          task_id        TEXT NOT NULL,
          user_id        TEXT NOT NULL,
          offset_minutes INTEGER NOT NULL CHECK (offset_minutes >= 0),
          created_at     TEXT NOT NULL,
          PRIMARY KEY (task_id, offset_minutes)
        );
        CREATE INDEX IF NOT EXISTS idx_task_reminder_offsets_user
          ON task_reminder_offsets(user_id);
        """
    )
    # Backfill offset=0 for any pre-existing task with a due_time. user_id
    # NULL in single-tenant Seraphine: we store empty string so the PK
    # still works and the (rarely-used) Seraphine push path stays
    # consistent. Aura tasks always have a real user_id.
    conn.execute(
        "INSERT OR IGNORE INTO task_reminder_offsets"
        " (task_id, user_id, offset_minutes, created_at)"
        " SELECT CAST(id AS TEXT), COALESCE(user_id, ''), 0, created_at"
        " FROM seraphine_tasks"
        " WHERE due_time IS NOT NULL AND due_date IS NOT NULL"
    )
