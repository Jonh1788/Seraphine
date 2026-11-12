"""Helpers shared by the phase 6c part 2 tests (archive, agent page, usage, team undo)."""

from __future__ import annotations

import uuid
from typing import Any

from .chat_helpers import api, make_agent  # noqa: F401  (re-exported for the tests)


async def add_run(svc: Any, agent_id: str, project_id: str, *, created_at: str, status: str = "done",
                  requested_by: str = "user", tokens_in: int = 0, tokens_out: int = 0,
                  cost: float = 0.0) -> str:
    """A stored run (no engine is involved): the tests decide its date, state, tokens and cost."""
    rid = str(uuid.uuid4())
    await svc._db(lambda c: c.execute(
        "INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, requested_by, tokens_in,"
        " tokens_out, cost_usd, created_at) VALUES (?, ?, ?, 'meta', ?, 'fake', ?, ?, ?, ?, ?)",
        (rid, agent_id, project_id, status, requested_by, tokens_in, tokens_out, cost, created_at)))
    return rid


async def home_of(svc: Any, agent_id: str) -> dict[str, Any]:
    return await svc.ensure_home(agent_id)
