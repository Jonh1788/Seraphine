"""Tests for recurring task rules.

Regression coverage for the 2026-08-03 chat session where Seraphine could
create rules but never amend them, and where the model's ``-1`` "not
applicable" sentinels were rejected outright.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.recurring import schema as recurring_schema
from seraphine.recurring.service import RecurringService, _is_due_today
from seraphine.tools.recurring import (
    CreateRecurringTaskTool,
    DeleteRecurringTaskTool,
    ListRecurringTasksTool,
    UpdateRecurringTaskTool,
)


class _FakeTaskService:
    """Minimal TaskService stand-in: records created tasks, hands back ids."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.updated: list[tuple[int, dict[str, Any]]] = []

    async def create_task(self, **kwargs: Any) -> int:
        self.created.append(kwargs)
        return len(self.created)

    async def list_tasks(self, **kwargs: Any) -> list[Any]:
        out = []
        for i, t in enumerate(self.created, start=1):
            if kwargs.get("due_from") and t.get("due_date") != kwargs["due_from"]:
                continue
            out.append(SimpleNamespace(
                id=i,
                source=t.get("source"),
                payload=t.get("payload") or {},
                status="pending",
                due_date=t.get("due_date"),
            ))
        return out

    async def update_task(self, task_id: int, **kwargs: Any) -> int:
        self.updated.append((task_id, kwargs))
        return 1


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "recurring.sqlite")
    s.register_migrator("seraphine_recurring", recurring_schema.migrate)
    await s.ensure_schema()
    await s.ensure_schema()  # idempotent re-run must not raise
    return s


@pytest.fixture
async def tasks() -> _FakeTaskService:
    return _FakeTaskService()


@pytest.fixture
async def service(store: MemoryStore, tasks: _FakeTaskService) -> RecurringService:
    return RecurringService(store, tasks)


# ----------------------------------------------------------------------
# Irrelevant-field sentinels (the "weekday must be 0..6" bug)
# ----------------------------------------------------------------------


async def test_daily_ignores_weekday_and_day_of_month_sentinels(
    service: RecurringService,
) -> None:
    """A daily rule uses neither field, so -1 sentinels must be dropped.

    Verbatim args from the failing production call on 2026-08-03.
    """
    rule = await service.create(
        title="Apoiar Aline no desafio sem açúcar",
        frequency="daily",
        weekday=-1,
        day_of_month=-1,
        time="10:00",
    )
    assert rule.weekday is None
    assert rule.day_of_month is None


async def test_weekly_drops_day_of_month_but_keeps_weekday(
    service: RecurringService,
) -> None:
    rule = await service.create(
        title="Lixo", frequency="weekly", weekday=2, day_of_month=-1,
    )
    assert rule.weekday == 2
    assert rule.day_of_month is None


async def test_monthly_drops_weekday_but_keeps_day_of_month(
    service: RecurringService,
) -> None:
    rule = await service.create(
        title="Aluguel", frequency="monthly", weekday=-1, day_of_month=5,
    )
    assert rule.weekday is None
    assert rule.day_of_month == 5


async def test_weekly_still_rejects_out_of_range_weekday(
    service: RecurringService,
) -> None:
    """Dropping irrelevant fields must not weaken the relevant one."""
    with pytest.raises(ValueError, match="weekday must be 0..6"):
        await service.create(title="x", frequency="weekly", weekday=9)


async def test_monthly_still_rejects_out_of_range_day_of_month(
    service: RecurringService,
) -> None:
    with pytest.raises(ValueError, match="day_of_month must be 1..31"):
        await service.create(title="x", frequency="monthly", day_of_month=40)


async def test_weekly_sentinel_weekday_is_still_an_error(
    service: RecurringService,
) -> None:
    """-1 is only "not applicable" when the frequency doesn't use the field."""
    with pytest.raises(ValueError, match="weekday must be 0..6"):
        await service.create(title="x", frequency="weekly", weekday=-1)


async def test_update_drops_irrelevant_sentinel_for_daily_rule(
    service: RecurringService,
) -> None:
    rule = await service.create(title="x", frequency="daily", time="10:00")
    updated = await service.update(
        rule.id, weekday=-1, _weekday_provided=True,
    )
    assert updated is not None
    assert updated.weekday is None


# ----------------------------------------------------------------------
# end_date: honouring "durante 20 dias"
# ----------------------------------------------------------------------


async def test_create_persists_end_date(service: RecurringService) -> None:
    rule = await service.create(
        title="Desafio", frequency="daily", time="10:00", end_date="2026-08-22",
    )
    assert rule.end_date == "2026-08-22"


