"""A projeção de evento e tarefa do agregado.

Existe porque o widget grande precisa do local do evento e da hora da
tarefa, e o agregado tinha os dois em mãos e descartava. Testar a rota
inteira exigiria Google, tarefas, hábitos, saúde e água de pé; a projeção
é pura e é onde o erro mora.
"""

from __future__ import annotations

from types import SimpleNamespace

from seraphine.calendar_agg.routes import _event_row, _task_row


def _ev(**over):
    base = {
        "id": "abc123",
        "summary": "Dentista",
        "start": {"dateTime": "2026-08-03T14:00:00-03:00"},
        "end": {"dateTime": "2026-08-03T15:00:00-03:00"},
        "location": "Av. Paulista, 1000",
    }
    base.update(over)
    return base


def test_event_carries_location() -> None:
    assert _event_row(_ev())["location"] == "Av. Paulista, 1000"


def test_event_without_location_gets_empty_string() -> None:
    ev = _ev()
    del ev["location"]
    # String vazia, não ausência: o consumidor não deveria ter que
    # distinguir "sem local" de "campo não veio" — mesma razão do `id`.
    assert _event_row(ev)["location"] == ""


def test_event_keeps_the_fields_the_app_already_reads() -> None:
    row = _event_row(_ev())
    assert row["id"] == "abc123"
    assert row["title"] == "Dentista"
    assert row["start"] == "2026-08-03T14:00:00-03:00"
    assert row["end"] == "2026-08-03T15:00:00-03:00"


def test_event_without_title_keeps_the_old_placeholder() -> None:
    ev = _ev()
    del ev["summary"]
    assert _event_row(ev)["title"] == "(sem titulo)"


def test_all_day_event_uses_date_when_there_is_no_datetime() -> None:
    row = _event_row(_ev(start={"date": "2026-08-03"}, end={"date": "2026-08-04"}))
    assert row["start"] == "2026-08-03"
    assert row["end"] == "2026-08-04"


def test_task_carries_due_time() -> None:
    task = SimpleNamespace(id=41, title="Pagar aluguel", status="pending", due_time="08:00")
    assert _task_row(task)["due_time"] == "08:00"


def test_task_without_due_time_gets_empty_string() -> None:
    task = SimpleNamespace(id=41, title="Pagar aluguel", status="pending", due_time=None)
    assert _task_row(task)["due_time"] == ""


def test_task_keeps_the_fields_the_app_already_reads() -> None:
    task = SimpleNamespace(id=41, title="Pagar aluguel", status="completed", due_time="08:00")
    row = _task_row(task)
    assert row["id"] == 41
    assert row["title"] == "Pagar aluguel"
    assert row["status"] == "completed"
