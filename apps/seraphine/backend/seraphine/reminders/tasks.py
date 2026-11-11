"""Agendamento do lembrete de uma tarefa.

Mora aqui, e não em `tools/tasks.py`, porque tem dois donos: a tool
`add_task`/`update_task` e a materialização de regras recorrentes.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

SP_TZ = ZoneInfo("America/Sao_Paulo")


def compute_fire_time(
    due_date: str,
    due_time: str | None,
    remind: str,
) -> datetime | None:
    """Quando a notificação deve disparar. None se a data não parseia."""
    try:
        if due_time:
            dt = datetime.strptime(f"{due_date} {due_time}", "%Y-%m-%d %H:%M")
        else:
            # Sem hora — 09:00 é o default histórico.
            dt = datetime.strptime(due_date, "%Y-%m-%d").replace(hour=9, minute=0)
        dt = dt.replace(tzinfo=SP_TZ)
    except ValueError:
        return None

    if remind == "1h_before":
        dt -= timedelta(hours=1)
    elif remind == "1d_before":
        dt -= timedelta(days=1)
    # "at_time" — sem deslocamento

    return dt


def schedule_task_reminder(
    scheduler: Any,
    task_id: int,
    title: str,
    due_date: str,
    due_time: str | None,
    remind: str,
    *,
    now: datetime | None = None,
) -> str | None:
    """Agenda no ReminderScheduler. Devolve o job id, ou None.

    `now` existe para os testes serem determinísticos; em produção ninguém
    passa e vale o relógio de São Paulo.
    """
    fire_at = compute_fire_time(due_date, due_time, remind)
    if fire_at is None:
        return None

    # Hora que já passou não é lembrete: o APScheduler descarta o job pelo
    # misfire_grace_time sem uma linha de log, e o usuário fica esperando um
    # aviso que nunca vem. Melhor não agendar e dizer por quê.
    ref = now or datetime.now(SP_TZ)
    if ref.tzinfo is None:
        # Mesma convenção do resto do app: datetime ingênuo é hora local.
        ref = ref.replace(tzinfo=SP_TZ)
    if fire_at < ref:
        logger.info(
            "reminder for task %d skipped: %s already passed",
            task_id, fire_at.isoformat(),
        )
        return None

    job_id = f"task-remind-{task_id}"
    try:
        scheduler.add_reminder(
            fire_at=fire_at,
            message=f"Lembrete de tarefa: {title}",
            reminder_id=job_id,
        )
        return job_id
    except Exception:
        logger.exception("failed to schedule reminder for task %d", task_id)
        return None
