"""PlanningService -- generate context-aware daily plans (SDD 093).

Single-tenant. Aggregates Google Calendar, tasks, habits, and health
data into a heuristic time-block plan. Optionally polishes block
reasons via the LLM.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.planning.types import (
    DailyPlan,
    PlanContext,
    PlanFeedback,
    TimeBlock,
)

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")

# Block-type colour hints (consumed by the frontend; echoed in the API)
_BLOCK_TYPES = {"focus", "meeting", "break", "exercise", "admin", "free"}

# Heuristic tuning knobs
_PLAN_START_HOUR = 6
_PLAN_END_HOUR = 23
_MIN_FOCUS_MINUTES = 60
_BREAK_EVERY_MINUTES = 120
_BREAK_DURATION_MINUTES = 15
_EXERCISE_DURATION_MINUTES = 45


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _hm(h: int, m: int) -> str:
    return f"{h:02d}:{m:02d}"


def _hm_to_min(hm: str) -> int:
    """Convert 'HH:MM' to total minutes since midnight."""
    parts = hm.split(":")
    return int(parts[0]) * 60 + int(parts[1])


def _min_to_hm(total: int) -> str:
    """Convert total minutes since midnight to 'HH:MM'."""
    return _hm(total // 60, total % 60)


# ------------------------------------------------------------------
# Service
# ------------------------------------------------------------------


class PlanningService:
    def __init__(
        self,
        store: Store,
        *,
        google_client: Any = None,
        task_service: Any = None,
        habit_service: Any = None,
        health_service: Any = None,
        goal_service: Any = None,
        mood_service: Any = None,
        llm: Any = None,
    ) -> None:
        self._store = store
        self._google = google_client
        self._tasks = task_service
        self._habits = habit_service
        self._health = health_service
        self._goals = goal_service
        self._mood = mood_service
        self._llm = llm

    # ------------------------------------------------------------------
    # Generate plan
    # ------------------------------------------------------------------

    async def generate_plan(self, target_date: date | None = None) -> DailyPlan:
        """Build a DailyPlan for *target_date* (defaults to today SP)."""
        d = target_date or _today_sp()
        d_iso = d.isoformat()

        # 1. Fetch calendar events (meetings) ─────────────────────────
        meetings: list[TimeBlock] = []
        if self._google is not None:
            try:
                day_start = datetime(d.year, d.month, d.day, 0, 0, tzinfo=_SP_TZ)
                day_end = day_start + timedelta(days=1)
                events = await self._google.list_events(
                    time_min=day_start,
                    time_max=day_end,
                    max_results=20,
                )
                for ev in events or []:
                    start_raw = (ev.get("start") or {}).get("dateTime")
                    end_raw = (ev.get("end") or {}).get("dateTime")
                    if not start_raw or not end_raw:
                        continue  # all-day events → skip
                    s_hm = start_raw.split("T")[1][:5]
                    e_hm = end_raw.split("T")[1][:5]
                    meetings.append(
                        TimeBlock(
                            id=ev.get("id") or str(uuid.uuid4()),
                            start=s_hm,
                            end=e_hm,
                            type="meeting",
                            title=ev.get("summary") or "Reuniao",
                            linked_id=ev.get("id"),
                        )
                    )
            except Exception as exc:
                logger.warning("planning: calendar fetch failed: %s", exc)

        # 2. Fetch pending tasks ──────────────────────────────────────
        priorities: list[dict[str, Any]] = []
        if self._tasks is not None:
            try:
                all_pending = await self._tasks.list_tasks(
                    status="pending", limit=200,
                )
                # Sort: due today → high priority → rest
                scored: list[tuple[int, Any]] = []
                for t in all_pending:
                    due = getattr(t, "due_date", None)
                    prio = getattr(t, "priority", None)
                    score = 0
                    if due is not None and str(due) <= d_iso:
                        score += 100
                    if prio == "high":
                        score += 50
                    elif prio == "medium":
                        score += 20
                    scored.append((score, t))
                scored.sort(key=lambda x: x[0], reverse=True)
                for _, t in scored[:3]:
                    priorities.append({
                        "id": getattr(t, "id", ""),
                        "title": getattr(t, "title", "?"),
                        "due_date": str(getattr(t, "due_date", "") or ""),
                        "priority": getattr(t, "priority", None),
                    })
            except Exception as exc:
                logger.warning("planning: task fetch failed: %s", exc)

        # 3. Fetch habits at risk ─────────────────────────────────────
        habits_at_risk: list[dict[str, Any]] = []
        exercise_streak_at_risk = False
        if self._habits is not None:
            try:
                items = await self._habits.list_with_today_status()
                for it in items:
                    streak = int(it.get("current_streak") or 0)
                    today_done = it.get("today_completed", False)
                    is_target = it.get("is_target_today", False)
                    if is_target and not today_done and streak >= 2:
                        habits_at_risk.append({
                            "id": it.get("id", ""),
                            "title": it.get("title", "?"),
                            "current_streak": streak,
                        })
                        title_lower = (it.get("title") or "").lower()
                        if any(
                            kw in title_lower
                            for kw in ("exercicio", "treino", "academia", "corrida", "workout")
                        ):
                            exercise_streak_at_risk = True
            except Exception as exc:
                logger.warning("planning: habits fetch failed: %s", exc)

        # 4. Fetch goals at risk ──────────────────────────────────────
        goals_at_risk: list[dict[str, Any]] = []
        if self._goals is not None:
            try:
                active_goals = await self._goals.list_goals(status="active")
                for g in active_goals or []:
                    end_date = getattr(g, "end_date", None)
                    progress = getattr(g, "progress", 0)
                    if end_date and str(end_date) <= d_iso and (progress or 0) < 80:
                        goals_at_risk.append({
                            "id": getattr(g, "id", ""),
                            "title": getattr(g, "title", "?"),
                            "progress": progress,
                        })
            except Exception:
                pass

        # 5. Fetch health context ─────────────────────────────────────
        sleep_hours: float | None = None
        energy = "medium"
        has_workout_today = False
        if self._health is not None:
            try:
                snap = await self._health.get_today()
                if snap is not None:
                    sleep_min = getattr(snap, "sleep_minutes", None)
                    if sleep_min is not None:
                        sleep_hours = round(float(sleep_min) / 60, 1)
                        if sleep_hours >= 7:
                            energy = "high"
                        elif sleep_hours >= 5:
                            energy = "medium"
                        else:
                            energy = "low"
                    workouts = getattr(snap, "workouts", None) or []
                    has_workout_today = len(workouts) > 0
            except Exception as exc:
                logger.warning("planning: health fetch failed: %s", exc)

        # 5b. Fetch mood context ──────────────────────────────────────
        mood_valence: float | None = None
        mood_reason: str | None = None
        if self._mood is not None:
            try:
                mood_data = await self._mood.get_today()
                if mood_data and mood_data.get("current") is not None:
                    mood_valence = mood_data.get("avg_valence")
                else:
                    # Fallback: get last mood from trend (yesterday or earlier)
                    trend = await self._mood.get_trend(days=7)
                    trend_days = trend.get("days") or []
                    if trend_days:
                        # trend is ordered ASC; take the most recent one
                        mood_valence = trend_days[-1].get("avg_valence")

                if mood_valence is not None:
                    if mood_valence < -0.3:
                        energy = "low"
                        mood_reason = (
                            "Humor mais baixo hoje"
                            " -- planejando blocos mais leves"
                        )
                    elif mood_valence > 0.7:
                        mood_reason = (
                            "Bom humor hoje -- aproveitando pra focar"
                        )
            except Exception as exc:
                logger.warning("planning: mood fetch failed: %s", exc)

        # 6. Build time blocks heuristically ──────────────────────────
        blocks: list[TimeBlock] = list(meetings)

        # Sort meetings by start to find gaps
        meetings_sorted = sorted(meetings, key=lambda b: b.start)
        meetings_count = len(meetings_sorted)

        # Build the gap list
        occupied = [(
            _hm_to_min(b.start),
            _hm_to_min(b.end),
        ) for b in meetings_sorted]

        plan_start = _PLAN_START_HOUR * 60
        plan_end = _PLAN_END_HOUR * 60

        gaps: list[tuple[int, int]] = []
        cursor = plan_start
        for occ_start, occ_end in sorted(occupied):
            if occ_start > cursor:
                gaps.append((cursor, occ_start))
            cursor = max(cursor, occ_end)
        if cursor < plan_end:
            gaps.append((cursor, plan_end))

        free_total = sum(e - s for s, e in gaps)

        # Adjust for low energy
        effective_break_every = _BREAK_EVERY_MINUTES
        effective_break_dur = _BREAK_DURATION_MINUTES
        if energy == "low":
            effective_break_every = 90  # breaks more often
            effective_break_dur = 20

        # Insert exercise block if streak at risk and no workout yet
        exercise_block: TimeBlock | None = None
        if exercise_streak_at_risk and not has_workout_today:
            # Try to place in afternoon gap (12-14h preferred)
            best_gap_idx = -1
            best_dist = 999999
            target_start = 12 * 60  # noon
            for i, (gs, ge) in enumerate(gaps):
                dur = ge - gs
                if dur >= _EXERCISE_DURATION_MINUTES:
                    dist = abs(gs - target_start)
                    if dist < best_dist:
                        best_dist = dist
                        best_gap_idx = i
            if best_gap_idx >= 0:
                gs, ge = gaps[best_gap_idx]
                ex_start = gs
                ex_end = gs + _EXERCISE_DURATION_MINUTES
                exercise_block = TimeBlock(
                    id=str(uuid.uuid4()),
                    start=_min_to_hm(ex_start),
                    end=_min_to_hm(ex_end),
                    type="exercise",
                    title="Exercicio",
                    reason="Streak em risco -- manter consistencia",
                )
                blocks.append(exercise_block)
                # Shrink the gap
                if ex_end < ge:
                    gaps[best_gap_idx] = (ex_end, ge)
                else:
                    gaps.pop(best_gap_idx)

        # Fill remaining gaps with focus + break
        for gs, ge in gaps:
            cursor = gs
            while cursor < ge:
                remaining = ge - cursor
                if remaining < _MIN_FOCUS_MINUTES:
                    # Too small for focus -- mark as free
                    if remaining >= 15:
                        blocks.append(
                            TimeBlock(
                                id=str(uuid.uuid4()),
                                start=_min_to_hm(cursor),
                                end=_min_to_hm(ge),
                                type="free",
                                title="Tempo livre",
                            )
                        )
                    break

                # Focus block
                focus_dur = min(effective_break_every, remaining)
                focus_end = cursor + focus_dur
                reason_parts: list[str] = []
                if priorities:
                    reason_parts.append(
                        f"{len(priorities)} tarefa(s) prioritaria(s)"
                    )
                blocks.append(
                    TimeBlock(
                        id=str(uuid.uuid4()),
                        start=_min_to_hm(cursor),
                        end=_min_to_hm(focus_end),
                        type="focus",
                        title="Focus",
                        reason="; ".join(reason_parts) if reason_parts else None,
                    )
                )
                cursor = focus_end

                # Break after focus
                if cursor < ge and (cursor + effective_break_dur) <= ge:
                    brk_end = cursor + effective_break_dur
                    blocks.append(
                        TimeBlock(
                            id=str(uuid.uuid4()),
                            start=_min_to_hm(cursor),
                            end=_min_to_hm(brk_end),
                            type="break",
                            title="Pausa",
                            reason=(
                                "Sono curto hoje -- pausas mais frequentes"
                                if energy == "low"
                                else None
                            ),
                        )
                    )
                    cursor = brk_end

        # Sort all blocks by start time
        blocks.sort(key=lambda b: b.start)

        plan = DailyPlan(
            time_blocks=blocks,
            priorities=priorities,
            at_risk={"habits": habits_at_risk, "goals": goals_at_risk},
            context=PlanContext(
                sleep_hours=sleep_hours,
                energy_estimate=energy,
                meetings_count=meetings_count,
                free_slots_min=free_total,
                mood_valence=mood_valence,
                mood_reason=mood_reason,
            ),
        )

        # 7. Persist plan ────────────────────────────────────────────
        plan_id = str(uuid.uuid4())
        plan_json = json.dumps(plan.to_dict(), ensure_ascii=False)
        ts = _now_iso()

        def _persist() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO daily_plans"
                    " (id, date, plan_json, accepted, feedback_json, created_at)"
                    " VALUES (?, ?, ?, 0, NULL, ?)"
                    " ON CONFLICT(date) DO UPDATE SET"
                    "   plan_json = excluded.plan_json,"
                    "   accepted = 0,"
                    "   created_at = excluded.created_at",
                    (plan_id, d_iso, plan_json, ts),
                )

        await asyncio.to_thread(_persist)
        return plan

    # ------------------------------------------------------------------
    # Accept plan
    # ------------------------------------------------------------------

    async def accept_plan(self, target_date: date | None = None) -> dict[str, Any]:
        """Mark plan as accepted. Create Google Calendar events for
        non-meeting blocks (focus, exercise)."""
        d = target_date or _today_sp()
        d_iso = d.isoformat()

        def _load() -> tuple[str | None, str | None]:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, plan_json FROM daily_plans WHERE date = ?",
                    (d_iso,),
                ).fetchone()
            return (row[0], row[1]) if row else (None, None)

        plan_id, plan_json = await asyncio.to_thread(_load)
        if plan_id is None or plan_json is None:
            return {"ok": False, "error": "Nenhum plano encontrado para hoje"}

        plan_data = json.loads(plan_json)
        created_events: list[str] = []

        if self._google is not None:
            for block in plan_data.get("time_blocks", []):
                btype = block.get("type")
                if btype in ("focus", "exercise", "admin"):
                    try:
                        start_dt = datetime.combine(
                            d,
                            datetime.strptime(block["start"], "%H:%M").time(),
                            tzinfo=_SP_TZ,
                        )
                        end_dt = datetime.combine(
                            d,
                            datetime.strptime(block["end"], "%H:%M").time(),
                            tzinfo=_SP_TZ,
                        )
                        desc = block.get("reason") or ""
                        ev = await self._google.create_event(
                            summary=f"[Seraphine] {block['title']}",
                            start=start_dt,
                            end=end_dt,
                            description=desc,
                        )
                        created_events.append(ev.get("id", ""))
                    except Exception as exc:
                        logger.warning(
                            "planning: failed to create event for block %s: %s",
                            block.get("id"),
                            exc,
                        )

        def _mark_accepted() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "UPDATE daily_plans SET accepted = 1 WHERE id = ?",
                    (plan_id,),
                )

        await asyncio.to_thread(_mark_accepted)

        return {
            "ok": True,
            "calendar_events_created": len(created_events),
            "event_ids": created_events,
        }

    # ------------------------------------------------------------------
    # Update a block
    # ------------------------------------------------------------------

    async def update_block(
        self,
        block_id: str,
        *,
        target_date: date | None = None,
        start: str | None = None,
        end: str | None = None,
        title: str | None = None,
        block_type: str | None = None,
    ) -> dict[str, Any]:
        """Patch a single block inside today's plan."""
        d = target_date or _today_sp()
        d_iso = d.isoformat()

        def _work() -> dict[str, Any]:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, plan_json FROM daily_plans WHERE date = ?",
                    (d_iso,),
                ).fetchone()
                if not row:
                    return {"ok": False, "error": "Plano nao encontrado"}
                plan_data = json.loads(row[1])
                blocks = plan_data.get("time_blocks", [])
                found = False
                for b in blocks:
                    if b.get("id") == block_id:
                        if start is not None:
                            b["start"] = start
                        if end is not None:
                            b["end"] = end
                        if title is not None:
                            b["title"] = title
                        if block_type is not None and block_type in _BLOCK_TYPES:
                            b["type"] = block_type
                        found = True
                        break
                if not found:
                    # Try removing
                    return {"ok": False, "error": "Bloco nao encontrado"}
                plan_data["time_blocks"] = sorted(
                    blocks, key=lambda x: x.get("start", "")
                )
                conn.execute(
                    "UPDATE daily_plans SET plan_json = ? WHERE id = ?",
                    (json.dumps(plan_data, ensure_ascii=False), row[0]),
                )
                return {"ok": True, "block": b}

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Feedback
    # ------------------------------------------------------------------

    async def record_feedback(
        self,
        target_date: date | None = None,
        *,
        blocks_executed: int = 0,
        tasks_done: int = 0,
    ) -> dict[str, Any]:
        d = target_date or _today_sp()
        d_iso = d.isoformat()

        def _work() -> dict[str, Any]:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, plan_json FROM daily_plans WHERE date = ?",
                    (d_iso,),
                ).fetchone()
                if not row:
                    return {"ok": False, "error": "Plano nao encontrado"}
                plan_data = json.loads(row[1])
                total_blocks = len(plan_data.get("time_blocks", []))
                total_tasks = len(plan_data.get("priorities", []))
                feedback = PlanFeedback(
                    date=d_iso,
                    blocks_planned=total_blocks,
                    blocks_executed=blocks_executed,
                    tasks_planned=total_tasks,
                    tasks_done=tasks_done,
                )
                conn.execute(
                    "UPDATE daily_plans SET feedback_json = ? WHERE id = ?",
                    (json.dumps(feedback.to_dict(), ensure_ascii=False), row[0]),
                )
                return {"ok": True, "feedback": feedback.to_dict()}

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    async def get_history(self, days: int = 7) -> list[dict[str, Any]]:
        n = max(1, min(days, 90))
        today = _today_sp()
        start = (today - timedelta(days=n)).isoformat()

        def _work() -> list[dict[str, Any]]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT date, plan_json, accepted, feedback_json, created_at"
                    " FROM daily_plans"
                    " WHERE date >= ?"
                    " ORDER BY date DESC",
                    (start,),
                ).fetchall()
            out: list[dict[str, Any]] = []
            for r in rows:
                entry: dict[str, Any] = {
                    "date": r[0],
                    "accepted": bool(r[2]),
                    "created_at": r[4],
                }
                try:
                    plan_data = json.loads(r[1])
                    entry["blocks_count"] = len(
                        plan_data.get("time_blocks", [])
                    )
                    entry["priorities_count"] = len(
                        plan_data.get("priorities", [])
                    )
                except (json.JSONDecodeError, TypeError):
                    entry["blocks_count"] = 0
                    entry["priorities_count"] = 0
                if r[3]:
                    try:
                        entry["feedback"] = json.loads(r[3])
                    except (json.JSONDecodeError, TypeError):
                        entry["feedback"] = None
                else:
                    entry["feedback"] = None
                out.append(entry)
            return out

        return await asyncio.to_thread(_work)
