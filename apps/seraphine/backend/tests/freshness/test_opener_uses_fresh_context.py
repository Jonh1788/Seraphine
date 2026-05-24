"""Tests for opener context building — must pass fresh_only=True to DAOs
and omit empty sections from the prompt, plus the softened rule #5.

The opener's contract under the freshness regime:
 1. The prompt template (rule #5) must NOT force a concrete hook when
    there's no fresh context — softened to "se houver contexto fresco,
    abra com gancho; se não houver, cumprimente leve e pare; sem inventar".
 2. ``_context_tasks_section`` must filter by recency — stale (>=14d old,
    no near event_date) tasks must NOT appear in the rendered section.
 3. ``_context_open_loops_section`` must call
    ``store.list_open_loops(..., fresh_only=True)``.
 4. When a DAO returns nothing, the section is the empty string and the
    final prompt does not contain its label (e.g. "tarefas em aberto").
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from seraphine.memory import store as memory_store
from seraphine.memory.store import MemoryStore
from seraphine.openers import service as opener_service
from seraphine.openers.service import OpenerService, _OPENER_PROMPT_TEMPLATE


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ---------------------------------------------------------------------------
# 1. Prompt template — rule #5 softened
# ---------------------------------------------------------------------------


def test_opener_prompt_softens_rule_5() -> None:
    """Rule #5 must allow a leve greeting when no fresh context exists,
    and must explicitly tell the LLM not to invent hooks.

    The exact wording can vary, but at least one of the marker phrases
    in the assertion below must appear so the prompt no longer demands
    a concrete hook unconditionally."""
    template = _OPENER_PROMPT_TEMPLATE
    lower = template.lower()
    assert any(
        phrase in lower
        for phrase in (
            "se não houver contexto fresco",
            "não invente",
            "sem inventar",
        )
    ), (
        "Rule #5 still forces a hook unconditionally. "
        f"Template head:\n{template[:600]}"
    )


# ---------------------------------------------------------------------------
# 2. tasks section — recency filter applied inline
# ---------------------------------------------------------------------------


@pytest.fixture
async def real_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> MemoryStore:
    """A real MemoryStore + freshness schema, with `now` pinned to NOW
    so we can backdate rows deterministically."""
    monkeypatch.setattr(
        memory_store, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )
    monkeypatch.setattr(
        opener_service, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )
    s = MemoryStore(tmp_path / "opener_fresh.sqlite")
    await s.ensure_schema()
    # ``seraphine_tasks`` is owned by mod-tasks (separate schema migration).
    # The opener reads it directly via raw SQL, so we create a minimal
    # version here for the tasks-section tests.
    with s._connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS seraphine_tasks ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " title TEXT NOT NULL,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " due_date TEXT,"
            " created_at TEXT NOT NULL"
            ")"
        )
    return s


def _insert_task(
    store: MemoryStore,
    *,
    title: str,
    created_at: str,
    due_date: str | None = None,
    status: str = "pending",
) -> None:
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO seraphine_tasks"
            " (title, status, due_date, created_at)"
            " VALUES (?, ?, ?, ?)",
            (title, status, due_date, created_at),
        )


async def test_opener_tasks_section_excludes_stale(
    real_store: MemoryStore,
) -> None:
    """The opener's tasks section must apply the freshness filter — old
    pending tasks with no near due_date must NOT appear."""
    _insert_task(
        real_store,
        title="tarefa-fresca",
        created_at=_iso(NOW - timedelta(hours=1)),
    )
    _insert_task(
        real_store,
        title="tarefa-velha-sem-data",
        created_at=_iso(NOW - timedelta(days=30)),
    )

    svc = OpenerService(real_store, llm=None)
    section = await svc._context_tasks_section()

    assert "tarefa-fresca" in section, (
        f"Fresh task should appear. Section:\n{section!r}"
    )
    assert "tarefa-velha-sem-data" not in section, (
        "Stale undated task leaked into opener context. "
        f"Section:\n{section!r}"
    )


async def test_opener_tasks_section_empty_when_no_fresh(
    real_store: MemoryStore,
) -> None:
    """When every task is stale, the section is empty (omitted from
    the prompt) — not a literal 'tarefas em aberto: nenhuma' line."""
    _insert_task(
        real_store,
        title="velha",
        created_at=_iso(NOW - timedelta(days=30)),
    )
    svc = OpenerService(real_store, llm=None)
    section = await svc._context_tasks_section()
    assert section == "", (
        f"Section must be empty string when no fresh tasks; got: {section!r}"
    )


# ---------------------------------------------------------------------------
# 3. open_loops section — fresh_only=True passed to DAO
# ---------------------------------------------------------------------------


async def test_opener_open_loops_section_uses_fresh_only(
    real_store: MemoryStore,
) -> None:
    """``_context_open_loops_section`` must pass ``fresh_only=True`` to
    ``store.list_open_loops``."""
    spy = AsyncMock(return_value=[])
    # Wrap the real store with a spy on list_open_loops.
    mock_store = MagicMock()
    mock_store.list_open_loops = spy
    svc = OpenerService(mock_store, llm=None)
    await svc._context_open_loops_section()

    assert spy.await_count >= 1, "list_open_loops was not awaited"
    found = any(
        call.kwargs.get("fresh_only") is True
        for call in spy.call_args_list
    )
    assert found, (
        "No call to list_open_loops had fresh_only=True. "
        f"Calls: {spy.call_args_list}"
    )


async def test_opener_open_loops_section_excludes_stale(
    real_store: MemoryStore,
) -> None:
    """End-to-end: a stale open loop must not appear in the section."""
    await real_store.add_open_loop(text="ignore-me")
    # Backdate it to make it stale.
    with real_store._connect() as conn:
        conn.execute(
            "UPDATE open_loops SET created_at = ? WHERE text = ?",
            (_iso(NOW - timedelta(days=10)), "ignore-me"),
        )
    # And insert a fresh one directly.
    with real_store._connect() as conn:
        conn.execute(
            "INSERT INTO open_loops"
            " (id, text, owner, created_at, injection_count)"
            " VALUES (?, ?, ?, ?, 0)",
            ("fresh-loop", "loop-recente", "user",
             _iso(NOW - timedelta(hours=1))),
        )

    svc = OpenerService(real_store, llm=None)
    section = await svc._context_open_loops_section()
    assert "loop-recente" in section
    assert "ignore-me" not in section


# ---------------------------------------------------------------------------
# 4. Empty-section omission — final prompt has no 'nenhuma' / leftover labels
# ---------------------------------------------------------------------------


async def test_opener_omits_empty_tasks_section(
    real_store: MemoryStore,
) -> None:
    """When the tasks DAO yields nothing fresh, the rendered section
    must be empty (so the prompt simply has no 'tarefas em aberto' label
    rather than 'tarefas em aberto: nenhuma' or a dangling header)."""
    # No rows inserted at all.
    svc = OpenerService(real_store, llm=None)
    section = await svc._context_tasks_section()
    assert section == ""
    assert "tarefas em aberto" not in section
    assert "nenhuma" not in section.lower()


# ---------------------------------------------------------------------------
# 5. day_review (proactive scheduler) — separate LLM path, own prompt
# ---------------------------------------------------------------------------
#
# `_tick_day_review` (21:00 daily) builds its context bundle from
# ``store.get_recent_turns`` filtered to *today* only — by construction
# that source is intrinsically fresh, so there is no ``list_tasks`` /
# ``list_open_loops`` / ``list_facts`` call site to thread ``fresh_only=True``
# through. What CAN still produce confabulation is the prompt template:
# if today's turn excerpt is sparse the model is otherwise nudged to
# invent "o que ele fez hoje" content from stale priors.  So the
# equivalent of the opener's softened rule #5 applies here.
#
# Spec ref: docs/superpowers/specs/2026-05-23-seraphine-freshness-design.md
# §"Day-review broadcast" — "rule do prompt também ganha versão
# suavizada equivalente à do opener (regra #5)".


def test_day_review_prompt_softens_invention_rule() -> None:
    """``_DAY_REVIEW_PROMPT`` must explicitly forbid inventing content
    when today's chat excerpt is sparse — mirrors the opener's rule #5
    softening from Task 7."""
    from seraphine.proactive.scheduler import _DAY_REVIEW_PROMPT

    lower = _DAY_REVIEW_PROMPT.lower()
    assert any(
        phrase in lower
        for phrase in (
            "se não houver",
            "não invente",
            "sem inventar",
            "sem confabular",
        )
    ), (
        "Day-review prompt still allows confabulation when today's chat "
        "is sparse. Template:\n"
        f"{_DAY_REVIEW_PROMPT}"
    )


@pytest.mark.asyncio
async def test_day_review_does_not_call_stale_dao_paths() -> None:
    """Regression: if a future refactor adds ``list_tasks`` /
    ``list_open_loops`` / ``list_facts`` to the day-review context
    bundle, those calls MUST pass ``fresh_only=True``. Today the bundle
    only reads ``get_recent_turns`` (today's chat, intrinsically fresh),
    so we assert the absence of stale DAO calls."""
    from datetime import datetime as _dt

    from seraphine.proactive.scheduler import (
        TZ as _TZ,
        ProactiveScheduler,
    )

    # Today's date so get_recent_turns rows match the today-filter.
    today_iso = _dt.now(_TZ).date().isoformat()

    fake_turn = MagicMock()
    fake_turn.role = "user"
    fake_turn.content = "oi, terminei o relatório hoje"
    fake_turn.created_at = f"{today_iso}T10:00:00"

    store = MagicMock()
    store.get_recent_turns = AsyncMock(return_value=[fake_turn] * 5)
    store.list_tasks = AsyncMock(return_value=[])
    store.list_open_loops = AsyncMock(return_value=[])
    store.list_facts = AsyncMock(return_value=[])
    store.add_event = AsyncMock()

    async def _fake_chat(*_a, **_kw):
        # Empty async iterator — _llm_quick will produce empty text and bail.
        if False:
            yield None
        return

    llm = MagicMock()
    llm.chat = _fake_chat

    app_state = MagicMock()
    app_state.store = store
    app_state.llm = llm
    app_state.ws_clients = set()

    sched = ProactiveScheduler(app_state, enabled=False)
    await sched._tick_day_review()

    # Either zero calls (current shape) OR if a future refactor adds
    # them, every call must opt into fresh_only.
    for dao_name in ("list_tasks", "list_open_loops", "list_facts"):
        dao = getattr(store, dao_name)
        for call in dao.call_args_list:
            assert call.kwargs.get("fresh_only") is True, (
                f"day_review called store.{dao_name} without fresh_only=True: "
                f"{call}"
            )
