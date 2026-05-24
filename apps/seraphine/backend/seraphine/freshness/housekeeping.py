"""Auto-archive stale items (per FreshnessPolicy).

Runs daily as a scheduled cron from main.py (wired in Task 11).
Idempotent — second pass on same data is a no-op because
already-archived rows are excluded by the WHERE clauses.

Per-table blocks are isolated in try/except so one table failing
doesn't abort the others.
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