async def test_rule_is_due_on_its_end_date(service: RecurringService) -> None:
    rule = await service.create(
        title="Desafio", frequency="daily", end_date="2026-08-22",
    )
    assert _is_due_today(rule, date(2026, 8, 22)) is True


async def test_rule_is_not_due_after_end_date(service: RecurringService) -> None:
    rule = await service.create(
        title="Desafio", frequency="daily", end_date="2026-08-22",
    )
    assert _is_due_today(rule, date(2026, 8, 23)) is False


async def test_no_end_date_runs_forever(service: RecurringService) -> None:
    rule = await service.create(title="Vitamina", frequency="daily")
    assert _is_due_today(rule, date(2030, 1, 1)) is True


async def test_expired_rule_is_not_materialized(
    service: RecurringService, tasks: _FakeTaskService,
) -> None:
    await service.create(title="Desafio", frequency="daily", end_date="2026-08-01")
    created = await service.materialize_due(
        datetime(2026, 8, 5, 9, 0, tzinfo=timezone.utc),
    )
    assert created == []
    assert tasks.created == []


async def test_create_rejects_malformed_end_date(service: RecurringService) -> None:
    with pytest.raises(ValueError, match="end_date"):
        await service.create(title="x", frequency="daily", end_date="22/08/2026")


async def test_update_can_clear_end_date(service: RecurringService) -> None:
    rule = await service.create(
        title="x", frequency="daily", end_date="2026-08-22",
    )
    updated = await service.update(rule.id, end_date=None, _end_date_provided=True)
    assert updated is not None
    assert updated.end_date is None


# ----------------------------------------------------------------------
# Tool layer: the model must be able to see and amend what it created
# ----------------------------------------------------------------------


async def test_create_tool_accepts_sentinels(service: RecurringService) -> None:
    tool = CreateRecurringTaskTool(service)
    result = await tool.execute({
        "title": "Apoiar Aline no desafio sem doces — manhã",
        "frequency": "daily",
        "weekday": -1,
        "day_of_month": -1,
        "time": "10:00",
    })
    assert result.ok, result.error


async def test_create_tool_output_exposes_rule_id(
    service: RecurringService,
) -> None:
    """metadata never reaches the LLM — only `output`. The id must be there
    or the model cannot target the rule on a follow-up edit."""
    tool = CreateRecurringTaskTool(service)
    result = await tool.execute(
        {"title": "Desafio", "frequency": "daily", "time": "21:00"},
    )
    assert result.ok, result.error
    rule_id = result.metadata["recurring"]["id"]
    assert rule_id in (result.output or "")


async def test_list_tool_returns_created_rules(service: RecurringService) -> None:
    await service.create(title="Manhã", frequency="daily", time="10:00")
    await service.create(title="Noite", frequency="daily", time="21:00")

    result = await ListRecurringTasksTool(service).execute({})
    assert result.ok, result.error
    assert "Manhã" in (result.output or "")
    assert "21:00" in (result.output or "")


async def test_list_tool_output_exposes_ids(service: RecurringService) -> None:
    rule = await service.create(title="Noite", frequency="daily", time="21:00")
    result = await ListRecurringTasksTool(service).execute({})
    assert rule.id in (result.output or "")


async def test_update_tool_changes_the_time(service: RecurringService) -> None:
    """The exact failure from the session: 21:00 -> 19:00."""
    rule = await service.create(title="Noite", frequency="daily", time="21:00")

    result = await UpdateRecurringTaskTool(service).execute(
        {"rule_id": rule.id, "time": "19:00"},
    )
    assert result.ok, result.error

    after = await service.get(rule.id)
    assert after is not None
    assert after.time == "19:00"


async def test_update_tool_reports_unknown_rule(service: RecurringService) -> None:
    result = await UpdateRecurringTaskTool(service).execute(
        {"rule_id": "does-not-exist", "time": "19:00"},
    )
    assert not result.ok
    assert "not found" in (result.error or "").lower()


async def test_update_tool_requires_a_field(service: RecurringService) -> None:
    rule = await service.create(title="Noite", frequency="daily", time="21:00")
    result = await UpdateRecurringTaskTool(service).execute({"rule_id": rule.id})
    assert not result.ok


async def test_delete_tool_removes_the_rule(service: RecurringService) -> None:
    rule = await service.create(title="Duplicada", frequency="daily", time="10:00")

    result = await DeleteRecurringTaskTool(service).execute({"rule_id": rule.id})
    assert result.ok, result.error
    assert await service.get(rule.id) is None


