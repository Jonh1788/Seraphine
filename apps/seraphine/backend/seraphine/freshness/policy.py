"""Single source of truth for "what is fresh?" decisions.

Used by:
- Opener (openers/service.py) — filter context bundle before LLM call
- Day-review (proactive/scheduler.py) — same purpose
- Per-turn engine (conversation/engine.py) — ambient/recall/profile blocks
- Vector recall (memory/manager.py) — the `since` filter
- Housekeeping (freshness/housekeeping.py) — auto-archive

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

    Defaults tuned for "human assistant" behaviour:
    - 72h surfaces dateless items the user just mentioned
    - 7d post-create + 3d pre-event captures dated items both right
      after creation AND as the date approaches
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
            # post-event (recall)
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

        Returns: (fragment_string, params_list). Fragment is wrapped in
        parens and contains no leading keyword — caller prepends AND/WHERE.

        Recency-only (event_col=None):
            ({created_col} > ?)

        With event column:
            (
              {created_col} > ?
              OR {created_col} > ?
              OR ({event_col} BETWEEN ? AND ?)
              OR ({event_col} BETWEEN ? AND ?)
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
