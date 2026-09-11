"""RecurringService -- CRUD + materialization for recurring task rules.

Single-tenant: no user_id scoping. Materialization is idempotent:
last_materialized_date is bumped after a successful insert, so running
the loop N times on the same day creates at most one task per rule.
"""

from __future__ import annotations

import asyncio
import calendar
import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store
from mod_tasks.service import TaskService

from seraphine.recurring.models import RecurringRule
from seraphine.reminders.tasks import schedule_task_reminder

logger = logging.getLogger(__name__)

# Single-tenant app, one human, one timezone. "Which day is it" must be
# answered in HIS timezone, never the server's: the background loop passes a
# UTC `now`, so between 21:00 and midnight BRT the naive reading is already
# tomorrow — the rule fires a day early AND claims the slot, so the real
# tomorrow is then skipped.
SP_TZ = ZoneInfo("America/Sao_Paulo")

# Deliberadamente sem `1d_before`, que `add_task` aceita: a ocorrência de uma
# regra é criada NO dia em que vence, então um lembrete de véspera já nasceria
# no passado e seria descartado pelo jobstore.
_VALID_REMIND = ("at_time", "1h_before")


def _local_date(now: datetime) -> date:
    """The calendar date `now` falls on for the user.

    Naive datetimes are taken at face value so callers that already did the
    conversion (and tests) aren't shifted a second time.
    """
    if now.tzinfo is None:
        return now.date()
    return now.astimezone(SP_TZ).date()


def _resolve_now(now: datetime | None) -> datetime:
    """`now` explícito (testes, chamadores que já resolveram) ou o relógio.

    Sempre com fuso: `_local_date` só converte o que é ciente, e um ingênuo
    aqui viraria "o dia do servidor", que é justamente o que este módulo
    existe para não fazer.
    """
    return now if now is not None else datetime.now(timezone.utc)