async def test_delete_tool_reports_unknown_rule(service: RecurringService) -> None:
    result = await DeleteRecurringTaskTool(service).execute({"rule_id": "nope"})
    assert not result.ok


async def test_create_tool_passes_end_date_through(
    service: RecurringService,
) -> None:
    tool = CreateRecurringTaskTool(service)
    result = await tool.execute({
        "title": "Desafio 20 dias",
        "frequency": "daily",
        "time": "10:00",
        "end_date": "2026-08-22",
    })
    assert result.ok, result.error
    assert result.metadata["recurring"]["end_date"] == "2026-08-22"


async def test_materialize_uses_sao_paulo_day_not_utc_day(
    service: RecurringService, tasks: _FakeTaskService,
) -> None:
    """22:28 BRT on 02/08 is already 03/08 in UTC.

    The background loop passes a UTC `now`; the create tool passes a SP one.
    If the service trusts the caller's date, a late-evening rule is stamped
    with tomorrow's date, and the real tomorrow is then skipped because the
    day was already claimed. Anchor the decision to the user's timezone.
    """
    await service.create(title="Apoiar Aline", frequency="daily", time="10:00")

    created = await service.materialize_due(
        datetime(2026, 8, 3, 1, 28, tzinfo=timezone.utc),  # 22:28 BRT on 08-02
    )
    assert len(created) == 1
    assert tasks.created[0]["due_date"] == "2026-08-02"

    # And the next real BRT day must still be free to fire.
    created_next = await service.materialize_due(
        datetime(2026, 8, 4, 1, 28, tzinfo=timezone.utc),  # 22:28 BRT on 08-03
    )
    assert len(created_next) == 1
    assert tasks.created[1]["due_date"] == "2026-08-03"


async def test_weekly_rule_does_not_fire_a_day_early_in_utc(
    service: RecurringService, tasks: _FakeTaskService,
) -> None:
    """2026-08-03 is a Monday. At 22:00 BRT on Sunday 08-02 the UTC clock
    already reads Monday — a 'toda segunda' rule must not fire yet."""
    await service.create(title="Lixo", frequency="weekly", weekday=0)

    created = await service.materialize_due(
        datetime(2026, 8, 3, 1, 0, tzinfo=timezone.utc),  # 22:00 BRT, Sunday
    )
    assert created == []


