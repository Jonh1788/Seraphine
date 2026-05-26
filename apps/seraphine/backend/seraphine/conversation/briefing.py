"""Proactive daily briefing generator (011-D).

Builds a concise PT-BR summary from tasks, calendar events,
and finance data WITHOUT calling the LLM (fast boot path).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Request

logger = logging.getLogger("seraphine.briefing")

router = APIRouter(tags=["briefing"])


def _greeting(hour: int) -> str:
    if hour < 6:
        return "Boa madrugada"
    if hour < 12:
        return "Bom dia"
    if hour < 18:
        return "Boa tarde"
    return "Boa noite"


def _format_time(iso: str | None) -> str:
    """Extract HH:MM from an ISO datetime or time string.

    Returns empty string for all-day events (date-only strings like "2026-04-15").
    """
    if not iso:
        return ""
    # Google Calendar datetime: "2026-04-15T09:00:00-03:00"
    if "T" in iso:
        return iso.split("T")[1][:5]
    # All-day event: date-only string like "2026-04-15" — no time component
    if len(iso) == 10 and iso[4] == "-":
        return ""
    # Plain time: "09:00"
    return iso[:5]


async def generate_briefing(
    task_service: Any | None = None,
    finance_service: Any | None = None,
    google_client: Any | None = None,
    store: Any | None = None,
    goal_service: Any | None = None,
    mood_service: Any | None = None,
    focus_service: Any | None = None,
    reading_service: Any | None = None,
) -> str:
    """Generate a daily briefing markdown string.

    Combines:
    - Tasks due today (pending + overdue)
    - Google Calendar events (next 12h)
    - Finance: pending review entries
    - Recent emotional context (from memory facts)

    Returns a concise PT-BR summary string.
    """
    now = datetime.now(timezone.utc)
    # Use Brasilia time for greeting and date references
    from zoneinfo import ZoneInfo

    now_br = datetime.now(ZoneInfo("America/Sao_Paulo"))
    today_str = now_br.strftime("%Y-%m-%d")
    greeting = _greeting(now_br.hour)

    sections: list[str] = []
    sections.append(f"**{greeting}!** Aqui esta seu resumo de hoje:")
    sections.append("")

    # --- Tasks ---
    pending_tasks: list[Any] = []
    overdue_tasks: list[Any] = []
    today_tasks: list[Any] = []

    if task_service is not None:
        try:
            all_pending = await task_service.list_tasks(status="pending", limit=200)
            for t in all_pending:
                due = getattr(t, "due_date", None)
                if due is None:
                    pending_tasks.append(t)
                elif str(due) < today_str:
                    overdue_tasks.append(t)
                elif str(due) == today_str:
                    today_tasks.append(t)
                else:
                    pending_tasks.append(t)
        except Exception as e:
            logger.warning("briefing: list_tasks failed: %s", e)

    if overdue_tasks:
        sections.append(f"**Atrasadas ({len(overdue_tasks)}):**")
        for t in overdue_tasks[:5]:
            title = getattr(t, "title", "?")
            due = getattr(t, "due_date", "")
            sections.append(f"- {title} (era pra {due})")
        if len(overdue_tasks) > 5:
            sections.append(f"  ...e mais {len(overdue_tasks) - 5}")
        sections.append("")

    if today_tasks:
        sections.append(f"**Tarefas de hoje ({len(today_tasks)}):**")
        for t in today_tasks[:8]:
            title = getattr(t, "title", "?")
            time_str = getattr(t, "due_time", None)
            prefix = f"{time_str} - " if time_str else "- "
            sections.append(f"- {prefix}{title}")
        sections.append("")
    elif not overdue_tasks and not pending_tasks:
        sections.append("Nenhuma tarefa pendente. Dia livre!")
        sections.append("")

    # --- Google Calendar ---
    if google_client is not None:
        try:
            time_max = now + timedelta(hours=12)
            events = await google_client.list_events(
                time_min=now, time_max=time_max, max_results=10
            )
            if events:
                sections.append(f"**Agenda ({len(events)} eventos):**")
                for ev in events:
                    summary = ev.get("summary", "Sem titulo")
                    start = ev.get("start", {})
                    start_time = start.get("dateTime") or start.get("date", "")
                    time_display = _format_time(start_time)
                    if time_display:
                        sections.append(f"- {time_display} - {summary}")
                    else:
                        sections.append(f"- {summary} (dia inteiro)")
                sections.append("")
        except Exception as e:
            logger.warning("briefing: calendar failed: %s", e)

    # --- Finance ---
    if finance_service is not None:
        try:
            pending_entries = await finance_service.list_entries(
                status="pending_review", limit=100
            )
            if pending_entries:
                sections.append(
                    f"**Financas:** {len(pending_entries)} lancamento(s) pendente(s) de revisao."
                )
                sections.append("")
        except Exception as e:
            logger.warning("briefing: finance failed: %s", e)

    # --- Emotional context from memory ---
    if store is not None:
        try:
            facts = await store.list_facts(limit=5)
            # Look for any recent emotional notes
            emotional = [
                f for f in facts if any(
                    kw in (getattr(f, "text", "") or "").lower()
                    for kw in ("sente", "humor", "emocao", "ansios", "estress", "feliz", "triste")
                )
            ]
            if emotional:
                sections.append("**Contexto:** " + emotional[0].text)
                sections.append("")
        except Exception:
            pass

    # --- Goals at risk ---
    if goal_service is not None:
        try:
            summary = await goal_service.get_summary()
            total = summary.total_active
            at_risk = summary.goals_at_risk
            parts: list[str] = []
            if total > 0:
                parts.append(f"{total} objetivo(s) ativo(s)")
            if at_risk > 0:
                parts.append(f"**{at_risk} em risco**")
                # Find top at-risk goal for detail
                try:
                    from datetime import date as _date

                    active_goals = await goal_service.list_goals(status="active")
                    today_d = now_br.date()
                    for g in active_goals:
                        progress = getattr(g, "progress", 0.0)
                        end_date = getattr(g, "end_date", None)
                        if end_date and progress < 30.0:
                            try:
                                end_d = _date.fromisoformat(end_date)
                                if (end_d - today_d).days < 30:
                                    parts.append(
                                        f"'{g.title}' ({progress:.0f}%)"
                                    )
                                    break
                            except ValueError:
                                pass
                except Exception:
                    pass
            if parts:
                sections.append(f"**Objetivos:** {', '.join(parts)}.")
                sections.append("")
        except Exception as e:
            logger.warning("briefing: goals failed: %s", e)

    # --- Mood ---
    if mood_service is not None:
        try:
            mood_data = await mood_service.get_today()
            current = mood_data.get("current")
            if current:
                label = current.get("label", "")
                valence = current.get("valence", 0.0)
                sections.append(
                    f"**Humor:** {label} (valence: {valence:.1f})"
                )
                sections.append("")
        except Exception as e:
            logger.warning("briefing: mood failed: %s", e)

    # --- Focus today ---
    if focus_service is not None:
        try:
            from zoneinfo import ZoneInfo as _ZI

            _sp = _ZI("America/Sao_Paulo")
            _today_start = now_br.replace(hour=0, minute=0, second=0, microsecond=0)
            _today_end = now_br.replace(hour=23, minute=59, second=59, microsecond=0)
            start_utc = _today_start.astimezone(timezone.utc).isoformat()
            end_utc = _today_end.astimezone(timezone.utc).isoformat()
            sessions = await focus_service.get_sessions(start_utc, end_utc)
            work_sessions = [s for s in sessions if s.type == "work"]
            if work_sessions:
                total_min = sum(s.duration_sec for s in work_sessions) // 60
                hours = total_min / 60
                sections.append(
                    f"**Foco hoje:** {hours:.1f}h em {len(work_sessions)} sessao(oes)."
                )
                sections.append("")
        except Exception as e:
            logger.warning("briefing: focus failed: %s", e)

    # --- Reading backlog ---
    if reading_service is not None:
        try:
            unread = await reading_service.list_items(status="unread", limit=200)
            if unread:
                sections.append(
                    f"**Leitura:** {len(unread)} artigo(s) nao lido(s)."
                )
                sections.append("")
        except Exception as e:
            logger.warning("briefing: reading failed: %s", e)

    # Remove trailing empty lines
    while sections and sections[-1] == "":
        sections.pop()

    return "\n".join(sections)


@router.get("/briefing")
async def briefing_endpoint(request: Request) -> dict[str, str]:
    """Return a daily briefing summary."""
    task_service = getattr(request.app.state, "task_service", None)
    finance_service = getattr(request.app.state, "finance_service", None)
    google_client = getattr(request.app.state, "google_client", None)
    store = getattr(request.app.state, "store", None)
    goal_service = getattr(request.app.state, "goal_service", None)
    mood_service = getattr(request.app.state, "mood_service", None)
    focus_service = getattr(request.app.state, "focus_service", None)
    reading_service = getattr(request.app.state, "reading_service", None)

    text = await generate_briefing(
        task_service=task_service,
        finance_service=finance_service,
        google_client=google_client,
        store=store,
        goal_service=goal_service,
        mood_service=mood_service,
        focus_service=focus_service,
        reading_service=reading_service,
    )
    return {"briefing": text}


# ---------------------------------------------------------------------------
# PT-BR weekday / month names (avoids locale dependency)
# ---------------------------------------------------------------------------
_WEEKDAYS_PT = [
    "segunda-feira", "terca-feira", "quarta-feira",
    "quinta-feira", "sexta-feira", "sabado", "domingo",
]
_MONTHS_PT = [
    "", "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


async def generate_dashboard_summary(
    *,
    task_service: Any | None = None,
    finance_service: Any | None = None,
    google_client: Any | None = None,
    habit_service: Any | None = None,
    goal_service: Any | None = None,
    mood_service: Any | None = None,
    focus_service: Any | None = None,
    reading_service: Any | None = None,
) -> dict:
    """Build a structured dashboard summary dict.

    Every field degrades gracefully when its backing service is ``None``
    or raises an exception.
    """
    from zoneinfo import ZoneInfo

    now_br = datetime.now(ZoneInfo("America/Sao_Paulo"))
    now_utc = datetime.now(timezone.utc)
    today_str = now_br.strftime("%Y-%m-%d")

    greeting = f"{_greeting(now_br.hour)}, Jonathan!"
    date_label = (
        f"{_WEEKDAYS_PT[now_br.weekday()]}, "
        f"{now_br.day} de {_MONTHS_PT[now_br.month]}"
    )

    # --- Tasks --------------------------------------------------------
    tasks_total = 0
    tasks_completed = 0
    tasks_overdue = 0
    pending_titles: list[str] = []
    completed_titles: list[str] = []
    overdue_items: list[dict[str, str]] = []

    if task_service is not None:
        try:
            all_pending = await task_service.list_tasks(status="pending", limit=200)
            for t in all_pending:
                due = getattr(t, "due_date", None)
                due_time = getattr(t, "due_time", None)
                title = getattr(t, "title", "?")
                if due is not None and str(due) < today_str:
                    # Past calendar date = overdue.
                    tasks_overdue += 1
                    overdue_items.append({
                        "title": title,
                        "due_date": str(due),
                        "due_time": str(due_time)[:5] if due_time else None,
                    })
                elif due is not None and str(due) == today_str:
                    # Today's tasks stay "pending" all day even after the
                    # due_time passes — counting them as overdue made the
                    # dashboard double-count and hid them from the
                    # next_events list. Marking overdue strictly by date
                    # also keeps the count stable across test runs (no
                    # dependency on now_time_str).
                    tasks_total += 1
                    pending_titles.append(title)
            # Also count completed today
            all_completed = await task_service.list_tasks(status="completed", limit=200)
            for t in all_completed:
                due = getattr(t, "due_date", None)
                updated = getattr(t, "updated_at", None)
                title = getattr(t, "title", "?")
                if (due is not None and str(due) == today_str) or (
                    updated is not None and str(updated)[:10] == today_str
                ):
                    tasks_completed += 1
                    completed_titles.append(title)
        except Exception as exc:
            logger.warning("dashboard: task_service failed: %s", exc)

    tasks_total += tasks_completed + tasks_overdue

    # --- Calendar / next events --------------------------------------
    next_events: list[dict[str, str]] = []

    # Tasks with due_time today
    for title in pending_titles:
        # We need the actual task objects — rebuild a quick lookup
        pass

    # Collect tasks-with-time from the pending list (re-walk is cheaper
    # than a second service call — the data is already in memory above).
    timed_tasks: list[tuple[str, str]] = []
    if task_service is not None:
        try:
            all_pending = await task_service.list_tasks(status="pending", limit=200)
            for t in all_pending:
                due = getattr(t, "due_date", None)
                due_time = getattr(t, "due_time", None)
                if due is not None and str(due) == today_str and due_time:
                    timed_tasks.append((getattr(t, "title", "?"), str(due_time)[:5]))
        except Exception:
            pass

    for title, tm in timed_tasks:
        next_events.append({"title": title, "time": tm, "type": "task"})

    if google_client is not None:
        try:
            time_max = now_utc + timedelta(hours=12)
            events = await google_client.list_events(
                time_min=now_utc, time_max=time_max, max_results=10,
            )
            for ev in events or []:
                summary = ev.get("summary", "Sem titulo")
                start = ev.get("start", {})
                start_time = start.get("dateTime") or start.get("date", "")
                tm = _format_time(start_time)
                next_events.append({
                    "title": summary,
                    "time": tm,
                    "type": "agenda",
                })
        except Exception as exc:
            logger.warning("dashboard: google_client failed: %s", exc)

    # Sort by time (empty-time items go last)
    next_events.sort(key=lambda e: e.get("time") or "99:99")

    # --- Finance ------------------------------------------------------
    finance_income = 0.0
    finance_expenses = 0.0
    finance_balance = 0.0
    finance_pending_review = 0

    if finance_service is not None:
        try:
            summary = await finance_service.get_monthly_summary(
                month=now_br.month, year=now_br.year,
            )
            finance_income = summary.get("income", 0.0)
            finance_expenses = summary.get("expenses", 0.0)
            finance_balance = summary.get("balance", 0.0)
        except Exception as exc:
            logger.warning("dashboard: finance summary failed: %s", exc)

        try:
            pending_entries = await finance_service.list_entries(
                status="pending_review", limit=200,
            )
            finance_pending_review = len(pending_entries)
        except Exception as exc:
            logger.warning("dashboard: finance pending failed: %s", exc)

    # --- Habits -------------------------------------------------------
    habits_today: dict[str, Any] | None = None
    if habit_service is not None:
        try:
            habits_today = await habit_service.get_today_progress()
        except Exception as exc:
            logger.warning("dashboard: habit_service failed: %s", exc)
            habits_today = None

    result: dict[str, Any] = {
        "greeting": greeting,
        "date": date_label,
        "tasks_today": {
            "total": tasks_total,
            "completed": tasks_completed,
            "overdue": tasks_overdue,
            "pending_titles": pending_titles,
            "completed_titles": completed_titles,
            "overdue_items": overdue_items,
        },
        "next_events": next_events,
        "finance_month": {
            "income": finance_income,
            "expenses": finance_expenses,
            "balance": finance_balance,
            "pending_review": finance_pending_review,
        },
    }
    if habits_today is not None:
        result["habits_today"] = habits_today

    # --- Goals ---
    if goal_service is not None:
        try:
            goal_summary = await goal_service.get_summary()
            goals_data: dict[str, Any] = goal_summary.to_dict()
            # Find top at-risk goal for display
            try:
                active_goals = await goal_service.list_goals(status="active")
                today_d = now_br.date()
                for g in active_goals:
                    progress = getattr(g, "progress", 0.0)
                    end_date_str = getattr(g, "end_date", None)
                    if end_date_str and progress < 30.0:
                        from datetime import date as _date
                        try:
                            end_d = _date.fromisoformat(end_date_str)
                            if (end_d - today_d).days < 30:
                                goals_data["top_at_risk"] = {
                                    "title": g.title,
                                    "progress": round(progress, 1),
                                    "end_date": end_date_str,
                                }
                                break
                        except ValueError:
                            pass
            except Exception:
                pass
            result["goals"] = goals_data
        except Exception as exc:
            logger.warning("dashboard: goal_service failed: %s", exc)

    # --- Mood ---
    if mood_service is not None:
        try:
            mood_data = await mood_service.get_today()
            current = mood_data.get("current")
            if current:
                result["mood"] = {
                    "label": current.get("label", ""),
                    "valence": current.get("valence", 0.0),
                    "arousal": current.get("arousal", 0.0),
                    "avg_valence": mood_data.get("avg_valence", 0.0),
                }
        except Exception as exc:
            logger.warning("dashboard: mood_service failed: %s", exc)

    # --- Focus today ---
    if focus_service is not None:
        try:
            _today_start = now_br.replace(hour=0, minute=0, second=0, microsecond=0)
            _today_end = now_br.replace(hour=23, minute=59, second=59, microsecond=0)
            start_utc_iso = _today_start.astimezone(timezone.utc).isoformat()
            end_utc_iso = _today_end.astimezone(timezone.utc).isoformat()
            sessions = await focus_service.get_sessions(start_utc_iso, end_utc_iso)
            work_sessions = [s for s in sessions if s.type == "work"]
            total_min = sum(s.duration_sec for s in work_sessions) // 60
            result["focus_today"] = {
                "total_min": total_min,
                "sessions": len(work_sessions),
                "is_active": focus_service.is_active(),
            }
        except Exception as exc:
            logger.warning("dashboard: focus_service failed: %s", exc)

    # --- Reading backlog ---
    if reading_service is not None:
        try:
            unread = await reading_service.list_items(status="unread", limit=200)
            result["reading"] = {
                "unread_count": len(unread),
            }
        except Exception as exc:
            logger.warning("dashboard: reading_service failed: %s", exc)

    return result


@router.get("/dashboard/summary")
async def dashboard_summary(request: Request) -> dict:
    """Return a structured JSON dashboard summary."""
    return await generate_dashboard_summary(
        task_service=getattr(request.app.state, "task_service", None),
        finance_service=getattr(request.app.state, "finance_service", None),
        google_client=getattr(request.app.state, "google_client", None),
        habit_service=getattr(request.app.state, "habit_service", None),
        goal_service=getattr(request.app.state, "goal_service", None),
        mood_service=getattr(request.app.state, "mood_service", None),
        focus_service=getattr(request.app.state, "focus_service", None),
        reading_service=getattr(request.app.state, "reading_service", None),
    )
