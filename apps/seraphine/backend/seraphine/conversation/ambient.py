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
    "mood": 300,       # 5 min
    "focus": 120,      # 2 min
    "goals": 600,      # 10 min
    "reading": 600,    # 10 min
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


async def _fetch_mood(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("mood")
    if cached is not None:
        return cached or None

    ms = getattr(app_state, "mood_service", None)
    if ms is None:
        cache.put("mood", "")
        return None

    try:
        data = await ms.get_today()
    except Exception as e:
        logger.debug("ambient mood fetch failed: %s", e)
        cache.put("mood", "")
        return None

    current = data.get("current")
    if not current:
        cache.put("mood", "")
        return None

    label = current.get("label", "")
    valence = current.get("valence", 0.0)
    formatted = f"- humor atual: {label} (valence: {valence:.1f})"
    cache.put("mood", formatted)
    return formatted


async def _fetch_focus_today(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("focus")
    if cached is not None:
        return cached or None

    fs = getattr(app_state, "focus_service", None)
    if fs is None:
        cache.put("focus", "")
        return None

    now_sp = datetime.now(TZ)
    today_start = now_sp.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = now_sp.replace(hour=23, minute=59, second=59, microsecond=0)
    start_utc = today_start.astimezone(timezone.utc).isoformat()
    end_utc = today_end.astimezone(timezone.utc).isoformat()

    try:
        sessions = await fs.get_sessions(start_utc, end_utc)
    except Exception as e:
        logger.debug("ambient focus fetch failed: %s", e)
        cache.put("focus", "")
        return None

    work = [s for s in sessions if s.type == "work"]
    if not work:
        cache.put("focus", "")
        return None

    total_min = sum(s.duration_sec for s in work) // 60
    hours = total_min / 60
    formatted = f"- foco hoje: {hours:.1f}h em {len(work)} sessao(oes)"
    cache.put("focus", formatted)
    return formatted


async def _fetch_goals_at_risk(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("goals")
    if cached is not None:
        return cached or None

    gs = getattr(app_state, "goal_service", None)
    if gs is None:
        cache.put("goals", "")
        return None

    try:
        summary = await gs.get_summary()
    except Exception as e:
        logger.debug("ambient goals fetch failed: %s", e)
        cache.put("goals", "")
        return None

    if summary.goals_at_risk <= 0:
        cache.put("goals", "")
        return None

    formatted = f"- objetivos em risco: {summary.goals_at_risk}"
    cache.put("goals", formatted)
    return formatted


async def _fetch_reading_backlog(app_state: Any, cache: AmbientCache) -> str | None:
    cached = cache.get("reading")
    if cached is not None:
        return cached or None

    rs = getattr(app_state, "reading_service", None)
    if rs is None:
        cache.put("reading", "")
        return None

    try:
        unread = await rs.list_items(status="unread", limit=200)
    except Exception as e:
        logger.debug("ambient reading fetch failed: %s", e)
        cache.put("reading", "")
        return None

    if not unread:
        cache.put("reading", "")
        return None

    formatted = f"- leitura pendente: {len(unread)} artigo(s)"
    cache.put("reading", formatted)
    return formatted


async def build_ambient_block(app_state: Any) -> str | None:
    """Return a system-message snippet with current-moment signals, or
    None when nothing notable is happening."""
    cache: AmbientCache | None = getattr(app_state, "ambient_cache", None)
    if cache is None:
        cache = AmbientCache()
        app_state.ambient_cache = cache

    lines = []
    for fetcher in (
        _fetch_next_event,
        _fetch_health,
        _fetch_tasks_today,
        _fetch_mood,
        _fetch_focus_today,
        _fetch_goals_at_risk,
        _fetch_reading_backlog,
    ):
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