async def test_migrate_adds_end_date_to_a_pre_existing_table(
    tmp_path: Path,
) -> None:
    """Production DBs already hold rules created before end_date existed.
    The migrator must ALTER them in place, not skip them because
    CREATE TABLE IF NOT EXISTS found the table already there.
    """
    import sqlite3

    db = tmp_path / "legacy.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE recurring_tasks (
          id                     TEXT PRIMARY KEY,
          title                  TEXT NOT NULL,
          description            TEXT,
          frequency              TEXT NOT NULL,
          weekday                INTEGER,
          day_of_month           INTEGER,
          time                   TEXT,
          active                 INTEGER NOT NULL DEFAULT 1,
          last_materialized_date TEXT,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL
        );
        INSERT INTO recurring_tasks VALUES
          ('legacy-1', 'Apoiar Aline', NULL, 'daily', NULL, NULL,
           '10:00', 1, '2026-08-03', '2026-08-03', '2026-08-03');
        """
    )
    conn.commit()

    recurring_schema.migrate(conn)
    recurring_schema.migrate(conn)  # idempotent
    conn.commit()

    cols = {row[1] for row in conn.execute("PRAGMA table_info(recurring_tasks)")}
    assert "end_date" in cols
    row = conn.execute(
        "SELECT title, end_date FROM recurring_tasks WHERE id = 'legacy-1'",
    ).fetchone()
    assert row == ("Apoiar Aline", None)
    conn.close()

    # And the service must read that migrated row back without an index error.
    store = MemoryStore(db)
    store.register_migrator("seraphine_recurring", recurring_schema.migrate)
    await store.ensure_schema()
    svc = RecurringService(store, _FakeTaskService())
    rules = await svc.list_all()
    assert [r.title for r in rules] == ["Apoiar Aline"]
    assert rules[0].end_date is None


async def test_create_tool_surfaces_end_date_in_output(
    service: RecurringService,
) -> None:
    tool = CreateRecurringTaskTool(service)
    result = await tool.execute({
        "title": "Desafio 20 dias",
        "frequency": "daily",
        "time": "10:00",
        "end_date": "2026-08-22",
    })
    assert "2026-08-22" in (result.output or "")


# ----------------------------------------------------------------------
# remind: a regra vira lembrete de verdade
# ----------------------------------------------------------------------


class _FakeScheduler:
    def __init__(self) -> None:
        self.added: list[dict[str, Any]] = []
        self.cancelled: list[str] = []

    def add_reminder(self, **kwargs: Any) -> str:
        self.added.append(kwargs)
        return kwargs.get("reminder_id", "")

    def cancel_reminder(self, reminder_id: str) -> bool:
        self.cancelled.append(reminder_id)
        return True


class _FakeRequest:
    """As rotas só leem `request.app.state.recurring_service`; chamá-las
    direto evita subir o app inteiro (e o boot de rede que vem junto)."""

    def __init__(self, svc: RecurringService) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(recurring_service=svc))


async def test_rule_with_a_time_defaults_to_at_time(
    service: RecurringService,
) -> None:
    rule = await service.create(title="Aline", frequency="daily", time="10:00")
    assert rule.remind == "at_time"


async def test_rule_without_a_time_gets_no_reminder(
    service: RecurringService,
) -> None:
    rule = await service.create(title="Lixo", frequency="weekly", weekday=0)
    assert rule.remind is None


async def test_explicit_remind_wins_over_the_default(
    service: RecurringService,
) -> None:
    rule = await service.create(
        title="Aline", frequency="daily", time="10:00", remind="1h_before",
    )
    assert rule.remind == "1h_before"


async def test_create_rejects_an_unknown_remind(
    service: RecurringService,
) -> None:
    with pytest.raises(ValueError, match="remind"):
        await service.create(
            title="x", frequency="daily", time="10:00", remind="amanhã",
        )


async def test_create_rejects_1d_before_for_a_recurring_rule(
    service: RecurringService,
) -> None:
    """A ocorrência é criada no próprio dia em que vence, então um lembrete
    de véspera já nasceria no passado. `add_task` mantém os três."""
    with pytest.raises(ValueError, match="remind"):
        await service.create(
            title="x", frequency="daily", time="10:00", remind="1d_before",
        )


async def test_update_does_not_turn_the_reminder_on_by_itself(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Adicionar hora depois não religa um lembrete desligado de propósito."""
    svc = RecurringService(store, tasks)
    rule = await svc.create(title="Lixo", frequency="daily")
    assert rule.remind is None

    updated = await svc.update(rule.id, time="10:00", _time_provided=True)
    assert updated is not None
    assert updated.remind is None


async def test_update_can_set_and_clear_remind(
    service: RecurringService,
) -> None:
    rule = await service.create(title="Aline", frequency="daily", time="10:00")

    off = await service.update(rule.id, remind=None, _remind_provided=True)
    assert off is not None and off.remind is None

    on = await service.update(rule.id, remind="at_time", _remind_provided=True)
    assert on is not None and on.remind == "at_time"


async def test_materialization_schedules_the_reminder(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    sched = _FakeScheduler()
    svc = RecurringService(store, tasks, scheduler=sched)
    await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")

    created = await svc.materialize_due(
        datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc),
    )
    assert len(created) == 1
    task_id = created[0][1]
    assert sched.added[0]["reminder_id"] == f"task-remind-{task_id}"
    # A DATA inteira, não só a hora: com `.hour == 10` sozinho, trocar
    # `today_iso` por "2030-01-01" na chamada do agendamento passava verde.
    fire_at = sched.added[0]["fire_at"]
    assert fire_at.date() == date(2026, 8, 5)
    assert (fire_at.hour, fire_at.minute) == (10, 0)


async def test_materialization_without_remind_schedules_nothing(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    sched = _FakeScheduler()
    svc = RecurringService(store, tasks, scheduler=sched)
    await svc.create(title="Lixo", frequency="daily")

    await svc.materialize_due(datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc))
    assert sched.added == []


