"""028-B — Anticipatory suggestions.

Detects recurring time-of-day usage patterns in the event_timeline and
stores them as anticipation rules. On each turn (or opener tick),
checks whether the current local time falls within a known rule
window and, if so, adds a subtle hint to the prompt.

Intentionally conservative:
- Need ≥ 3 occurrences in the same (weekday, 2-hour window).
- Only tool_use events count (proxy for concrete actions).
- Don't re-fire the same rule within 12h.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger("seraphine.anticipation")

TZ = ZoneInfo("America/Sao_Paulo")

_MIN_OCCURRENCES = 3
_LOOKBACK_DAYS = 21  # 3 weeks of history
_HOUR_WINDOW = 2
_COOLDOWN_HOURS = 12


class AnticipationService:
    def __init__(self, store: Any) -> None:
        self.store = store

    async def detect_patterns(self) -> int:
        """Scan timeline and create new rules. Returns count of new rules."""
        try:
            cutoff = (
                datetime.now(TZ) - timedelta(days=_LOOKBACK_DAYS)
            ).astimezone().isoformat()
            events = await self.store.get_events_since(cutoff)
        except Exception as e:
            logger.debug("detect_patterns: get_events_since failed: %s", e)
            return 0
        if not events:
            return 0

        buckets: dict[tuple[str, int, int], int] = defaultdict(int)
        for e in events:
            if e.get("event_type") != "tool_used":
                continue
            created = e.get("created_at") or ""
            try:
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except ValueError:
                continue
            dt_local = dt.astimezone(TZ)
            weekday = dt_local.weekday()  # 0=Mon
            hour_bucket = (dt_local.hour // _HOUR_WINDOW) * _HOUR_WINDOW

            metadata = e.get("metadata") or {}
            if isinstance(metadata, str):
                try:
                    import json as _j
                    metadata = _j.loads(metadata)
                except Exception:
                    metadata = {}
            tool = metadata.get("tool") or metadata.get("name") or "unknown"
            if tool == "unknown":
                continue
            buckets[(tool, weekday, hour_bucket)] += 1

        inserted = 0
        for (tool, weekday, hour), count in buckets.items():
            if count < _MIN_OCCURRENCES:
                continue
            payload = {
                "tool": tool, "weekday": weekday, "hour_start": hour,
                "hour_end": hour + _HOUR_WINDOW,
            }
            if await self.store.anticipation_rule_exists(
                "tool_use_pattern", payload,
            ):
                continue
            confidence = min(1.0, count / 6.0)
            await self.store.add_anticipation_rule(
                trigger_kind="tool_use_pattern",
                payload=payload,
                confidence=confidence,
            )
            inserted += 1
        if inserted:
            logger.info("anticipation: %d new rules", inserted)
        return inserted

    async def current_hint(self) -> str | None:
        """Return a hint string if a rule fires at the current time."""
        rules = await self.store.list_anticipation_rules()
        if not rules:
            return None
        now = datetime.now(TZ)
        for rule in rules:
            if rule["trigger_kind"] != "tool_use_pattern":
                continue
            p = rule["payload"]
            if p.get("weekday") != now.weekday():
                continue
            hour_start = p.get("hour_start", 0)
            hour_end = p.get("hour_end", 24)
            if not (hour_start <= now.hour < hour_end):
                continue
            # Cooldown: skip if fired < 12h ago.
            last = rule.get("last_fired_at")
            if last:
                try:
                    last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
                    if (now.astimezone(last_dt.tzinfo) - last_dt) < timedelta(
                        hours=_COOLDOWN_HOURS
                    ):
                        continue
                except ValueError:
                    pass
            if rule.get("confidence", 0) < 0.5:
                continue
            await self.store.touch_anticipation_rule(rule["id"])
            tool = p.get("tool", "algo")
            return (
                f"ANTICIPATION (padrão observado — ~{int(rule['confidence']*100)}% "
                f"conf): ele costuma usar '{tool}' nesse horário. Se fizer sentido "
                f"contextual, ofereça antes dele pedir. Não force."
            )
        return None