_SELECT_COLS = (
    "id, title, description, frequency, weekday, day_of_month,"
    " time, end_date, remind, active, last_materialized_date,"
    " created_at, updated_at"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_rule(row: tuple[Any, ...]) -> RecurringRule:
    return RecurringRule(
        id=row[0],
        title=row[1],
        description=row[2],
        frequency=row[3],
        weekday=row[4],
        day_of_month=row[5],
        time=row[6],
        end_date=row[7],
        remind=row[8],
        active=bool(row[9]),
        last_materialized_date=row[10],
        created_at=row[11],
        updated_at=row[12],
    )


def _normalize_end_date(end_date: str | None) -> str | None:
    """Accept only YYYY-MM-DD. The LLM otherwise happily sends '22/08/2026',
    which would sort wrong against ISO dates and silently never expire."""
    if end_date is None:
        return None
    raw = end_date.strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        raise ValueError("end_date must be YYYY-MM-DD") from None


def _normalize_remind(remind: str | None, *, time: str | None) -> str | None:
    """`None` numa regra com hora vira `at_time` — um lembrete diário às
    10h é, por definição, um lembrete. Regra sem hora não ganha nada."""
    if remind is None:
        return "at_time" if time else None
    raw = remind.strip()
    if not raw:
        return None
    if raw not in _VALID_REMIND:
        raise ValueError(f"remind must be one of {', '.join(_VALID_REMIND)}")
    return raw


def _applicable_fields(
    frequency: str, weekday: int | None, day_of_month: int | None,
) -> tuple[int | None, int | None]:
    """Drop the fields the frequency doesn't use.

    The LLM fills unused slots with sentinels (``-1`` observed in production)
    rather than omitting them, and a daily rule was rejected for a weekday it
    never reads. Only the field the frequency actually uses is validated.
    """
    if frequency != "weekly":
        weekday = None
    if frequency != "monthly":
        day_of_month = None
    return weekday, day_of_month


def _is_due_today(rule: RecurringRule, today: date) -> bool:
    """Pure weekday/day-of-month arithmetic. Monday=0..Sunday=6 matches
    Python's date.weekday() so no conversion is needed."""
    if not rule.active:
        return False
    # Inclusive end date: a "20 day challenge" must actually stop.
    if rule.end_date and today.isoformat() > rule.end_date:
        return False
    if rule.frequency == "daily":
        return True
    if rule.frequency == "weekly":
        if rule.weekday is None:
            return False
        return today.weekday() == rule.weekday
    if rule.frequency == "monthly":
        if rule.day_of_month is None:
            return False
        # Clamp: if the rule says "day 31" but the month has only 30,
        # fire on the last day of the month instead of skipping it.
        #
        # DIVERGÊNCIA CONHECIDA COM O iOS: o `case "monthly"` de
        # `src-tauri/swift/NotificationBridge.swift` faz `comps.day = 31` num
        # `UNCalendarNotificationTrigger(repeats: true)`, que simplesmente não
        # casa em fevereiro — "último dia do mês" não é expressável nesse
        # trigger. Em fevereiro a regra "todo dia 31" gera card e lembrete de
        # servidor, mas NENHUMA notificação de tela bloqueada. O sync conta
        # essas regras e devolve `monthlyClampRisk`. Ver "Custos aceitos" em
        # docs/superpowers/specs/2026-08-02-recurring-notifications-design.md.
        last = calendar.monthrange(today.year, today.month)[1]
        target = min(rule.day_of_month, last)
        return today.day == target
    return False


class RecurringService:
    def __init__(
        self, store: Store, tasks: TaskService, scheduler: Any = None,
    ) -> None:
        self._store = store
        self._tasks = tasks
        self._scheduler = scheduler

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        title: str,
        frequency: str,
        weekday: int | None = None,
        day_of_month: int | None = None,
        time: str | None = None,
        description: str | None = None,
        end_date: str | None = None,
        remind: str | None = None,
    ) -> RecurringRule:
        if frequency not in ("daily", "weekly", "monthly"):
            raise ValueError(f"invalid frequency: {frequency!r}")
        weekday, day_of_month = _applicable_fields(
            frequency, weekday, day_of_month,
        )
        if frequency == "weekly" and weekday is None:
            raise ValueError("weekday is required for frequency=weekly")
        if frequency == "monthly" and day_of_month is None:
            raise ValueError("day_of_month is required for frequency=monthly")
        if weekday is not None and not (0 <= weekday <= 6):
            raise ValueError("weekday must be 0..6")
        if day_of_month is not None and not (1 <= day_of_month <= 31):
            raise ValueError("day_of_month must be 1..31")
        end_date = _normalize_end_date(end_date)
        remind = _normalize_remind(remind, time=time)

        rid = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> RecurringRule:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO recurring_tasks"
                    " (id, title, description, frequency, weekday,"
                    "  day_of_month, time, end_date, remind, active,"
                    "  last_materialized_date, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)",
                    (rid, title.strip(),
                     (description or "").strip() or None,
                     frequency, weekday, day_of_month, time, end_date,
                     remind, ts, ts),
                )
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks WHERE id = ?",
                    (rid,),
                ).fetchone()
            return _row_to_rule(row)

        return await asyncio.to_thread(_work)

    async def list_all(self) -> list[RecurringRule]:
        def _work() -> list[RecurringRule]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks"
                    " ORDER BY created_at DESC",
                ).fetchall()
            return [_row_to_rule(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get(self, rule_id: str) -> RecurringRule | None:
        def _work() -> RecurringRule | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks"
                    " WHERE id = ?",
                    (rule_id,),
                ).fetchone()
            return _row_to_rule(row) if row else None

        return await asyncio.to_thread(_work)

    async def update(
        self,
        rule_id: str,
        *,
        active: bool | None = None,
        time: str | None = None,
        weekday: int | None = None,
        day_of_month: int | None = None,
        title: str | None = None,
        description: str | None = None,
        frequency: str | None = None,
        end_date: str | None = None,
        remind: str | None = None,
        now: datetime | None = None,
        _time_provided: bool = False,
        _weekday_provided: bool = False,
        _day_of_month_provided: bool = False,
        _description_provided: bool = False,
        _end_date_provided: bool = False,
        _remind_provided: bool = False,
    ) -> RecurringRule | None:
        """Patch-style update. Fields not mentioned stay untouched.

        ``now`` só decide QUAL é o dia de hoje para a reconciliação do job já
        agendado (e é passado nos testes); nada mais no update depende dele.
        """
        current = await self.get(rule_id)
        if current is None:
            return None

        if frequency is not None and frequency not in (
            "daily", "weekly", "monthly",
        ):
            raise ValueError(f"invalid frequency: {frequency!r}")
        # Validate against the shape the rule will have AFTER the patch, so a
        # daily->weekly switch still demands a weekday and a weekday sent to a
        # daily rule is dropped rather than rejected.
        effective_freq = frequency or current.frequency
        merged_weekday = weekday if _weekday_provided else current.weekday
        merged_dom = day_of_month if _day_of_month_provided else current.day_of_month
        merged_weekday, merged_dom = _applicable_fields(
            effective_freq, merged_weekday, merged_dom,
        )
        if effective_freq == "weekly" and merged_weekday is None:
            raise ValueError("weekday is required for frequency=weekly")
        if effective_freq == "monthly" and merged_dom is None:
            raise ValueError("day_of_month is required for frequency=monthly")
        if merged_weekday is not None and not (0 <= merged_weekday <= 6):
            raise ValueError("weekday must be 0..6")
        if merged_dom is not None and not (1 <= merged_dom <= 31):
            raise ValueError("day_of_month must be 1..31")

        sets: list[str] = []
        params: list[Any] = []
        if active is not None:
            sets.append("active = ?")
            params.append(1 if active else 0)
        if title is not None:
            sets.append("title = ?")
            params.append(title.strip())
        if _time_provided:
            sets.append("time = ?")
            params.append(time)
        if _end_date_provided:
            sets.append("end_date = ?")
            params.append(_normalize_end_date(end_date))
        if _remind_provided:
            sets.append("remind = ?")
            params.append(
                _normalize_remind(remind, time=None) if remind else None
            )
        if frequency is not None:
            sets.append("frequency = ?")
            params.append(frequency)
        if _weekday_provided or frequency is not None:
            sets.append("weekday = ?")
            params.append(merged_weekday)
        if _day_of_month_provided or frequency is not None:
            sets.append("day_of_month = ?")
            params.append(merged_dom)
        if _description_provided:
            sets.append("description = ?")
            params.append((description or "").strip() or None)

        if not sets:
            return current

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.append(rule_id)

        def _work() -> RecurringRule | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE recurring_tasks SET {', '.join(sets)}"
                    " WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks WHERE id = ?",
                    (rule_id,),
                ).fetchone()
            return _row_to_rule(row) if row else None

        updated = await asyncio.to_thread(_work)
        if updated is None:
            return None

        # A ocorrência de HOJE já foi materializada e o job já está no
        # jobstore: sem isto, desligar o lembrete às 09h ainda dispara bolha,
        # TTS, push e email às 10h. Só se auto-corrige amanhã.
        if active is not None or _time_provided or _remind_provided:
            await self._reconcile_today(
                updated, now=now, time_changed=_time_provided,
            )
        return updated

    async def delete(self, rule_id: str, *, now: datetime | None = None) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM recurring_tasks WHERE id = ?",
                    (rule_id,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        if affected and self._scheduler is not None:
            # A regra sumiu, mas o job de hoje continuaria no jobstore — a
            # busca da ocorrência é pelo payload da tarefa, então não depende
            # da linha que acabou de ser apagada.
            task_id = await self._todays_occurrence(rule_id, _resolve_now(now))
            if task_id is not None:
                self._cancel_reminder(task_id)
        return affected

    # ------------------------------------------------------------------
    # Reconciliação do job já agendado
    # ------------------------------------------------------------------

    def _cancel_reminder(self, task_id: int) -> None:
        """Best-effort: o lembrete é acessório e um scheduler capenga não
        pode derrubar o update da regra.

        Os dois chamadores já checaram `self._scheduler is not None`; repetir
        a checagem aqui só criaria um ramo que nenhum teste alcança.
        """
        try:
            self._scheduler.cancel_reminder(f"task-remind-{task_id}")
        except Exception:
            logger.exception(
                "recurring: failed to cancel reminder for task %s", task_id,
            )

    async def _reconcile_today(
        self,
        rule: RecurringRule,
        *,
        now: datetime | None,
        time_changed: bool,
    ) -> None:
        """Põe a ocorrência JÁ materializada de hoje de acordo com a regra
        recém-editada: reagenda, cancela e acerta o `due_time` do card.

        Sem ocorrência hoje não há nada a fazer — a materialização de amanhã
        já lê a regra nova.
        """
        ref = _resolve_now(now)
        today_iso = _local_date(ref).isoformat()
        task_id = await self._todays_occurrence(rule.id, ref)
        if task_id is None:
            return

        if time_changed:
            # O card e o calendário mostram `due_time`; deixá-lo no horário
            # antigo faria a tarefa de hoje discordar da regra que a criou.
            try:
                if rule.time:
                    await self._tasks.update_task(task_id, due_time=rule.time)
                else:
                    await self._tasks.update_task(task_id, unset_due_time=True)
            except Exception:
                logger.exception(
                    "recurring: failed to move due_time of task %s", task_id,
                )

        if self._scheduler is None:
            return

        if not rule.active or not rule.remind:
            self._cancel_reminder(task_id)
            return

        # `add_reminder` usa replace_existing=True, então reagendar com o
        # mesmo job id substitui limpo. Mas `schedule_task_reminder` devolve
        # None SEM tocar no scheduler quando a hora nova já passou — aí o job
        # antigo continuaria vivo no horário velho, e cancelar é o certo.
        booked = schedule_task_reminder(
            self._scheduler,
            task_id,
            rule.title,
            today_iso,
            rule.time,
            rule.remind,
            now=ref,
        )
        if booked is None:
            self._cancel_reminder(task_id)

    # ------------------------------------------------------------------
    # Materialization
    # ------------------------------------------------------------------

    async def materialize_due(
        self, now: datetime,
    ) -> list[tuple[RecurringRule, int]]:
        """For every active rule that is due today and hasn't been fired
        yet today, create one mod_tasks task and bump last_materialized_date.

        Returns the list of (rule, task_id) tuples that were materialized.
        """
        today = _local_date(now)
        today_iso = today.isoformat()

        def _candidates() -> list[RecurringRule]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks"
                    " WHERE active = 1"
                    " AND (last_materialized_date IS NULL"
                    "      OR last_materialized_date < ?)",
                    (today_iso,),
                ).fetchall()
            return [_row_to_rule(r) for r in rows]

        rules = await asyncio.to_thread(_candidates)
        created: list[tuple[RecurringRule, int]] = []
        for rule in rules:
            if not _is_due_today(rule, today):
                continue
            try:
                task_id = await self._materialize_rule(rule, today_iso, now=now)
                if task_id is not None:
                    created.append((rule, task_id))
            except Exception:
                logger.exception(
                    "materialize_due: failed for rule %s", rule.id,
                )
        return created

    async def _materialize_rule(
        self, rule: RecurringRule, today_iso: str, *, now: datetime | None = None,
    ) -> int | None:
        """Create a task for this rule today. Uses a conditional UPDATE
        to claim the day -- if another loop already materialized, the
        UPDATE affects zero rows and we skip insert.

        ``now`` is only forwarded to the reminder scheduler, which refuses
        fire times already in the past; it never decides the date (that is
        ``today_iso``, already resolved in the user's timezone).
        """

        # Atomically claim today's slot AND remember the prior value so
        # we can roll it back if task creation fails. Without this
        # claim-before-create order, two concurrent runs would both see
        # the gate as open and create duplicate tasks.
        def _claim() -> str | None:
            """Return the prior ``last_materialized_date`` (possibly None)
            on successful claim, or the sentinel ``"__not_claimed__"``
            when the row was already advanced by another loop."""
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT last_materialized_date FROM recurring_tasks"
                    " WHERE id = ? AND active = 1"
                    "   AND (last_materialized_date IS NULL"
                    "        OR last_materialized_date < ?)",
                    (rule.id, today_iso),
                ).fetchone()
                if row is None:
                    return "__not_claimed__"
                prior = row[0]
                cur = conn.execute(
                    "UPDATE recurring_tasks"
                    " SET last_materialized_date = ?, updated_at = ?"
                    " WHERE id = ?"
                    "   AND active = 1"
                    "   AND (last_materialized_date IS NULL"
                    "        OR last_materialized_date < ?)",
                    (today_iso, _now_iso(), rule.id, today_iso),
                )
                if (cur.rowcount or 0) == 0:
                    return "__not_claimed__"
                return prior  # may legitimately be None

        claim_result = await asyncio.to_thread(_claim)
        if claim_result == "__not_claimed__":
            return None
        prior_date = claim_result  # str | None

        try:
            task_id = await self._tasks.create_task(
                type="generic",
                title=rule.title,
                description=rule.description or "",
                source="recurring",
                payload={"recurring_id": rule.id},
                status="pending",
                due_date=today_iso,
                due_time=rule.time,
                user_id=None,  # single-tenant
            )
        except Exception:
            # Restore the prior value so today's loop can retry. Guard
            # by current value = today_iso so we don't clobber a
            # subsequent successful claim by another caller.
            def _rollback() -> None:
                with self._store._connect() as conn:
                    conn.execute(
                        "UPDATE recurring_tasks"
                        " SET last_materialized_date = ?, updated_at = ?"
                        " WHERE id = ? AND last_materialized_date = ?",
                        (prior_date, _now_iso(), rule.id, today_iso),
                    )

            try:
                await asyncio.to_thread(_rollback)
            except Exception:
                logger.exception(
                    "materialize_rule: rollback of last_materialized_date"
                    " failed for rule %s",
                    rule.id,
                )
            raise

        # Lembrete é acessório: a tarefa do dia é o produto, e um
        # scheduler indisponível não pode custá-la.
        if rule.remind and self._scheduler is not None:
            try:
                schedule_task_reminder(
                    self._scheduler,
                    task_id,
                    rule.title,
                    today_iso,
                    rule.time,
                    rule.remind,
                    now=now,
                )
            except Exception:
                logger.exception(
                    "materialize_rule: failed to schedule reminder for rule %s",
                    rule.id,
                )
        return task_id

    async def materialize_for_rule_if_due(
        self, rule: RecurringRule, now: datetime,
    ) -> int | None:
        """Same logic used by create_recurring_task tool right after insert --
        if today matches, fire an occurrence immediately so the user sees
        today's card."""
        today = _local_date(now)
        if not _is_due_today(rule, today):
            return None
        return await self._materialize_rule(rule, today.isoformat(), now=now)

    async def _todays_occurrence(
        self, rule_id: str, now: datetime,
    ) -> int | None:
        """O id da tarefa materializada hoje por esta regra, ou None.

        Uma implementação só, com dois donos: o botão "Concluir" da
        notificação nativa e a reconciliação do job já agendado. Duas cópias
        divergiriam justamente no filtro que importa.

        A busca é DE PROPÓSITO sem filtro de `status`: um segundo toque no
        botão reconclui a mesma tarefa e devolve 200, em vez de um 404 que o
        usuário leria como falha. Não filtre por `status="pending"` aqui.
        """
        today_iso = _local_date(now).isoformat()
        candidates = await self._tasks.list_tasks(
            due_from=today_iso, due_to=today_iso, limit=200,
        )
        for task in candidates:
            if getattr(task, "source", None) != "recurring":
                continue
            payload = getattr(task, "payload", None) or {}
            if payload.get("recurring_id") != rule_id:
                continue
            task_id = getattr(task, "id", None)
            if task_id is None:
                continue
            return int(task_id)
        return None

    async def complete_today(
        self, rule_id: str, now: datetime,
    ) -> int | None:
        """Conclui a ocorrência de hoje desta regra.

        Existe para o botão da notificação nativa: uma notificação repetida
        tem `userInfo` congelado, então ela carrega o rule_id e a tarefa do
        dia é resolvida aqui, na hora do toque.
        """
        task_id = await self._todays_occurrence(rule_id, now)
        if task_id is None:
            return None
        await self._tasks.update_task(task_id, status="completed")
        return task_id
