"""MoodService -- persist and query mood events as time series.

Single-tenant: no user_id scoping. Mood events originate from the
conversation engine (source=conversation) or manual check-ins
(source=manual). Days are bucketed in America/Sao_Paulo time.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.mood.models import MoodLog, resolve_va

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


_LOG_COLS = "id, timestamp, label, valence, arousal, source, turn_id"


def _row_to_log(row: tuple[Any, ...]) -> MoodLog:
    return MoodLog(
        id=str(row[0]),
        timestamp=str(row[1]),
        label=str(row[2]),
        valence=float(row[3]),
        arousal=float(row[4]),
        source=str(row[5]),
        turn_id=str(row[6]) if row[6] is not None else None,
    )


class MoodService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    async def log_mood(
        self,
        label: str,
        *,
        source: str = "conversation",
        turn_id: str | None = None,
        valence: float | None = None,
        arousal: float | None = None,
    ) -> MoodLog:
        """Persist a mood event. Valence/arousal are auto-resolved from
        the label unless explicitly provided."""
        v, a = resolve_va(label, valence=valence, arousal=arousal)
        mid = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> MoodLog:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO mood_logs ({_LOG_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (mid, ts, label.lower(), v, a, source, turn_id),
                )
                row = conn.execute(
                    f"SELECT {_LOG_COLS} FROM mood_logs WHERE id = ?",
                    (mid,),
                ).fetchone()
            return _row_to_log(row)

        return await asyncio.to_thread(_work)

    async def checkin(
        self,
        label: str,
        *,
        valence: float | None = None,
        arousal: float | None = None,
    ) -> MoodLog:
        """Manual mood check-in (source=manual)."""
        return await self.log_mood(
            label,
            source="manual",
            valence=valence,
            arousal=arousal,
        )

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_today(self) -> dict[str, Any]:
        """Return today's mood data: current (latest), averages, and logs."""
        today = _today_sp()
        start_utc = datetime(
            today.year, today.month, today.day,
            tzinfo=_SP_TZ,
        ).astimezone(timezone.utc).isoformat()
        end_utc = datetime(
            today.year, today.month, today.day,
            hour=23, minute=59, second=59,
            tzinfo=_SP_TZ,
        ).astimezone(timezone.utc).isoformat()

        def _work() -> list[MoodLog]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_LOG_COLS} FROM mood_logs"
                    " WHERE timestamp BETWEEN ? AND ?"
                    " ORDER BY timestamp DESC",
                    (start_utc, end_utc),
                ).fetchall()
            return [_row_to_log(r) for r in rows]

        logs = await asyncio.to_thread(_work)
        if not logs:
            return {
                "current": None,
                "avg_valence": 0.0,
                "avg_arousal": 0.0,
                "logs": [],
            }

        avg_v = sum(l.valence for l in logs) / len(logs)
        avg_a = sum(l.arousal for l in logs) / len(logs)
        return {
            "current": logs[0].to_dict(),
            "avg_valence": round(avg_v, 3),
            "avg_arousal": round(avg_a, 3),
            "logs": [l.to_dict() for l in logs],
        }

    async def get_trend(self, days: int = 14) -> dict[str, Any]:
        """Return per-day aggregates for the last N days."""
        n = int(days)
        if n <= 0 or n > 365:
            raise ValueError("days must be 1..365")

        today = _today_sp()
        start_date = today - timedelta(days=n - 1)

        # Convert day boundaries to UTC for querying
        start_utc = datetime(
            start_date.year, start_date.month, start_date.day,
            tzinfo=_SP_TZ,
        ).astimezone(timezone.utc).isoformat()
        end_utc = datetime(
            today.year, today.month, today.day,
            hour=23, minute=59, second=59,
            tzinfo=_SP_TZ,
        ).astimezone(timezone.utc).isoformat()

        def _work() -> list[MoodLog]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_LOG_COLS} FROM mood_logs"
                    " WHERE timestamp BETWEEN ? AND ?"
                    " ORDER BY timestamp ASC",
                    (start_utc, end_utc),
                ).fetchall()
            return [_row_to_log(r) for r in rows]

        logs = await asyncio.to_thread(_work)

        # Group by SP date
        by_day: dict[str, list[MoodLog]] = defaultdict(list)
        for log in logs:
            try:
                ts = datetime.fromisoformat(log.timestamp)
                sp_date = ts.astimezone(_SP_TZ).date().isoformat()
            except (ValueError, TypeError):
                continue
            by_day[sp_date].append(log)

        result: list[dict[str, Any]] = []
        d = start_date
        while d <= today:
            iso = d.isoformat()
            day_logs = by_day.get(iso, [])
            if day_logs:
                avg_v = sum(l.valence for l in day_logs) / len(day_logs)
                avg_a = sum(l.arousal for l in day_logs) / len(day_logs)
                # Predominant label: most frequent
                label_counts: dict[str, int] = defaultdict(int)
                for l in day_logs:
                    label_counts[l.label] += 1
                predominant = max(label_counts, key=lambda k: label_counts[k])
                result.append({
                    "date": iso,
                    "avg_valence": round(avg_v, 3),
                    "avg_arousal": round(avg_a, 3),
                    "predominant_label": predominant,
                    "count": len(day_logs),
                })
            d += timedelta(days=1)

        return {"days": result}