async def test_materialization_does_not_schedule_a_reminder_already_past(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Criar "todo dia às 10h" às 15h materializa o card de hoje, mas as 10h
    já passaram: agendar seria entregar o job ao descarte silencioso. A
    tarefa do dia continua nascendo — só o lembrete de hoje não existe."""
    sched = _FakeScheduler()
    svc = RecurringService(store, tasks, scheduler=sched)
    await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")

    created = await svc.materialize_due(
        datetime(2026, 8, 5, 18, 0, tzinfo=timezone.utc),  # 15:00 BRT
    )
    assert len(created) == 1
    assert sched.added == []


async def test_materialization_survives_a_scheduler_that_raises(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """A tarefa é o produto; o lembrete é o acessório. Um scheduler
    quebrado não pode custar a tarefa do dia."""

    class _Broken:
        def add_reminder(self, **kwargs: Any) -> str:
            raise RuntimeError("jobstore offline")

    svc = RecurringService(store, tasks, scheduler=_Broken())
    await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")

    created = await svc.materialize_due(
        datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc),
    )
    assert len(created) == 1


# ----------------------------------------------------------------------
# remind na camada de tools e na API HTTP (Task 3)
# ----------------------------------------------------------------------


async def test_create_tool_accepts_remind(service: RecurringService) -> None:
    result = await CreateRecurringTaskTool(service).execute({
        "title": "Apoiar Aline",
        "frequency": "daily",
        "time": "10:00",
        "remind": "1h_before",
    })
    assert result.ok, result.error
    assert result.metadata["recurring"]["remind"] == "1h_before"


async def test_create_tool_output_says_the_reminder_is_on(
    service: RecurringService,
) -> None:
    """O modelo só vê `output`; se o lembrete não aparecer lá, ela não tem
    como contar ao usuário que vai avisar."""
    result = await CreateRecurringTaskTool(service).execute(
        {"title": "Apoiar Aline", "frequency": "daily", "time": "10:00"},
    )
    assert "lembrete" in (result.output or "").lower()


async def test_update_tool_can_turn_the_reminder_off(
    service: RecurringService,
) -> None:
    rule = await service.create(title="Aline", frequency="daily", time="10:00")
    result = await UpdateRecurringTaskTool(service).execute(
        {"rule_id": rule.id, "remind": ""},
    )
    assert result.ok, result.error
    after = await service.get(rule.id)
    assert after is not None and after.remind is None


async def test_update_tool_can_turn_the_reminder_on(
    service: RecurringService,
) -> None:
    """A regra sem hora nasce sem lembrete; ligar depois é um pedido
    explícito do usuário, e a tool tem que saber atendê-lo."""
    rule = await service.create(title="Lixo", frequency="daily")
    assert rule.remind is None

    result = await UpdateRecurringTaskTool(service).execute(
        {"rule_id": rule.id, "time": "10:00", "remind": "at_time"},
    )
    assert result.ok, result.error
    after = await service.get(rule.id)
    assert after is not None and after.remind == "at_time"


async def test_update_tool_leaves_remind_alone_when_not_sent(
    service: RecurringService,
) -> None:
    """Trocar só o horário não pode desligar o lembrete de tabela."""
    rule = await service.create(title="Aline", frequency="daily", time="10:00")
    result = await UpdateRecurringTaskTool(service).execute(
        {"rule_id": rule.id, "time": "19:00"},
    )
    assert result.ok, result.error
    after = await service.get(rule.id)
    assert after is not None and after.remind == "at_time"


def test_recurring_tools_do_not_offer_a_reminder_a_day_early() -> None:
    """Ruling humano da Task 2: a ocorrência é materializada NO dia em que
    vence, então `1d_before` já nasceria no passado e seria descartado. As
    tools de tarefa avulsa (`add_task`/`update_task`) mantêm os três."""
    for tool_cls in (CreateRecurringTaskTool, UpdateRecurringTaskTool):
        enum = tool_cls.json_schema["properties"]["remind"]["enum"]
        assert "1d_before" not in enum, tool_cls.name
        assert {"at_time", "1h_before"} <= set(enum), tool_cls.name


def test_plain_task_tools_still_offer_a_day_early_reminder() -> None:
    """O contraponto do teste acima: o recorte é da regra recorrente, não do
    app. Se alguém 'consertar' o enum das tools de tarefa por simetria, aqui
    quebra."""
    from seraphine.tools.tasks import CreateTaskTool

    enum = CreateTaskTool.json_schema["properties"]["remind"]["enum"]
    assert "1d_before" in enum


async def test_list_tool_line_flags_the_reminder(
    service: RecurringService,
) -> None:
    """`output` é tudo que o modelo lê: sem essa marca ele não consegue
    responder "esse aqui te avisa?" sem inventar."""
    await service.create(title="Com hora", frequency="daily", time="10:00")
    await service.create(title="Sem hora", frequency="weekly", weekday=0)

    result = await ListRecurringTasksTool(service).execute({})
    lines = {
        line.split("—")[0].strip(" -"): line
        for line in (result.output or "").splitlines()
        if line.startswith("- ")
    }
    assert "lembrete" in lines["Com hora"].lower()
    assert "lembrete" not in lines["Sem hora"].lower()


async def test_create_route_accepts_remind(service: RecurringService) -> None:
    from seraphine.recurring.routes import CreateRecurringBody, create_rule

    payload = await create_rule(
        _FakeRequest(service),
        CreateRecurringBody(
            title="Apoiar Aline",
            frequency="daily",
            time="10:00",
            remind="1h_before",
        ),
    )
    assert payload["recurring"]["remind"] == "1h_before"


async def test_create_route_defaults_remind_when_there_is_a_time(
    service: RecurringService,
) -> None:
    from seraphine.recurring.routes import CreateRecurringBody, create_rule

    payload = await create_rule(
        _FakeRequest(service),
        CreateRecurringBody(title="Apoiar Aline", frequency="daily", time="10:00"),
    )
    assert payload["recurring"]["remind"] == "at_time"


async def test_patch_route_can_clear_remind(service: RecurringService) -> None:
    from seraphine.recurring.routes import PatchRecurringBody, patch_rule

    rule = await service.create(title="Aline", frequency="daily", time="10:00")
    payload = await patch_rule(
        _FakeRequest(service), rule.id, PatchRecurringBody(remind=""),
    )
    assert payload["recurring"]["remind"] is None


async def test_patch_route_leaves_remind_alone_when_absent(
    service: RecurringService,
) -> None:
    """`exclude_unset` é o que separa "não mexi" de "desliga"; sem isso um
    PATCH de horário apaga o lembrete."""
    from seraphine.recurring.routes import PatchRecurringBody, patch_rule

    rule = await service.create(title="Aline", frequency="daily", time="10:00")
    payload = await patch_rule(
        _FakeRequest(service), rule.id, PatchRecurringBody(time="19:00"),
    )
    assert payload["recurring"]["remind"] == "at_time"


async def test_patch_route_rejects_an_unknown_remind(
    service: RecurringService,
) -> None:
    from fastapi import HTTPException

    from seraphine.recurring.routes import PatchRecurringBody, patch_rule

    rule = await service.create(title="Aline", frequency="daily", time="10:00")
    with pytest.raises(HTTPException) as exc:
        await patch_rule(
            _FakeRequest(service), rule.id, PatchRecurringBody(remind="1d_before"),
        )
    assert exc.value.status_code == 422


async def test_migrate_adds_remind_to_a_pre_existing_table(
    tmp_path: Path,
) -> None:
    import sqlite3

    db = tmp_path / "legacy_remind.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE recurring_tasks (
          id                     TEXT PRIMARY KEY,
          title                  TEXT NOT NULL,
          description            TEXT,
          frequency              TEXT NOT NULL,
          weekday                INTEGER,
          day_of_month           INTEGER,
          time                   TEXT,
          active                 INTEGER NOT NULL DEFAULT 1,
          last_materialized_date TEXT,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL
        );
        INSERT INTO recurring_tasks VALUES
          ('legacy-2', 'Apoiar Aline', NULL, 'daily', NULL, NULL,
           '10:00', 1, NULL, '2026-08-02', '2026-08-02');
        """
    )
    conn.commit()
    recurring_schema.migrate(conn)
    recurring_schema.migrate(conn)  # idempotente
    conn.commit()

    cols = {row[1] for row in conn.execute("PRAGMA table_info(recurring_tasks)")}
    assert {"end_date", "remind"} <= cols
    assert conn.execute(
        "SELECT remind FROM recurring_tasks WHERE id = 'legacy-2'",
    ).fetchone() == (None,)
    conn.close()


