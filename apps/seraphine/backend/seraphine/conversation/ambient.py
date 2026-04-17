"""023-A/B — Ambient context + prosody awareness.

Injects stable "present moment" signals into every turn's system prompt
so Seraphine connects replies to what's happening NOW (next meeting,
yesterday's sleep, pending tasks) without the user having to tell her.

Cheap by design: all upstream calls are already cached by their
respective services; this module just formats their outputs into a
compact prompt snippet.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger("seraphine.ambient")

TZ = ZoneInfo("America/Sao_Paulo")

# Ambient cache windows (seconds).
_CACHE_TTL = {
    "calendar": 300,   # 5 min
    "health": 600,     # 10 min
    "tasks": 60,       # 1 min
    "weather": 1800,   # 30 min
}


class AmbientCache:
    """Process-wide cache so each turn doesn't re-fetch upstream APIs."""

    def __init__(self) -> None:
        self._entries: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        ts, value = entry
        ttl = _CACHE_TTL.get(key, 60)
        if time.monotonic() - ts > ttl:
            return None
        return value

    def put(self, key: str, value: Any) -> None:
        self._entries[key] = (time.monotonic(), value)


async def _fetch_next_event(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("calendar")
    if cached is not None:
        return cached or None

    gc = getattr(app_state, "google_client", None)
    if gc is None:
        cache.put("calendar", "")
        return None

    now = datetime.now(timezone.utc)
    try:
        events = await gc.list_events(
            time_min=now,
            time_max=now + timedelta(hours=4),
            max_results=5,
        )
    except Exception as e:
        logger.debug("ambient calendar fetch failed: %s", e)
        cache.put("calendar", "")
        return None

    if not events:
        cache.put("calendar", "")
        return None

    ev = events[0]
    title = ev.get("summary") or "evento sem título"
    start = ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date")
    if not start:
        cache.put("calendar", "")
        return None
    try:
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    except ValueError:
        cache.put("calendar", "")
        return None
    gap = start_dt - now
    gap_min = int(gap.total_seconds() // 60)
    if gap_min < 0 or gap_min > 240:
        cache.put("calendar", "")
        return None

    if gap_min <= 90:
        formatted = f"- próximo evento: '{title}' em {gap_min}min"
    else:
        formatted = f"- próximo evento: '{title}' em {gap_min // 60}h"
    cache.put("calendar", formatted)
    return formatted


async def _fetch_health(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("health")
    if cached is not None:
        return cached or None

    hs = getattr(app_state, "health_service", None)
    if hs is None:
        cache.put("health", "")
        return None

    try:
        # Get most recent snapshot — could be today OR yesterday.
        snaps = await hs.get_recent(days=2)
    except Exception as e:
        logger.debug("ambient health fetch failed: %s", e)
        cache.put("health", "")
        return None
    if not snaps:
        cache.put("health", "")
        return None

    snap = snaps[0]
    parts: list[str] = []
    sleep_h = getattr(snap, "sleep_hours", None)
    if sleep_h is not None and sleep_h > 0:
        parts.append(f"{sleep_h:.1f}h sono")
    steps = getattr(snap, "steps", None)
    if steps is not None and steps > 0:
        parts.append(f"{steps} passos")
    if not parts:
        cache.put("health", "")
        return None

    date = getattr(snap, "date", None)
    label = "ontem" if date and date != datetime.now(TZ).date().isoformat() else "hoje"
    formatted = f"- {label}: {', '.join(parts)}"
    cache.put("health", formatted)
    return formatted


async def _fetch_tasks_today(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("tasks")
    if cached is not None:
        return cached or None

    ts = getattr(app_state, "task_service", None)
    if ts is None:
        cache.put("tasks", "")
        return None

    today_iso = datetime.now(TZ).date().isoformat()
    try:
        if hasattr(ts, "list_due_on"):
            rows = await ts.list_due_on(today_iso)
        else:
            rows = await ts.list_open() if hasattr(ts, "list_open") else []
    except Exception as e:
        logger.debug("ambient tasks fetch failed: %s", e)
        cache.put("tasks", "")
        return None

    open_today = []
    for t in rows[:5]:
        status = getattr(t, "status", None) or (
            t.get("status") if isinstance(t, dict) else None
        )
        if status == "done":
            continue
        title = getattr(t, "title", None) or (
            t.get("title") if isinstance(t, dict) else None
        )
        if title:
            open_today.append(title)
    if not open_today:
        cache.put("tasks", "")
        return None
    joined = ", ".join(open_today[:3])
    formatted = f"- hoje ({len(open_today)} tarefa(s)): {joined}"
    cache.put("tasks", formatted)
    return formatted


async def build_ambient_block(app_state: Any) -> str | None:
    """Return a system-message snippet with current-moment signals, or
    None when nothing notable is happening."""
    cache: AmbientCache | None = getattr(app_state, "ambient_cache", None)
    if cache is None:
        cache = AmbientCache()
        app_state.ambient_cache = cache

    lines = []
    for fetcher in (_fetch_next_event, _fetch_health, _fetch_tasks_today):
        try:
            val = await fetcher(app_state, cache)
        except Exception as e:
            logger.debug("ambient fetcher %s failed: %s", fetcher.__name__, e)
            continue
        if val:
            lines.append(val)

    if not lines:
        return None
    return (
        "AMBIENT (contexto que você 'percebeu' do presente — NÃO liste "
        "isso pra ele, só use quando relevante):\n" + "\n".join(lines)
    )


def prosody_hint(meta: dict | None) -> str | None:
    """Turn audio prosody metadata into a natural-language hint."""
    if not meta:
        return None
    parts: list[str] = []
    rate_wpm = meta.get("rate_wpm", 0)
    if rate_wpm and rate_wpm < 90:
        parts.append("fala lenta")
    elif rate_wpm and rate_wpm > 180:
        parts.append("fala rápida/agitada")
    rms = meta.get("rms_avg")
    if rms is not None and rms < 0.05:
        parts.append("tom baixo")
    elif rms is not None and rms > 0.25:
        parts.append("tom alto/urgente")
    if not parts:
        return None
    return (
        f"VOZ ATUAL: {', '.join(parts)} — ajuste sua energia em cima disso, "
        f"sem comentar."
    )
