from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import struct
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from core_db import Store

# Server-side fact categorization. Mirrors the frontend deriveCategory()
# regex (apps/seraphine/frontend/src/memory/MemoryView.tsx) so the card
# eyebrow is now backed by a persisted column instead of a client-side
# guess. Ordered list: first match wins. Each entry is the uppercase
# eyebrow label shown on the card + its detection pattern.
_FACT_CATEGORY_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("METAS", re.compile(r"\b(meta|objetivo|lan[çc]ar|quero|pretendo|sonho)\b")),
    (
        "TRABALHO",
        re.compile(
            r"\b(trabalh|desenvolved|empresa|projeto|c[oó]digo|react|rust|"
            r"tauri|reuni[ãa]o|cliente|deploy)\b"
        ),
    ),
    (
        "ROTINA",
        re.compile(
            r"\b(acorda|treina|manh[ãa]|rotina|todo dia|toda manh|"
            r"caf[ée]|dorme|h[áa]bito|sempre)\b"
        ),
    ),
    (
        "PESSOAS",
        re.compile(
            r"\b(namorad|amig|fam[íi]lia|m[ãa]e|pai|irm[ãa]|"
            r"esposa|marido|filh|anivers[áa]rio|ana|jo[ãa]o)\b"
        ),
    ),
    (
        "LOCAL",
        re.compile(
            r"\b(mora|bairro|cidade|endere[çc]o|s[ãa]o paulo|"
            r"rua|casa|local)\b"
        ),
    ),
    (
        "PREFERENCIA",
        re.compile(
            r"\b(prefere|gosta|n[ãa]o gosta|odeia|chama|favorit|costuma)\b"
        ),
    ),
]


def _derive_fact_category(text: str) -> str:
    """Return the uppercase eyebrow label for a fact's text. Falls back to
    'OUTROS' when nothing matches — same buckets as the frontend regex."""
    t = (text or "").lower()
    for label, pattern in _FACT_CATEGORY_RULES:
        if pattern.search(t):
            return label
    return "OUTROS"