# ----------------------------------------------------------------------
# complete_today: o botão da notificação nativa carrega o rule_id
# ----------------------------------------------------------------------


async def test_complete_today_completes_the_occurrence_of_the_day(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    svc = RecurringService(store, tasks)
    rule = await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")
    await svc.materialize_due(datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc))

    task_id = await svc.complete_today(
        rule.id, datetime(2026, 8, 5, 13, 0, tzinfo=timezone.utc),
    )
    assert task_id == 1
    assert tasks.updated == [(1, {"status": "completed"})]


async def test_complete_today_uses_the_sao_paulo_day(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """22:30 BRT do dia 5 ainda é dia 5, mesmo com o UTC já no dia 6."""
    svc = RecurringService(store, tasks)
    rule = await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")
    await svc.materialize_due(datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc))

    task_id = await svc.complete_today(
        rule.id, datetime(2026, 8, 6, 1, 30, tzinfo=timezone.utc),
    )
    assert task_id == 1


async def test_complete_today_returns_none_without_an_occurrence(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Acontece de verdade: notificação que sobreviveu ao end_date."""
    svc = RecurringService(store, tasks)
    rule = await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")

    assert await svc.complete_today(
        rule.id, datetime(2026, 8, 5, 13, 0, tzinfo=timezone.utc),
    ) is None


async def test_complete_today_ignores_another_rules_occurrence(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """A regra alvo é materializada por ÚLTIMO de propósito.

    Se ela fosse a primeira, seria a tarefa 1 com ou sem o filtro por
    `recurring_id` e o teste passaria mesmo com o filtro removido — que é
    justamente a coisa que este teste existe para proteger.
    """
    svc = RecurringService(store, tasks)
    other = await svc.create(title="Outra", frequency="daily", time="15:00")
    mine = await svc.create(title="Minha", frequency="daily", time="10:00")
    await svc.materialize_due(datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc))

    # Pré-condição explícita: a ocorrência da OUTRA regra é a tarefa 1, então
    # sem o filtro por recurring_id é ela que seria concluída.
    assert [t["payload"]["recurring_id"] for t in tasks.created] == [
        other.id, mine.id,
    ]

    task_id = await svc.complete_today(
        mine.id, datetime(2026, 8, 5, 13, 0, tzinfo=timezone.utc),
    )
    assert task_id == 2
    assert tasks.updated == [(2, {"status": "completed"})]


async def test_complete_today_ignores_a_task_that_is_not_recurring(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Mesmo dia e mesmo `recurring_id` no payload; só o `source` difere.

    A impostora entra na lista ANTES da ocorrência real, então casaria
    primeiro se o filtro por `source` sumisse.
    """
    svc = RecurringService(store, tasks)
    rule = await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")
    tasks.created.append({
        "source": "chat",
        "payload": {"recurring_id": rule.id},
        "due_date": "2026-08-05",
    })
    await svc.materialize_due(datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc))

    task_id = await svc.complete_today(
        rule.id, datetime(2026, 8, 5, 13, 0, tzinfo=timezone.utc),
    )
    assert task_id == 2
    assert tasks.updated == [(2, {"status": "completed"})]


