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

    text = await generate_briefing(
        task_service=task_service,
        finance_service=finance_service,
        google_client=google_client,
        store=store,
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

    if task_service is not None:
        try:
            all_pending = await task_service.list_tasks(status="pending", limit=200)
            for t in all_pending:
                due = getattr(t, "due_date", None)
                if due is not None and str(due) < today_str:
                    tasks_overdue += 1
                elif due is not None and str(due) == today_str:
                    tasks_total += 1
                    pending_titles.append(getattr(t, "title", "?"))
            # Also count completed today
            all_completed = await task_service.list_tasks(status="completed", limit=200)
            for t in all_completed:
                due = getattr(t, "due_date", None)
                updated = getattr(t, "updated_at", None)
                # Count as completed today if due_date is today
                # or updated_at starts with today's date.
                if (due is not None and str(due) == today_str) or (
                    updated is not None and str(updated)[:10] == today_str
                ):
                    tasks_completed += 1
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

    return {
        "greeting": greeting,
        "date": date_label,
        "tasks_today": {
            "total": tasks_total,
            "completed": tasks_completed,
            "overdue": tasks_overdue,
            "pending_titles": pending_titles,
        },
        "next_events": next_events,
        "finance_month": {
            "income": finance_income,
            "expenses": finance_expenses,
            "balance": finance_balance,
            "pending_review": finance_pending_review,
        },
    }


@router.get("/dashboard/summary")
async def dashboard_summary(request: Request) -> dict:
    """Return a structured JSON dashboard summary."""
    return await generate_dashboard_summary(
        task_service=getattr(request.app.state, "task_service", None),
        finance_service=getattr(request.app.state, "finance_service", None),
        google_client=getattr(request.app.state, "google_client", None),
    )