class Turn(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: str
    token_count: int | None = None


class ToolAudit(BaseModel):
    id: str
    request_id: str
    tool: str
    args_json: str
    approved: int | None
    ok: int | None
    output_excerpt: str | None
    error: str | None
    created_at: str


class Fact(BaseModel):
    id: str
    text: str
    source: Literal["explicit", "reflection", "user_taught", "observation"]
    confidence: float
    created_at: str
    superseded_by: str | None = None
    last_used_at: str | None = None
    # Server-derived category eyebrow (METAS/TRABALHO/ROTINA/PESSOAS/LOCAL/
    # PREFERENCIA/OUTROS). Persisted on the facts table; backfilled for
    # rows that predate the column.
    category: str | None = None
    # Pinned identity facts (name, location, core relationships) are
    # ALWAYS injected into context as a distinct "Core facts" block,
    # independent of query similarity, so they can't fall out of top-k
    # RAG retrieval. Identity-category facts (PESSOAS/LOCAL) auto-pin on
    # write; persisted as INTEGER 0/1 on the facts table.
    pinned: int = 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _freshness_policy_now() -> datetime | None:
    """Override hook used by tests to pin "now" for freshness filtering.

    Returns ``None`` in production so ``FreshnessPolicy.sql_fresh_filter``
    falls back to its own wall-clock. Tests monkeypatch this symbol to
    inject a fixed datetime — see tests/freshness/test_dao_fresh_filter_loops.py.
    """
    return None


def _row_to_event(row: tuple[Any, ...]) -> dict[str, Any]:
    """Convert an event_timeline row into a dict, parsing metadata JSON."""
    raw_meta = row[4]
    try:
        metadata = json.loads(raw_meta) if raw_meta else {}
    except (json.JSONDecodeError, TypeError):
        metadata = {}
    return {
        "id": row[0],
        "event_type": row[1],
        "summary": row[2],
        "source": row[3],
        "metadata": metadata,
        "created_at": row[5],
    }


def _seraphine_core_migrator(conn: sqlite3.Connection) -> None:
    """Schema for Seraphine's domain tables.

    Until each module is extracted into its own package (Phases 5-9),
    every Seraphine-owned table lives here as a single migrator. Each
    extraction will move its CREATE TABLE block out and into
    ``packages/mod-<name>/schema.py`` registered via ``Store.register_migrator``.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS conversations (
          id          TEXT PRIMARY KEY,
          created_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turns (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content         TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          token_count     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_turns_conv
          ON turns(conversation_id, created_at);
        CREATE TABLE IF NOT EXISTS facts (
          id            TEXT PRIMARY KEY,
          text          TEXT NOT NULL,
          source        TEXT NOT NULL,
          confidence    REAL NOT NULL,
          created_at    TEXT NOT NULL,
          superseded_by TEXT REFERENCES facts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_facts_created
          ON facts(created_at DESC);
        CREATE TABLE IF NOT EXISTS fact_embeddings (
          fact_id     TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
          vec         BLOB NOT NULL,
          dim         INTEGER NOT NULL,
          model       TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fact_embeddings_model
          ON fact_embeddings(model);
        CREATE TABLE IF NOT EXISTS conversation_summaries (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          summary         TEXT NOT NULL,
          up_to_turn_id   TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_summaries_conv
          ON conversation_summaries(conversation_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS notifications (
          id         TEXT PRIMARY KEY,
          event      TEXT NOT NULL,
          task_id    TEXT,
          title      TEXT,
          summary    TEXT,
          payload    TEXT NOT NULL,
          read       INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notif_unread
          ON notifications(read, created_at DESC);
        CREATE TABLE IF NOT EXISTS tool_audit (
          id             TEXT PRIMARY KEY,
          request_id     TEXT NOT NULL,
          tool           TEXT NOT NULL,
          args_json      TEXT NOT NULL,
          approved       INTEGER,
          ok             INTEGER,
          output_excerpt TEXT,
          error          TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_timeline (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type  TEXT NOT NULL,
          summary     TEXT NOT NULL,
          source      TEXT NOT NULL,
          metadata    TEXT NOT NULL DEFAULT '{}',
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_timeline_created
          ON event_timeline(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_event_timeline_source
          ON event_timeline(source, created_at DESC);
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint   TEXT PRIMARY KEY,
          p256dh     TEXT NOT NULL,
          auth       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_profile (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          data_json   TEXT NOT NULL,
          fact_count  INTEGER NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS open_loops (
          id             TEXT PRIMARY KEY,
          text           TEXT NOT NULL,
          owner          TEXT NOT NULL CHECK (owner IN ('user', 'assistant')),
          created_at     TEXT NOT NULL,
          resolved_at    TEXT,
          resolution     TEXT,
          injection_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS conversation_narratives (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          text            TEXT NOT NULL,
          turn_count      INTEGER NOT NULL,
          started_at      TEXT NOT NULL,
          ended_at        TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_narratives_created
          ON conversation_narratives(created_at DESC);
        CREATE TABLE IF NOT EXISTS decisions (
          id              TEXT PRIMARY KEY,
          subject         TEXT NOT NULL,
          choice          TEXT NOT NULL,
          alternatives    TEXT,
          created_at      TEXT NOT NULL,
          followed_up_at  TEXT,
          outcome         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_followup
          ON decisions(followed_up_at, created_at DESC);
        CREATE TABLE IF NOT EXISTS people (
          id                TEXT PRIMARY KEY,
          name              TEXT UNIQUE NOT NULL,
          relation          TEXT,
          first_seen_at     TEXT NOT NULL,
          last_mentioned_at TEXT NOT NULL,
          mention_count     INTEGER NOT NULL DEFAULT 1,
          tags              TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_people_last
          ON people(last_mentioned_at DESC);
        CREATE TABLE IF NOT EXISTS person_mentions (
          id           TEXT PRIMARY KEY,
          person_id    TEXT NOT NULL REFERENCES people(id),
          turn_id      TEXT,
          context      TEXT NOT NULL,
          sentiment    TEXT,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mentions_person
          ON person_mentions(person_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS discoveries (
          id           TEXT PRIMARY KEY,
          topic        TEXT NOT NULL,
          headline     TEXT NOT NULL,
          url          TEXT,
          summary      TEXT,
          mentioned    INTEGER NOT NULL DEFAULT 0,
          mentioned_at TEXT,
          score        REAL NOT NULL DEFAULT 0.5,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_discoveries_status
          ON discoveries(mentioned, score DESC, created_at DESC);
        CREATE TABLE IF NOT EXISTS voice_memos (
          id              TEXT PRIMARY KEY,
          transcript      TEXT NOT NULL,
          classification  TEXT NOT NULL,
          archived_to     TEXT,
          archived_id     TEXT,
          created_at      TEXT NOT NULL,
          reverted_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_voice_memos_created
          ON voice_memos(created_at DESC);
        CREATE TABLE IF NOT EXISTS desktop_notes (
          id           TEXT PRIMARY KEY,
          text         TEXT NOT NULL,
          color        TEXT NOT NULL DEFAULT 'yellow',
          x            INTEGER NOT NULL DEFAULT 120,
          y            INTEGER NOT NULL DEFAULT 120,
          width        INTEGER NOT NULL DEFAULT 220,
          height       INTEGER NOT NULL DEFAULT 140,
          created_at   TEXT NOT NULL,
          dismissed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_desktop_notes_active
          ON desktop_notes(dismissed_at, created_at DESC);
        CREATE TABLE IF NOT EXISTS flashcards (
          id               TEXT PRIMARY KEY,
          topic            TEXT NOT NULL,
          front            TEXT NOT NULL,
          back             TEXT NOT NULL,
          interval_days    INTEGER NOT NULL DEFAULT 1,
          ease             REAL NOT NULL DEFAULT 2.5,
          reps             INTEGER NOT NULL DEFAULT 0,
          last_reviewed_at TEXT,
          next_due_at      TEXT NOT NULL,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_flashcards_due
          ON flashcards(next_due_at);
        CREATE TABLE IF NOT EXISTS flashcard_reviews (
          id         TEXT PRIMARY KEY,
          card_id    TEXT NOT NULL,
          rating     INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generated_images (
          id         TEXT PRIMARY KEY,
          prompt     TEXT NOT NULL,
          model      TEXT NOT NULL,
          provider   TEXT NOT NULL,
          url        TEXT,
          local_path TEXT,
          cost_usd   REAL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_images_created
          ON generated_images(created_at DESC);
        CREATE TABLE IF NOT EXISTS background_tasks (
          id           TEXT PRIMARY KEY,
          goal         TEXT NOT NULL,
          status       TEXT NOT NULL,
          progress     TEXT,
          iterations   INTEGER NOT NULL DEFAULT 0,
          result       TEXT,
          started_at   TEXT NOT NULL,
          finished_at  TEXT,
          max_duration_min INTEGER NOT NULL DEFAULT 30
        );
        CREATE INDEX IF NOT EXISTS idx_bgtasks_status
          ON background_tasks(status, started_at DESC);
        CREATE TABLE IF NOT EXISTS finance_nudges (
          id           TEXT PRIMARY KEY,
          category     TEXT NOT NULL,
          ratio        REAL NOT NULL,       -- week_total / avg30d_baseline
          week_total   REAL NOT NULL,
          baseline     REAL NOT NULL,
          headline     TEXT NOT NULL,
          mentioned    INTEGER NOT NULL DEFAULT 0,
          mentioned_at TEXT,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_finance_nudges_status
          ON finance_nudges(mentioned, created_at DESC);
        CREATE TABLE IF NOT EXISTS anticipation_rules (
          id           TEXT PRIMARY KEY,
          trigger_kind TEXT NOT NULL,       -- 'tool_use_pattern'
          payload      TEXT NOT NULL,       -- JSON: tool + weekday + hour
          confidence   REAL NOT NULL,
          last_fired_at TEXT,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_anticipation_kind
          ON anticipation_rules(trigger_kind, confidence DESC);
        CREATE TABLE IF NOT EXISTS turn_feedback (
          turn_id       TEXT PRIMARY KEY,
          tone          TEXT,               -- inferred from next user turn
          length_bucket TEXT,               -- short|medium|long
          tool_used     TEXT,
          reaction      TEXT,               -- positive|negative|neutral
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_turn_feedback_reaction
          ON turn_feedback(reaction, created_at DESC);
        CREATE TABLE IF NOT EXISTS style_prefs (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          data_json  TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_open_loops_status
          ON open_loops(resolved_at, created_at DESC);
        """
    )
    # `seraphine_tasks` schema (and its due_date / user_id ALTERs) has
    # moved to packages/mod-tasks/schema.py — registered separately by
    # the app at startup. push_subscriptions remains here until Phase 7
    # gives push its own module.