# ----------------------------------------------------------------------
# Mexer na regra tem de mexer no job JÁ agendado de hoje
#
# A ocorrência do dia é materializada às 00:05 e o job entra no jobstore
# ali. Editar a regra às 09h sem tocar nesse job faz o backend disparar
# bolha, TTS, push e email às 10h por um lembrete que acabou de ser
# desligado, pausado, apagado ou movido. Só se corrige sozinho amanhã --
# que é por que nenhum teste pegava isso.
# ----------------------------------------------------------------------


_MATERIALIZE_AT = datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc)   # 09:00 BRT
_EDIT_AT = datetime(2026, 8, 5, 12, 30, tzinfo=timezone.utc)         # 09:30 BRT


async def _rule_with_todays_job(
    store: MemoryStore, tasks: _FakeTaskService, sched: Any,
    *, time: str = "10:00",
) -> tuple[RecurringService, Any]:
    """Regra diária já materializada hoje, com o job de hoje no scheduler."""
    svc = RecurringService(store, tasks, scheduler=sched)
    rule = await svc.create(title="Apoiar Aline", frequency="daily", time=time)
    created = await svc.materialize_due(_MATERIALIZE_AT)
    assert len(created) == 1
    if sched is not None:
        assert [a["reminder_id"] for a in sched.added] == ["task-remind-1"]
    return svc, rule


