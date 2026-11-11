"""O agendador de lembrete de tarefa, agora fora das tools."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from seraphine.reminders.tasks import compute_fire_time, schedule_task_reminder

SP_TZ = ZoneInfo("America/Sao_Paulo")


class _FakeScheduler:
    def __init__(self) -> None:
        self.added: list[dict[str, Any]] = []

    def add_reminder(self, **kwargs: Any) -> str:
        self.added.append(kwargs)
        return kwargs.get("reminder_id", "")


def test_at_time_fires_at_the_due_moment() -> None:
    assert compute_fire_time("2026-08-22", "10:00", "at_time") == datetime(
        2026, 8, 22, 10, 0, tzinfo=SP_TZ,
    )


def test_1h_before_subtracts_an_hour() -> None:
    assert compute_fire_time("2026-08-22", "10:00", "1h_before") == datetime(
        2026, 8, 22, 9, 0, tzinfo=SP_TZ,
    )


def test_missing_time_defaults_to_nine() -> None:
    assert compute_fire_time("2026-08-22", None, "at_time") == datetime(
        2026, 8, 22, 9, 0, tzinfo=SP_TZ,
    )


def test_malformed_date_returns_none() -> None:
    assert compute_fire_time("22/08/2026", "10:00", "at_time") is None


def test_schedule_returns_the_job_id_and_calls_the_scheduler() -> None:
    # `now` fixado: sem ele, este teste passaria a falhar em 22/08/2026,
    # quando a data de vencimento vira passado e o agendamento é recusado.
    sched = _FakeScheduler()
    job_id = schedule_task_reminder(
        sched, 7, "Apoiar Aline", "2026-08-22", "10:00", "at_time",
        now=datetime(2026, 8, 22, 6, 0, tzinfo=SP_TZ),
    )
    assert job_id == "task-remind-7"
    assert sched.added[0]["reminder_id"] == "task-remind-7"
    assert sched.added[0]["fire_at"] == datetime(2026, 8, 22, 10, 0, tzinfo=SP_TZ)


def test_schedule_returns_none_when_the_date_is_unparseable() -> None:
    sched = _FakeScheduler()
    assert schedule_task_reminder(
        sched, 7, "x", "amanhã", "10:00", "at_time",
    ) is None
    assert sched.added == []


# ----------------------------------------------------------------------
# Um lembrete no passado não é lembrete: o APScheduler o descarta calado
# ----------------------------------------------------------------------


def test_a_fire_time_already_past_is_not_scheduled() -> None:
    """Às 15h, o lembrete das 10h de hoje já nasceu morto — o jobstore o
    descarta pelo misfire_grace_time sem uma linha de log."""
    sched = _FakeScheduler()
    assert schedule_task_reminder(
        sched, 7, "Apoiar Aline", "2026-08-22", "10:00", "at_time",
        now=datetime(2026, 8, 22, 15, 0, tzinfo=SP_TZ),
    ) is None
    assert sched.added == []


def test_a_future_fire_time_is_still_scheduled() -> None:
    """Guarda contra uma comparação invertida, que mataria tudo.

    Dias de distância e com deslocamento: o recuo de `1h_before` acontece
    antes da checagem, e o que é comparado com `now` é a hora já recuada.
    """
    sched = _FakeScheduler()
    job_id = schedule_task_reminder(
        sched, 7, "Apoiar Aline", "2026-08-22", "10:00", "1h_before",
        now=datetime(2026, 8, 19, 23, 30, tzinfo=SP_TZ),
    )
    assert job_id == "task-remind-7"
    assert sched.added[0]["fire_at"] == datetime(
        2026, 8, 22, 9, 0, tzinfo=SP_TZ,
    )


def test_the_default_clock_still_schedules_a_future_reminder() -> None:
    """Sem `now`, vale `datetime.now(SP_TZ)`. Data derivada do relógio real
    para o teste não apodrecer numa data fixa."""
    sched = _FakeScheduler()
    tomorrow = (datetime.now(SP_TZ) + timedelta(days=1)).strftime("%Y-%m-%d")
    job_id = schedule_task_reminder(
        sched, 7, "Apoiar Aline", tomorrow, "10:00", "at_time",
    )
    assert job_id == "task-remind-7"
    assert len(sched.added) == 1


def test_a_fire_time_seconds_away_is_still_scheduled() -> None:
    """A fronteira é "já passou", não "está perto demais"."""
    sched = _FakeScheduler()
    job_id = schedule_task_reminder(
        sched, 7, "Apoiar Aline", "2026-08-22", "10:00", "at_time",
        now=datetime(2026, 8, 22, 9, 59, 55, tzinfo=SP_TZ),
    )
    assert job_id == "task-remind-7"
    assert len(sched.added) == 1