def _seraphine_facts_decay_migrator(conn: sqlite3.Connection) -> None:
    """Add last_used_at column to facts (idempotent ALTER)."""
    try:
        conn.execute("ALTER TABLE facts ADD COLUMN last_used_at TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists


def _seraphine_facts_category_migrator(conn: sqlite3.Connection) -> None:
    """Add a `category` column to facts (idempotent ALTER) and backfill it.

    The category is the uppercase eyebrow label the memory card shows. It
    used to be derived client-side from fact.text on every render; this
    promotes it to a persisted column derived server-side via the same
    rules. Existing rows are backfilled on the first run that adds the
    column; the WHERE clause makes a re-run a no-op.
    """
    column_is_new = False
    try:
        conn.execute("ALTER TABLE facts ADD COLUMN category TEXT")
        column_is_new = True
    except sqlite3.OperationalError:
        pass  # column already exists
    if column_is_new:
        rows = conn.execute(
            "SELECT id, text FROM facts WHERE category IS NULL"
        ).fetchall()
        for fact_id, text in rows:
            conn.execute(
                "UPDATE facts SET category = ? WHERE id = ?",
                (_derive_fact_category(text or ""), fact_id),
            )


def _seraphine_facts_pinned_migrator(conn: sqlite3.Connection) -> None:
    """Add a `pinned` column to facts (idempotent ALTER) and backfill it.

    Identity facts — the user's name, location, core relationships — can
    fall out of the top-k RAG retrieval, so the assistant "forgets" them.
    Pinning marks a fact for unconditional injection as a "Core facts"
    block. Identity-category rows (PESSOAS/LOCAL) are backfilled to
    pinned=1 on the first run that adds the column; the WHERE clause makes
    a re-run a no-op. Runs AFTER `seraphine_facts_category`, so the
    `category` column is already populated when this backfill executes.
    """
    try:
        conn.execute("ALTER TABLE facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # column already exists
    # Idempotent backfill: identity-class facts are always pinned. Safe to
    # re-run — it only ever sets the same rows to the same value.
    conn.execute(
        "UPDATE facts SET pinned = 1 WHERE category IN ('PESSOAS','LOCAL')"
    )


def _seraphine_fts5_migrator(conn: sqlite3.Connection) -> None:
    """Create FTS5 virtual table over turns.content + sync triggers."""
    conn.executescript(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
          content, content='turns', content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
          INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
          INSERT INTO turns_fts(turns_fts, rowid, content)
            VALUES('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
          INSERT INTO turns_fts(turns_fts, rowid, content)
            VALUES('delete', old.rowid, old.content);
          INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        """
    )
    # Back-fill: if turns exist but FTS is empty, rebuild once.
    turns_count = conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
    fts_count = conn.execute("SELECT COUNT(*) FROM turns_fts").fetchone()[0]
    if turns_count > 0 and fts_count == 0:
        conn.execute("INSERT INTO turns_fts(turns_fts) VALUES ('rebuild')")


def _seraphine_reflect_cursor_migrator(conn: sqlite3.Connection) -> None:
    """Track the last turn processed by reflect() to avoid re-reading."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS reflect_cursor (
          conversation_id TEXT PRIMARY KEY,
          last_turn_id    TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        """
    )


def _seraphine_kv_migrator(conn: sqlite3.Connection) -> None:
    """Generic key/value table for small persistent settings (assistant
    appearance, integration prefs, anything single-row that doesn't
    deserve its own table). Values are TEXT — callers JSON-encode if
    they need structure."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS kv (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """
    )


def _seraphine_episode_windows_migrator(conn: sqlite3.Connection) -> None:
    """Create episode_windows table for windowed episode indexing."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS episode_windows (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          first_turn_id   TEXT NOT NULL,
          last_turn_id    TEXT NOT NULL,
          turn_count      INTEGER NOT NULL,
          text            TEXT NOT NULL,
          started_at      TEXT NOT NULL,
          ended_at        TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_episode_windows_conv
          ON episode_windows(conversation_id, ended_at DESC);
        """
    )


class MemoryStore(Store):
    def __init__(self, path: Path) -> None:
        super().__init__(path)
        # Register Seraphine's monolithic schema migrator. Future module
        # extractions will register their own and remove their CREATE
        # TABLE block from `_seraphine_core_migrator`.
        self.register_migrator("seraphine_core", _seraphine_core_migrator)
        self.register_migrator("seraphine_facts_decay", _seraphine_facts_decay_migrator)
        self.register_migrator("seraphine_facts_category", _seraphine_facts_category_migrator)
        self.register_migrator("seraphine_facts_pinned", _seraphine_facts_pinned_migrator)
        self.register_migrator("seraphine_fts5", _seraphine_fts5_migrator)
        self.register_migrator("seraphine_reflect_cursor", _seraphine_reflect_cursor_migrator)
        self.register_migrator("seraphine_episode_windows", _seraphine_episode_windows_migrator)
        self.register_migrator("seraphine_kv", _seraphine_kv_migrator)

    async def set_kv(self, key: str, value: str) -> None:
        """Upsert a key/value pair. value is opaque text — caller JSON-
        encodes if needed."""
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                    "updated_at=excluded.updated_at",
                    (key, value, _now()),
                )
        await asyncio.to_thread(_work)

    async def get_kv(self, key: str) -> str | None:
        def _work() -> str | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT value FROM kv WHERE key = ?", (key,),
                ).fetchone()
            return row[0] if row else None
        return await asyncio.to_thread(_work)

    async def delete_kv(self, key: str) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM kv WHERE key = ?", (key,))
                return cur.rowcount > 0
        return await asyncio.to_thread(_work)

    async def create_conversation(self) -> str:
        conv_id = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO conversations(id, created_at) VALUES (?, ?)",
                    (conv_id, _now()),
                )

        await asyncio.to_thread(_work)
        return conv_id

    async def ensure_conversation(self, conv_id: str) -> None:
        """Create conversation if it doesn't exist (INSERT OR IGNORE)."""
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO conversations(id, created_at) VALUES (?, ?)",
                    (conv_id, _now()),
                )
        await asyncio.to_thread(_work)

    async def add_turn(
        self,
        conversation_id: str,
        role: str,
        content: str,
        token_count: int | None = None,
    ) -> Turn:
        turn = Turn(
            id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            role=role,
            content=content,
            created_at=_now(),
            token_count=token_count,
        )

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO turns(id, conversation_id, role, content, created_at, token_count)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        turn.id,
                        turn.conversation_id,
                        turn.role,
                        turn.content,
                        turn.created_at,
                        turn.token_count,
                    ),
                )

        await asyncio.to_thread(_work)
        return turn

    async def get_recent_turns(self, *, limit: int = 100) -> list[Turn]:
        """Most recent turns across ALL conversations, oldest first."""

        def _work() -> list[Turn]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, role, content, created_at, token_count"
                    " FROM turns ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return list(
                reversed(
                    [
                        Turn(
                            id=r[0],
                            conversation_id=r[1],
                            role=r[2],
                            content=r[3],
                            created_at=r[4],
                            token_count=r[5],
                        )
                        for r in rows
                    ]
                )
            )

        return await asyncio.to_thread(_work)

    async def get_turns(self, conversation_id: str, *, limit: int = 500) -> list[Turn]:
        def _work() -> list[Turn]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, role, content, created_at, token_count"
                    " FROM turns WHERE conversation_id = ? ORDER BY created_at ASC"
                    " LIMIT ?",
                    (conversation_id, limit),
                ).fetchall()
            return [
                Turn(
                    id=r[0],
                    conversation_id=r[1],
                    role=r[2],
                    content=r[3],
                    created_at=r[4],
                    token_count=r[5],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def get_turn(self, turn_id: str) -> Turn | None:
        """Fetch a single turn by id."""

        def _work() -> Turn | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, conversation_id, role, content, created_at, token_count"
                    " FROM turns WHERE id = ?",
                    (turn_id,),
                ).fetchone()
            if row is None:
                return None
            return Turn(
                id=row[0], conversation_id=row[1], role=row[2],
                content=row[3], created_at=row[4], token_count=row[5],
            )

        return await asyncio.to_thread(_work)

    async def fts_search_turns(
        self,
        query: str,
        k: int = 10,
        *,
        conversation_id: str | None = None,
        role: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> list[tuple[str, float]]:
        """Full-text search over turns via FTS5.

        Returns [(turn_id, bm25_score), ...] ordered by relevance.
        The query is wrapped in double quotes for safe phrase matching.

        Optional filters narrow results by conversation, role, or time range.
        """
        sanitized = '"' + query.replace('"', '""') + '"'

        def _work() -> list[tuple[str, float]]:
            with self._connect() as conn:
                try:
                    sql = (
                        "SELECT t.id, bm25(turns_fts) AS score"
                        " FROM turns_fts"
                        " JOIN turns t ON t.rowid = turns_fts.rowid"
                        " WHERE turns_fts MATCH ?"
                    )
                    params: list[Any] = [sanitized]
                    if conversation_id:
                        sql += " AND t.conversation_id = ?"
                        params.append(conversation_id)
                    if role:
                        sql += " AND t.role = ?"
                        params.append(role)
                    if since:
                        sql += " AND t.created_at >= ?"
                        params.append(since)
                    if until:
                        sql += " AND t.created_at <= ?"
                        params.append(until)
                    sql += " ORDER BY score LIMIT ?"
                    params.append(k)
                    rows = conn.execute(sql, params).fetchall()
                except Exception:
                    return []
            return [(r[0], float(r[1])) for r in rows]

        return await asyncio.to_thread(_work)

    # ---------- conversation summaries ----------

    async def get_summary(self, conversation_id: str) -> tuple[str, str] | None:
        """Return (summary, up_to_turn_id) for the latest summary, or None."""

        def _work() -> tuple[str, str] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT summary, up_to_turn_id FROM conversation_summaries"
                    " WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
                    (conversation_id,),
                ).fetchone()
            if row is None:
                return None
            return (row[0], row[1])

        return await asyncio.to_thread(_work)

    async def save_summary(
        self, conversation_id: str, summary: str, up_to_turn_id: str
    ) -> None:
        sid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO conversation_summaries"
                    "(id, conversation_id, summary, up_to_turn_id, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (sid, conversation_id, summary, up_to_turn_id, _now()),
                )

        await asyncio.to_thread(_work)

    # ---------- notifications ----------

    async def add_notification(
        self, event: str, task_id: str, title: str, summary: str, payload: str,
    ) -> str:
        nid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO notifications(id, event, task_id, title, summary, payload, read, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                    (nid, event, task_id, title, summary, payload, _now()),
                )

        await asyncio.to_thread(_work)
        return nid

    async def get_unread_notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, event, task_id, title, summary, payload, created_at"
                    " FROM notifications WHERE read = 0"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {"id": r[0], "event": r[1], "task_id": r[2], "title": r[3],
                 "summary": r[4], "payload": r[5], "created_at": r[6]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def mark_notifications_read(self, ids: list[str]) -> None:
        if not ids:
            return

        def _work() -> None:
            with self._connect() as conn:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(
                    f"UPDATE notifications SET read = 1 WHERE id IN ({placeholders})",
                    ids,
                )

        await asyncio.to_thread(_work)

    # ---------- recent conversations ----------

    async def get_recent_conversations(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return recent conversations with their first user message as preview."""

        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT c.id, c.created_at,"
                    " (SELECT content FROM turns WHERE conversation_id = c.id"
                    "  AND role = 'user' ORDER BY created_at ASC LIMIT 1) AS preview"
                    " FROM conversations c ORDER BY c.created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            results = []
            for r in rows:
                preview = r[2] or ""
                if len(preview) > 100:
                    preview = preview[:100] + "..."
                results.append({"id": r[0], "created_at": r[1], "preview": preview})
            return results

        return await asyncio.to_thread(_work)

    # ---------- facts ----------

    async def add_fact(
        self,
        text: str,
        source: str,
        confidence: float,
        *,
        category: str | None = None,
    ) -> Fact:
        # Derive the category eyebrow server-side when the caller doesn't
        # supply one, so every fact lands with a persisted category.
        resolved_category = category or _derive_fact_category(text)
        # Identity-class facts auto-pin so they're always injected as a
        # "Core facts" block and can't fall out of top-k RAG retrieval.
        pinned = 1 if resolved_category in ("PESSOAS", "LOCAL") else 0
        fact = Fact(
            id=str(uuid.uuid4()),
            text=text,
            source=source,  # type: ignore[arg-type]
            confidence=confidence,
            created_at=_now(),
            category=resolved_category,
            pinned=pinned,
        )

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO facts(id, text, source, confidence, created_at,"
                    " superseded_by, category, pinned)"
                    " VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                    (fact.id, fact.text, fact.source, fact.confidence,
                     fact.created_at, fact.category, fact.pinned),
                )

        await asyncio.to_thread(_work)
        return fact

    async def bump_fact_used(self, fact_id: str) -> None:
        """Touch last_used_at to signal the fact was revalidated."""
        now = _now()

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE facts SET last_used_at = ? WHERE id = ?",
                    (now, fact_id),
                )

        await asyncio.to_thread(_work)

    async def list_facts_for_decay(self) -> list[Fact]:
        """Return all active (non-superseded) facts for the decay job."""

        def _work() -> list[Fact]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, text, source, confidence, created_at,"
                    " superseded_by, last_used_at, category, pinned"
                    " FROM facts WHERE superseded_by IS NULL"
                    " ORDER BY created_at ASC",
                ).fetchall()
            return [
                Fact(
                    id=r[0], text=r[1], source=r[2],
                    confidence=r[3], created_at=r[4],
                    superseded_by=r[5], last_used_at=r[6], category=r[7],
                    pinned=r[8],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def list_facts(
        self,
        *,
        limit: int = 50,
        include_superseded: bool = False,
        fresh_only: bool = False,
    ) -> list[Fact]:
        def _work() -> list[Fact]:
            clauses: list[str] = []
            params: list[Any] = []
            if not include_superseded:
                clauses.append("superseded_by IS NULL")
            if fresh_only:
                # seraphine.memory and seraphine.freshness are siblings
                # — the import is layering-safe.
                from seraphine.freshness import DEFAULT_POLICY

                fragment, fragment_params = DEFAULT_POLICY.sql_fresh_filter(
                    created_col="created_at",
                    now=_freshness_policy_now(),
                )
                clauses.append(fragment)
                params.extend(fragment_params)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)
            with self._connect() as conn:
                sql = (
                    "SELECT id, text, source, confidence, created_at,"
                    " superseded_by, last_used_at, category, pinned"
                    " FROM facts"
                    f"{where} ORDER BY created_at DESC LIMIT ?"
                )
                rows = conn.execute(sql, params).fetchall()
            return [
                Fact(
                    id=r[0],
                    text=r[1],
                    source=r[2],
                    confidence=r[3],
                    created_at=r[4],
                    superseded_by=r[5],
                    last_used_at=r[6],
                    category=r[7],
                    pinned=r[8],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def list_pinned_facts(self) -> list[Fact]:
        """Return active (non-superseded) pinned facts — the "Core facts"
        about the user that are ALWAYS injected into context, independent
        of query similarity. Newest first so a cap keeps the freshest."""

        def _work() -> list[Fact]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, text, source, confidence, created_at,"
                    " superseded_by, last_used_at, category, pinned"
                    " FROM facts WHERE pinned = 1 AND superseded_by IS NULL"
                    " ORDER BY created_at DESC",
                ).fetchall()
            return [
                Fact(
                    id=r[0], text=r[1], source=r[2],
                    confidence=r[3], created_at=r[4],
                    superseded_by=r[5], last_used_at=r[6], category=r[7],
                    pinned=r[8],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def set_fact_pinned(self, fact_id: str, pinned: bool) -> None:
        """Pin/unpin a fact. Pinned facts are unconditionally injected as
        a "Core facts" block."""

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE facts SET pinned = ? WHERE id = ?",
                    (1 if pinned else 0, fact_id),
                )

        await asyncio.to_thread(_work)

    async def supersede_fact(self, old_id: str, new_id: str | None = None) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE facts SET superseded_by = ? WHERE id = ?",
                    (new_id, old_id),
                )

        await asyncio.to_thread(_work)

    async def update_fact(
        self,
        fact_id: str,
        text: str | None = None,
        confidence: float | None = None,
        *,
        category: str | None = None,
    ) -> Fact | None:
        def _work() -> Fact | None:
            with self._connect() as conn:
                parts: list[str] = []
                vals: list[Any] = []
                if text is not None:
                    parts.append("text = ?")
                    vals.append(text)
                    # Re-derive the category from the new text unless the
                    # caller is overriding it explicitly below.
                    if category is None:
                        parts.append("category = ?")
                        vals.append(_derive_fact_category(text))
                if confidence is not None:
                    parts.append("confidence = ?")
                    vals.append(confidence)
                if category is not None:
                    parts.append("category = ?")
                    vals.append(category)
                if not parts:
                    return None
                vals.append(fact_id)
                conn.execute(
                    f"UPDATE facts SET {', '.join(parts)} WHERE id = ?",
                    vals,
                )
                row = conn.execute(
                    "SELECT id, text, source, confidence, created_at,"
                    " superseded_by, last_used_at, category, pinned"
                    " FROM facts WHERE id = ?",
                    (fact_id,),
                ).fetchone()
            if row is None:
                return None
            return Fact(
                id=row[0], text=row[1], source=row[2],
                confidence=row[3], created_at=row[4], superseded_by=row[5],
                last_used_at=row[6], category=row[7], pinned=row[8],
            )

        return await asyncio.to_thread(_work)

    async def delete_fact(self, fact_id: str) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
                return cur.rowcount > 0

        return await asyncio.to_thread(_work)

    # ---------- tool audit ----------

    async def add_tool_audit(
        self,
        *,
        request_id: str,
        tool: str,
        args_json: str,
        approved: int | None,
        ok: int | None,
        output_excerpt: str | None,
        error: str | None,
    ) -> ToolAudit:
        audit = ToolAudit(
            id=str(uuid.uuid4()),
            request_id=request_id,
            tool=tool,
            args_json=args_json,
            approved=approved,
            ok=ok,
            output_excerpt=output_excerpt,
            error=error,
            created_at=_now(),
        )

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO tool_audit(id, request_id, tool, args_json, approved,"
                    " ok, output_excerpt, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        audit.id,
                        audit.request_id,
                        audit.tool,
                        audit.args_json,
                        audit.approved,
                        audit.ok,
                        audit.output_excerpt,
                        audit.error,
                        audit.created_at,
                    ),
                )

        await asyncio.to_thread(_work)
        return audit

    async def list_tool_audit(self, limit: int = 50) -> list[ToolAudit]:
        def _work() -> list[ToolAudit]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, request_id, tool, args_json, approved, ok,"
                    " output_excerpt, error, created_at FROM tool_audit"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                ToolAudit(
                    id=r[0],
                    request_id=r[1],
                    tool=r[2],
                    args_json=r[3],
                    approved=r[4],
                    ok=r[5],
                    output_excerpt=r[6],
                    error=r[7],
                    created_at=r[8],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ---------- event timeline ----------

    async def add_event(
        self,
        event_type: str,
        summary: str,
        source: str,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        """Append a lightweight event to the timeline. Returns the row id."""
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)
        created_at = _now()

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO event_timeline(event_type, summary, source, metadata, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (event_type, summary, source, meta_json, created_at),
                )
                return int(cur.lastrowid or 0)

        return await asyncio.to_thread(_work)

    async def get_recent_events(
        self, limit: int = 20, source: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return recent events ordered from newest to oldest.

        If ``source`` is provided, filters to that source only.
        """

        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                if source is None:
                    rows = conn.execute(
                        "SELECT id, event_type, summary, source, metadata, created_at"
                        " FROM event_timeline ORDER BY created_at DESC, id DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT id, event_type, summary, source, metadata, created_at"
                        " FROM event_timeline WHERE source = ?"
                        " ORDER BY created_at DESC, id DESC LIMIT ?",
                        (source, limit),
                    ).fetchall()
            return [_row_to_event(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_latest_event(
        self, *, source: str, event_type: str,
    ) -> dict[str, Any] | None:
        """Return the most recent event matching source+event_type, or None."""

        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, event_type, summary, source, metadata, created_at"
                    " FROM event_timeline WHERE source = ? AND event_type = ?"
                    " ORDER BY created_at DESC, id DESC LIMIT 1",
                    (source, event_type),
                ).fetchone()
            return _row_to_event(row) if row else None

        return await asyncio.to_thread(_work)

    async def count_events_since(
        self, *, source: str, event_type: str, since: str,
    ) -> int:
        """Count events matching source+event_type with created_at >= since."""

        def _work() -> int:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT COUNT(*) FROM event_timeline"
                    " WHERE source = ? AND event_type = ? AND created_at >= ?",
                    (source, event_type, since),
                ).fetchone()
            return int(row[0]) if row else 0

        return await asyncio.to_thread(_work)

    async def save_fact_embedding(
        self, fact_id: str, vec: list[float], *, model: str,
    ) -> None:
        """Upsert a fact embedding keyed by fact_id. vec is stored as a
        little-endian float32 BLOB plus its dim + model for sanity checks.
        """
        blob = struct.pack(f"<{len(vec)}f", *vec)
        dim = len(vec)
        now = _now()

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO fact_embeddings(fact_id, vec, dim, model, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT(fact_id) DO UPDATE SET"
                    "   vec = excluded.vec,"
                    "   dim = excluded.dim,"
                    "   model = excluded.model,"
                    "   updated_at = excluded.updated_at",
                    (fact_id, blob, dim, model, now),
                )

        await asyncio.to_thread(_work)

    async def load_fact_embeddings(
        self, *, model: str,
    ) -> dict[str, list[float]]:
        """Load every cached embedding for the given model.

        Filters by ``model`` so swapping embedding models (which changes
        vector space) doesn't silently mix incompatible vectors — the
        caller gets an empty dict and re-embeds.
        """
        def _work() -> dict[str, list[float]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT fact_id, vec, dim FROM fact_embeddings WHERE model = ?",
                    (model,),
                ).fetchall()
            out: dict[str, list[float]] = {}
            for fid, blob, dim in rows:
                try:
                    out[fid] = list(struct.unpack(f"<{int(dim)}f", blob))
                except struct.error:
                    continue
            return out

        return await asyncio.to_thread(_work)

    async def delete_fact_embedding(self, fact_id: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "DELETE FROM fact_embeddings WHERE fact_id = ?", (fact_id,),
                )

        await asyncio.to_thread(_work)

    async def count_facts(self) -> dict[str, int]:
        """Return {active, superseded, total} fact counts."""

        def _work() -> dict[str, int]:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT COUNT(*), COUNT(superseded_by) FROM facts"
                ).fetchone()
            total = int(row[0]) if row else 0
            superseded = int(row[1]) if row else 0
            return {
                "active": total - superseded,
                "superseded": superseded,
                "total": total,
            }

        return await asyncio.to_thread(_work)

    async def prune_events_older_than(self, days: int = 90) -> int:
        """Delete events older than ``days`` days. Returns count of deleted rows."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM event_timeline WHERE created_at < ?",
                    (cutoff,),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def get_events_since(self, since: str) -> list[dict[str, Any]]:
        """Return events with created_at >= ``since`` (ISO datetime string)."""

        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, event_type, summary, source, metadata, created_at"
                    " FROM event_timeline WHERE created_at >= ?"
                    " ORDER BY created_at DESC, id DESC",
                    (since,),
                ).fetchall()
            return [_row_to_event(r) for r in rows]

        return await asyncio.to_thread(_work)

    # seraphine internal tasks moved to packages/mod-tasks (Phase 5).
    # The shared core-db Store is reused via the same connection — no
    # CRUD API is exposed from MemoryStore for tasks anymore.

    async def get_fact(self, fact_id: str) -> Fact | None:
        def _work() -> Fact | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, text, source, confidence, created_at,"
                    " superseded_by, last_used_at, category, pinned"
                    " FROM facts WHERE id = ?",
                    (fact_id,),
                ).fetchone()
            if row is None:
                return None
            return Fact(
                id=row[0],
                text=row[1],
                source=row[2],
                confidence=row[3],
                created_at=row[4],
                superseded_by=row[5],
                last_used_at=row[6],
                category=row[7],
                pinned=row[8],
            )

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Push subscriptions
    # ------------------------------------------------------------------

    async def add_push_subscription(
        self, endpoint: str, p256dh: str, auth: str
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO push_subscriptions"
                    " (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)",
                    (endpoint, p256dh, auth, _now()),
                )

        await asyncio.to_thread(_work)

    async def remove_push_subscription(self, endpoint: str) -> int:
        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = ?",
                    (endpoint,),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def get_user_profile(self) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT data_json, fact_count, updated_at FROM user_profile WHERE id = 1"
                ).fetchone()
            if not row:
                return None
            try:
                data = json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                return None
            return {"data": data, "fact_count": row[1], "updated_at": row[2]}

        return await asyncio.to_thread(_work)

    async def set_user_profile(self, data: dict[str, Any], fact_count: int) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO user_profile (id, data_json, fact_count, updated_at)"
                    " VALUES (1, ?, ?, ?)"
                    " ON CONFLICT(id) DO UPDATE SET"
                    "   data_json = excluded.data_json,"
                    "   fact_count = excluded.fact_count,"
                    "   updated_at = excluded.updated_at",
                    (json.dumps(data, ensure_ascii=False), fact_count, _now()),
                )

        await asyncio.to_thread(_work)

    async def add_open_loop(self, text: str, owner: str = "user") -> str:
        loop_id = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO open_loops"
                    " (id, text, owner, created_at, injection_count)"
                    " VALUES (?, ?, ?, ?, 0)",
                    (loop_id, text, owner, _now()),
                )

        await asyncio.to_thread(_work)
        return loop_id

    async def list_open_loops(
        self,
        *,
        only_open: bool = True,
        limit: int = 10,
        fresh_only: bool = False,
    ) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            clauses: list[str] = []
            params: list[Any] = []
            if only_open:
                clauses.append("resolved_at IS NULL")
            if fresh_only:
                # seraphine.memory and seraphine.freshness are siblings
                # — the import is layering-safe.
                from seraphine.freshness import DEFAULT_POLICY

                fragment, fragment_params = DEFAULT_POLICY.sql_fresh_filter(
                    created_col="created_at",
                    now=_freshness_policy_now(),
                )
                clauses.append(fragment)
                params.extend(fragment_params)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)
            with self._connect() as conn:
                sql = (
                    "SELECT id, text, owner, created_at, resolved_at,"
                    " resolution, injection_count FROM open_loops"
                    f"{where} ORDER BY created_at DESC LIMIT ?"
                )
                rows = conn.execute(sql, params).fetchall()
            return [
                {
                    "id": r[0], "text": r[1], "owner": r[2],
                    "created_at": r[3], "resolved_at": r[4],
                    "resolution": r[5], "injection_count": r[6],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def resolve_open_loop(self, loop_id: str, resolution: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE open_loops SET resolved_at = ?, resolution = ?"
                    " WHERE id = ?",
                    (_now(), resolution, loop_id),
                )

        await asyncio.to_thread(_work)

    async def bump_open_loop_injection(self, loop_id: str) -> int:
        """Increment the injection counter and return the new value."""
        def _work() -> int:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE open_loops SET injection_count = injection_count + 1"
                    " WHERE id = ?",
                    (loop_id,),
                )
                row = conn.execute(
                    "SELECT injection_count FROM open_loops WHERE id = ?",
                    (loop_id,),
                ).fetchone()
                return int(row[0]) if row else 0

        return await asyncio.to_thread(_work)

    async def add_narrative(
        self, conversation_id: str, text: str, turn_count: int,
        started_at: str, ended_at: str,
    ) -> str:
        nid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO conversation_narratives"
                    " (id, conversation_id, text, turn_count, started_at, ended_at, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (nid, conversation_id, text, turn_count, started_at, ended_at, _now()),
                )

        await asyncio.to_thread(_work)
        return nid

    async def list_narratives(self, limit: int = 10) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, text, turn_count, started_at,"
                    " ended_at, created_at"
                    " FROM conversation_narratives"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {
                    "id": r[0], "conversation_id": r[1], "text": r[2],
                    "turn_count": r[3], "started_at": r[4], "ended_at": r[5],
                    "created_at": r[6],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def narrative_exists_for_conv(self, conversation_id: str) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT 1 FROM conversation_narratives"
                    " WHERE conversation_id = ? LIMIT 1",
                    (conversation_id,),
                ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)

    async def add_decision(
        self, subject: str, choice: str, alternatives: str | None = None,
    ) -> str:
        did = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO decisions"
                    " (id, subject, choice, alternatives, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (did, subject, choice, alternatives, _now()),
                )

        await asyncio.to_thread(_work)
        return did

    async def list_unfollowed_decisions(self, min_age_days: int = 3) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=min_age_days)).isoformat()
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, subject, choice, alternatives, created_at"
                    " FROM decisions"
                    " WHERE followed_up_at IS NULL"
                    " AND created_at < ?"
                    " ORDER BY created_at DESC LIMIT 10",
                    (cutoff,),
                ).fetchall()
            return [
                {
                    "id": r[0], "subject": r[1], "choice": r[2],
                    "alternatives": r[3], "created_at": r[4],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def mark_decision_followed(
        self, decision_id: str, outcome: str,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE decisions SET followed_up_at = ?, outcome = ?"
                    " WHERE id = ?",
                    (_now(), outcome, decision_id),
                )

        await asyncio.to_thread(_work)

    async def upsert_person(
        self, name: str, *, relation: str | None = None,
    ) -> str:
        """Return the person's id (creates if absent, updates otherwise)."""
        pid = str(uuid.uuid4())
        now = _now()

        def _work() -> str:
            nonlocal pid
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, relation FROM people WHERE lower(name) = lower(?)",
                    (name,),
                ).fetchone()
                if row:
                    pid = row[0]
                    if relation and not row[1]:
                        conn.execute(
                            "UPDATE people SET relation = ?, "
                            "last_mentioned_at = ?, "
                            "mention_count = mention_count + 1 WHERE id = ?",
                            (relation, now, pid),
                        )
                    else:
                        conn.execute(
                            "UPDATE people SET last_mentioned_at = ?, "
                            "mention_count = mention_count + 1 WHERE id = ?",
                            (now, pid),
                        )
                else:
                    conn.execute(
                        "INSERT INTO people (id, name, relation, "
                        "first_seen_at, last_mentioned_at, mention_count) "
                        "VALUES (?, ?, ?, ?, ?, 1)",
                        (pid, name, relation, now, now),
                    )
            return pid

        return await asyncio.to_thread(_work)

    async def add_person_mention(
        self, person_id: str, context: str, *, sentiment: str | None = None,
        turn_id: str | None = None,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO person_mentions "
                    "(id, person_id, turn_id, context, sentiment, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), person_id, turn_id, context,
                     sentiment, _now()),
                )

        await asyncio.to_thread(_work)

    async def list_people(self, limit: int = 30) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, name, relation, first_seen_at, "
                    "last_mentioned_at, mention_count, tags "
                    "FROM people ORDER BY last_mentioned_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {"id": r[0], "name": r[1], "relation": r[2],
                 "first_seen_at": r[3], "last_mentioned_at": r[4],
                 "mention_count": r[5],
                 "tags": json.loads(r[6]) if r[6] else []}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def get_person_by_name(self, name: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, name, relation, last_mentioned_at, mention_count"
                    " FROM people WHERE lower(name) = lower(?)",
                    (name,),
                ).fetchone()
            if not row:
                return None
            return {"id": row[0], "name": row[1], "relation": row[2],
                    "last_mentioned_at": row[3], "mention_count": row[4]}

        return await asyncio.to_thread(_work)

    async def list_person_mentions(
        self, person_id: str, limit: int = 5,
    ) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT context, sentiment, created_at FROM person_mentions"
                    " WHERE person_id = ? ORDER BY created_at DESC LIMIT ?",
                    (person_id, limit),
                ).fetchall()
            return [
                {"context": r[0], "sentiment": r[1], "created_at": r[2]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def add_discovery(
        self, *, topic: str, headline: str, url: str | None,
        summary: str | None = None, score: float = 0.5,
    ) -> str:
        did = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO discoveries"
                    " (id, topic, headline, url, summary, score, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (did, topic, headline, url, summary, score, _now()),
                )

        await asyncio.to_thread(_work)
        return did

    async def list_pending_discoveries(self, limit: int = 5) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, topic, headline, url, summary, score, created_at"
                    " FROM discoveries WHERE mentioned = 0"
                    " ORDER BY score DESC, created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {"id": r[0], "topic": r[1], "headline": r[2], "url": r[3],
                 "summary": r[4], "score": r[5], "created_at": r[6]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def mark_discovery_mentioned(self, discovery_id: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE discoveries SET mentioned = 1, mentioned_at = ?"
                    " WHERE id = ?",
                    (_now(), discovery_id),
                )

        await asyncio.to_thread(_work)

    async def discovery_url_exists(self, url: str) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT 1 FROM discoveries WHERE url = ? LIMIT 1",
                    (url,),
                ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)

    async def add_finance_nudge(
        self, *, category: str, ratio: float, week_total: float,
        baseline: float, headline: str,
    ) -> str:
        nid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO finance_nudges"
                    " (id, category, ratio, week_total, baseline, headline, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (nid, category, ratio, week_total, baseline, headline, _now()),
                )

        await asyncio.to_thread(_work)
        return nid

    async def list_pending_finance_nudges(self, limit: int = 3) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, category, ratio, week_total, baseline,"
                    " headline, created_at FROM finance_nudges"
                    " WHERE mentioned = 0 ORDER BY ratio DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {"id": r[0], "category": r[1], "ratio": r[2],
                 "week_total": r[3], "baseline": r[4], "headline": r[5],
                 "created_at": r[6]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def mark_finance_nudge_mentioned(self, nudge_id: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE finance_nudges SET mentioned = 1, mentioned_at = ?"
                    " WHERE id = ?",
                    (_now(), nudge_id),
                )

        await asyncio.to_thread(_work)

    async def finance_nudge_exists_this_week(self, category: str) -> bool:
        def _work() -> bool:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT 1 FROM finance_nudges"
                    " WHERE category = ? AND created_at > ? LIMIT 1",
                    (category, cutoff),
                ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)

    async def add_anticipation_rule(
        self, *, trigger_kind: str, payload: dict[str, Any], confidence: float,
    ) -> str:
        rid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO anticipation_rules"
                    " (id, trigger_kind, payload, confidence, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (rid, trigger_kind, json.dumps(payload, ensure_ascii=False),
                     confidence, _now()),
                )

        await asyncio.to_thread(_work)
        return rid

    async def list_anticipation_rules(self) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, trigger_kind, payload, confidence, last_fired_at"
                    " FROM anticipation_rules ORDER BY confidence DESC"
                ).fetchall()
            out: list[dict[str, Any]] = []
            for r in rows:
                try:
                    pl = json.loads(r[2])
                except json.JSONDecodeError:
                    pl = {}
                out.append({
                    "id": r[0], "trigger_kind": r[1], "payload": pl,
                    "confidence": r[3], "last_fired_at": r[4],
                })
            return out

        return await asyncio.to_thread(_work)

    async def anticipation_rule_exists(
        self, trigger_kind: str, payload_match: dict[str, Any],
    ) -> bool:
        existing = await self.list_anticipation_rules()
        for rule in existing:
            if rule["trigger_kind"] != trigger_kind:
                continue
            if all(rule["payload"].get(k) == v for k, v in payload_match.items()):
                return True
        return False

    async def touch_anticipation_rule(self, rule_id: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE anticipation_rules SET last_fired_at = ? WHERE id = ?",
                    (_now(), rule_id),
                )

        await asyncio.to_thread(_work)

    async def add_turn_feedback(
        self, *, turn_id: str, tone: str | None, length_bucket: str,
        tool_used: str | None = None,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO turn_feedback"
                    " (turn_id, tone, length_bucket, tool_used, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (turn_id, tone, length_bucket, tool_used, _now()),
                )

        await asyncio.to_thread(_work)

    async def update_turn_reaction(
        self, turn_id: str, reaction: str,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE turn_feedback SET reaction = ? WHERE turn_id = ?",
                    (reaction, turn_id),
                )

        await asyncio.to_thread(_work)

    async def get_turn_feedback_stats(self, days: int = 30) -> list[dict[str, Any]]:
        """Aggregate reactions grouped by tone + length_bucket."""
        def _work() -> list[dict[str, Any]]:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT tone, length_bucket, reaction, COUNT(*) as cnt"
                    " FROM turn_feedback WHERE created_at > ?"
                    " AND reaction IS NOT NULL"
                    " GROUP BY tone, length_bucket, reaction",
                    (cutoff,),
                ).fetchall()
            return [
                {"tone": r[0], "length_bucket": r[1], "reaction": r[2], "count": r[3]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def set_style_prefs(self, data: dict[str, Any]) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO style_prefs (id, data_json, updated_at)"
                    " VALUES (1, ?, ?)"
                    " ON CONFLICT(id) DO UPDATE SET"
                    "   data_json = excluded.data_json,"
                    "   updated_at = excluded.updated_at",
                    (json.dumps(data, ensure_ascii=False), _now()),
                )

        await asyncio.to_thread(_work)

    async def get_style_prefs(self) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT data_json FROM style_prefs WHERE id = 1"
                ).fetchone()
            if not row:
                return None
            try:
                return json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                return None

        return await asyncio.to_thread(_work)

    async def create_desktop_note(
        self, *, text: str, color: str = "yellow",
        x: int = 120, y: int = 120,
    ) -> dict[str, Any]:
        nid = str(uuid.uuid4())
        now = _now()

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO desktop_notes"
                    " (id, text, color, x, y, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (nid, text, color, x, y, now),
                )

        await asyncio.to_thread(_work)
        return {"id": nid, "text": text, "color": color, "x": x, "y": y,
                "created_at": now}

    async def list_desktop_notes(self, include_dismissed: bool = False) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                sql = (
                    "SELECT id, text, color, x, y, width, height, created_at,"
                    " dismissed_at FROM desktop_notes"
                )
                if not include_dismissed:
                    sql += " WHERE dismissed_at IS NULL"
                sql += " ORDER BY created_at DESC"
                rows = conn.execute(sql).fetchall()
            return [
                {"id": r[0], "text": r[1], "color": r[2],
                 "x": r[3], "y": r[4], "width": r[5], "height": r[6],
                 "created_at": r[7], "dismissed_at": r[8]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def update_desktop_note(
        self, note_id: str, *, x: int | None = None, y: int | None = None,
        text: str | None = None,
    ) -> None:
        def _work() -> None:
            parts: list[str] = []
            params: list[Any] = []
            if x is not None:
                parts.append("x = ?"); params.append(x)
            if y is not None:
                parts.append("y = ?"); params.append(y)
            if text is not None:
                parts.append("text = ?"); params.append(text)
            if not parts:
                return
            params.append(note_id)
            with self._connect() as conn:
                conn.execute(
                    f"UPDATE desktop_notes SET {', '.join(parts)} WHERE id = ?",
                    params,
                )

        await asyncio.to_thread(_work)

    async def dismiss_desktop_note(self, note_id: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE desktop_notes SET dismissed_at = ? WHERE id = ?",
                    (_now(), note_id),
                )

        await asyncio.to_thread(_work)

    async def list_push_subscriptions(self) -> list[dict[str, str]]:
        def _work() -> list[dict[str, str]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
                ).fetchall()
            return [
                {"endpoint": r[0], "p256dh": r[1], "auth": r[2]} for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ---------- reflect cursor ----------

    async def get_reflect_cursor(
        self, conversation_id: str | None = None,
    ) -> dict[str, str] | None:
        """Return {last_turn_id, updated_at} for the cursor, or None.

        ``conversation_id=None`` maps to the global sentinel ``__global__``.
        """
        key = conversation_id or "__global__"

        def _work() -> dict[str, str] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT last_turn_id, updated_at FROM reflect_cursor"
                    " WHERE conversation_id = ?",
                    (key,),
                ).fetchone()
            if row is None:
                return None
            return {"last_turn_id": row[0], "updated_at": row[1]}

        return await asyncio.to_thread(_work)

    async def set_reflect_cursor(
        self, conversation_id: str | None, last_turn_id: str,
    ) -> None:
        key = conversation_id or "__global__"
        now = _now()

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO reflect_cursor(conversation_id, last_turn_id, updated_at)"
                    " VALUES (?, ?, ?)"
                    " ON CONFLICT(conversation_id) DO UPDATE SET"
                    "   last_turn_id = excluded.last_turn_id,"
                    "   updated_at = excluded.updated_at",
                    (key, last_turn_id, now),
                )

        await asyncio.to_thread(_work)

    # ---------- episode windows ----------

    async def add_episode_window(
        self,
        *,
        id: str,
        conversation_id: str,
        first_turn_id: str,
        last_turn_id: str,
        turn_count: int,
        text: str,
        started_at: str,
        ended_at: str,
        created_at: str,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO episode_windows"
                    " (id, conversation_id, first_turn_id, last_turn_id,"
                    "  turn_count, text, started_at, ended_at, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (id, conversation_id, first_turn_id, last_turn_id,
                     turn_count, text, started_at, ended_at, created_at),
                )

        await asyncio.to_thread(_work)

    async def list_windows(self, limit: int = 100) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, first_turn_id, last_turn_id,"
                    " turn_count, text, started_at, ended_at, created_at"
                    " FROM episode_windows ORDER BY ended_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {
                    "id": r[0], "conversation_id": r[1],
                    "first_turn_id": r[2], "last_turn_id": r[3],
                    "turn_count": r[4], "text": r[5],
                    "started_at": r[6], "ended_at": r[7],
                    "created_at": r[8],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ---------- bulk / import helpers ----------

    async def list_all_decisions(self, limit: int = 10000) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, subject, choice, alternatives, created_at,"
                    " followed_up_at, outcome"
                    " FROM decisions ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {
                    "id": r[0], "subject": r[1], "choice": r[2],
                    "alternatives": r[3], "created_at": r[4],
                    "followed_up_at": r[5], "outcome": r[6],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def insert_narrative_raw(
        self, *, id: str, conversation_id: str, text: str,
        turn_count: int, started_at: str, ended_at: str, created_at: str,
    ) -> bool:
        """Idempotent insert (OR IGNORE). Returns True if inserted."""
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO conversation_narratives"
                    " (id, conversation_id, text, turn_count, started_at,"
                    "  ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (id, conversation_id, text, turn_count,
                     started_at, ended_at, created_at),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    async def insert_person_raw(
        self, *, id: str, name: str, relation: str | None,
        first_seen_at: str, last_mentioned_at: str,
        mention_count: int, tags: str | None,
    ) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO people"
                    " (id, name, relation, first_seen_at, last_mentioned_at,"
                    "  mention_count, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (id, name, relation, first_seen_at,
                     last_mentioned_at, mention_count, tags),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    async def insert_decision_raw(
        self, *, id: str, subject: str, choice: str,
        alternatives: str | None, created_at: str,
        followed_up_at: str | None, outcome: str | None,
    ) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO decisions"
                    " (id, subject, choice, alternatives, created_at,"
                    "  followed_up_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (id, subject, choice, alternatives,
                     created_at, followed_up_at, outcome),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    async def insert_open_loop_raw(
        self, *, id: str, text: str, owner: str, created_at: str,
        resolved_at: str | None, resolution: str | None,
        injection_count: int,
    ) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO open_loops"
                    " (id, text, owner, created_at, resolved_at,"
                    "  resolution, injection_count)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (id, text, owner, created_at, resolved_at,
                     resolution, injection_count),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    async def insert_window_raw(
        self, *, id: str, conversation_id: str,
        first_turn_id: str, last_turn_id: str,
        turn_count: int, text: str,
        started_at: str, ended_at: str, created_at: str,
    ) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO episode_windows"
                    " (id, conversation_id, first_turn_id, last_turn_id,"
                    "  turn_count, text, started_at, ended_at, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (id, conversation_id, first_turn_id, last_turn_id,
                     turn_count, text, started_at, ended_at, created_at),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)
