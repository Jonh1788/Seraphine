"""030-B — Finance ambient watcher.

Scans the last 30d of financial_entries per category, computes a
rolling weekly baseline, and flags anomalies on the current 7d window.
Anomalies persist as finance_nudges (dedup'd per category per week)
for the opener service to surface once.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger("seraphine.finance_ambient")

TZ = ZoneInfo("America/Sao_Paulo")

_RATIO_THRESHOLD = 2.0  # week_total > 2 × 4-week average
_MIN_DELTA_BRL = 100.0
_MIN_CATEGORY_ENTRIES = 3


class FinanceAmbientService:
    def __init__(self, finance_service: Any, store: Any) -> None:
        self.finance_service = finance_service
        self.store = store

    async def detect_and_store(self) -> int:
        """Returns the number of new anomalies inserted."""
        if self.finance_service is None:
            return 0
        now = datetime.now(TZ)

        try:
            entries = await self.finance_service.list_entries(limit=1000)
        except Exception as e:
            logger.debug("list_entries failed: %s", e)
            return 0
        if not entries:
            return 0

        # Group by category, split 0-7d (week) vs 8-35d (baseline).
        week_cutoff = (now - timedelta(days=7)).date().isoformat()
        baseline_cutoff = (now - timedelta(days=35)).date().isoformat()

        week_totals: dict[str, float] = defaultdict(float)
        baseline_totals: dict[str, float] = defaultdict(float)
        category_counts: dict[str, int] = defaultdict(int)

        for e in entries:
            date_str = getattr(e, "date", None) or e.get("date") if isinstance(e, dict) else None
            if not date_str:
                continue
            amount = abs(float(getattr(e, "amount", 0) or 0))
            cat = getattr(e, "category", "outros") or "outros"
            entry_type = getattr(e, "type", "expense")
            if entry_type != "expense":
                continue
            if date_str < baseline_cutoff:
                continue
            category_counts[cat] += 1
            if date_str >= week_cutoff:
                week_totals[cat] += amount
            else:
                baseline_totals[cat] += amount

        inserted = 0
        for cat, week_total in week_totals.items():
            if category_counts[cat] < _MIN_CATEGORY_ENTRIES:
                continue
            # Baseline is the 28-day average scaled to 7 days.
            baseline = baseline_totals.get(cat, 0.0) / 4.0
            if baseline < 10:  # too noisy at low amounts
                continue
            delta = week_total - baseline
            if delta < _MIN_DELTA_BRL:
                continue
            ratio = week_total / baseline if baseline > 0 else 999
            if ratio < _RATIO_THRESHOLD:
                continue
            # Dedup: skip if already flagged this week.
            if await self.store.finance_nudge_exists_this_week(cat):
                continue
            headline = (
                f"Gasto em {cat}: R$ {week_total:.0f} essa semana "
                f"({ratio:.1f}× a média de R$ {baseline:.0f})"
            )
            try:
                await self.store.add_finance_nudge(
                    category=cat, ratio=ratio, week_total=week_total,
                    baseline=baseline, headline=headline,
                )
                inserted += 1
            except Exception as e:
                logger.debug("add_finance_nudge failed: %s", e)
        if inserted:
            logger.info("finance: %d anomaly nudges", inserted)
        return inserted
