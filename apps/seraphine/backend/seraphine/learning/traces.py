"""Cheap, fire-and-forget interaction-trace capture for the learning loop."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


def derive_signal(reaction: str | None) -> float | None:
    """Map a user reaction to a quality signal in [0,1]; None when unknown."""
    if not reaction:
        return None
    r = reaction.strip().lower()
    if r in ("up", "thumbs_up", "positive", "good", "\U0001f44d"):
        return 1.0
    if r in ("down", "thumbs_down", "negative", "bad", "\U0001f44e"):
        return 0.0
    return None


async def record_trace(
    store: Any,
    *,
    conversation_id: str | None,
    turn_id: str | None,
    user_msg: str,
    assistant_msg: str,
    tools: list[str] | None = None,
    feature: str = "chat",
    signal: float | None = None,
) -> None:
    """Insert one learning_trace row. Swallows all errors (never breaks a turn)."""

    def _work() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO learning_trace (id, ts, conversation_id, turn_id, "
                "user_msg, assistant_msg, tools_json, feature, signal) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    datetime.now(timezone.utc).isoformat(),
                    conversation_id,
                    turn_id,
                    (user_msg or "")[:4000],
                    (assistant_msg or "")[:8000],
                    json.dumps(tools or []),
                    feature,
                    signal,
                ),
            )

    try:
        await asyncio.to_thread(_work)
    except Exception as e:  # noqa: BLE001
        logger.debug("record_trace failed: %s", e)


async def recent_traces(
    store: Any, *, limit: int = 50, prefer_low_signal: bool = False
) -> list[dict[str, Any]]:
    """Read recent traces as dicts. prefer_low_signal sorts NULL/low signal first."""
    cols = [
        "id",
        "ts",
        "conversation_id",
        "turn_id",
        "user_msg",
        "assistant_msg",
        "tools_json",
        "feature",
        "signal",
    ]

    def _work() -> list[dict[str, Any]]:
        order = (
            "signal IS NOT NULL, signal ASC, ts DESC"
            if prefer_low_signal
            else "ts DESC"
        )
        with store._connect() as conn:
            rows = conn.execute(
                "SELECT id, ts, conversation_id, turn_id, user_msg, assistant_msg, "
                "tools_json, feature, signal FROM learning_trace "
                f"ORDER BY {order} LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    return await asyncio.to_thread(_work)