async def test_turning_the_reminder_off_cancels_todays_job(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    await svc.update(rule.id, remind=None, _remind_provided=True, now=_EDIT_AT)

    assert sched.cancelled == ["task-remind-1"]


async def test_pausing_the_rule_cancels_todays_job(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    await svc.update(rule.id, active=False, now=_EDIT_AT)

    assert sched.cancelled == ["task-remind-1"]


async def test_deleting_the_rule_cancels_todays_job(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    assert await svc.delete(rule.id, now=_EDIT_AT) == 1

    assert sched.cancelled == ["task-remind-1"]


async def test_changing_the_time_rebooks_todays_job_at_the_new_hour(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """`add_reminder` usa replace_existing=True, então o mesmo job id
    substitui limpo -- mas o horário tem de ser o novo."""
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    await svc.update(rule.id, time="19:00", _time_provided=True, now=_EDIT_AT)

    assert len(sched.added) == 2
    rebooked = sched.added[1]
    assert rebooked["reminder_id"] == "task-remind-1"
    assert rebooked["fire_at"].date() == date(2026, 8, 5)
    assert (rebooked["fire_at"].hour, rebooked["fire_at"].minute) == (19, 0)
    assert sched.cancelled == []


async def test_changing_the_time_moves_the_due_time_of_todays_card(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """O card e o calendário leem `due_time`; deixá-lo às 10:00 faria a
    tarefa de hoje discordar da regra que a criou."""
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    await svc.update(rule.id, time="19:00", _time_provided=True, now=_EDIT_AT)

    assert tasks.updated == [(1, {"due_time": "19:00"})]


async def test_moving_the_time_into_the_past_cancels_instead_of_leaving_it(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Às 09:30 BRT, mover para 08:00 é mover para o passado.

    `schedule_task_reminder` devolve None SEM tocar no scheduler nesse caso,
    então o job das 10:00 continuaria vivo e dispararia -- o horário que o
    usuário acabou de trocar.
    """
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    await svc.update(rule.id, time="08:00", _time_provided=True, now=_EDIT_AT)

    assert len(sched.added) == 1  # nada de novo foi agendado
    assert sched.cancelled == ["task-remind-1"]


async def test_reactivating_the_rule_rebooks_todays_job(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """O contrário de pausar: religar no mesmo dia devolve o lembrete."""
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)
    await svc.update(rule.id, active=False, now=_EDIT_AT)

    await svc.update(rule.id, active=True, now=_EDIT_AT)

    assert [a["reminder_id"] for a in sched.added] == [
        "task-remind-1", "task-remind-1",
    ]
    assert sched.added[1]["fire_at"].hour == 10


async def test_editing_a_rule_without_an_occurrence_today_touches_nothing(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Sem tarefa de hoje não há job de hoje. Amanhã a materialização já
    lê a regra nova."""
    sched = _FakeScheduler()
    svc = RecurringService(store, tasks, scheduler=sched)
    rule = await svc.create(title="Apoiar Aline", frequency="daily", time="10:00")

    await svc.update(rule.id, remind=None, _remind_provided=True, now=_EDIT_AT)
    assert await svc.delete(rule.id, now=_EDIT_AT) == 1

    assert sched.added == []
    assert sched.cancelled == []


async def test_reconciliation_is_inert_without_a_scheduler(
    store: MemoryStore, tasks: _FakeTaskService,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """O scheduler é opcional -- metade dos testes e qualquer boot em que o
    jobstore não subiu constroem o serviço sem ele.

    "Não explode" sozinho não prova nada aqui: todo caminho do lembrete é
    embrulhado em `except Exception`, então sem a guarda um `None.add_reminder`
    viraria um traceback engolido e o teste seguiria verde. O que se assere,
    então, é que NADA foi registrado como erro.
    """
    svc, rule = await _rule_with_todays_job(store, tasks, None)

    with caplog.at_level(logging.ERROR):
        await svc.update(rule.id, remind=None, _remind_provided=True, now=_EDIT_AT)
        await svc.update(rule.id, active=False, now=_EDIT_AT)
        await svc.update(rule.id, time="19:00", _time_provided=True, now=_EDIT_AT)
        assert await svc.delete(rule.id, now=_EDIT_AT) == 1

    assert [r.message for r in caplog.records if r.levelno >= logging.ERROR] == []
    # O `due_time` do card não depende do scheduler.
    assert tasks.updated == [(1, {"due_time": "19:00"})]


async def test_update_survives_a_scheduler_that_fails_to_cancel(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """Espelho de `test_materialization_survives_a_scheduler_that_raises`,
    do lado do cancelamento: o jobstore fora do ar não pode derrubar a
    edição da regra, que é o dado que o usuário acabou de pedir."""

    class _BrokenCancel(_FakeScheduler):
        def cancel_reminder(self, reminder_id: str) -> bool:
            raise RuntimeError("jobstore offline")

    svc, rule = await _rule_with_todays_job(store, tasks, _BrokenCancel())

    off = await svc.update(
        rule.id, remind=None, _remind_provided=True, now=_EDIT_AT,
    )
    assert off is not None and off.remind is None


async def test_renaming_the_rule_does_not_disturb_todays_job(
    store: MemoryStore, tasks: _FakeTaskService,
) -> None:
    """A reconciliação é gatilhada por active/time/remind. Um patch de
    título não pode reagendar nem cancelar nada."""
    sched = _FakeScheduler()
    svc, rule = await _rule_with_todays_job(store, tasks, sched)

    await svc.update(rule.id, title="Outro nome", now=_EDIT_AT)

    assert len(sched.added) == 1
    assert sched.cancelled == []
