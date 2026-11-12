"""Routines of the agent harness (phase 6b): storage, the clock and the life of a routine run.

``RoutineMixin`` is part of ``AgentHarnessService`` (kept in its own file because the service is large).
A routine is a stored request of one agent with a schedule. The clock (``tick``) finds the routines that
are due and starts an ordinary run of the agent (``requested_by="routine"``) in the agent's home; the run
goes through the same queue, approvals and limits as any other. When the run ends, its line in the ledger
(``agent_routine_runs``) is closed with its final state (``_routine_run_finished``). A routine never grants
anything: it adds no permission and bypasses no approval.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from seraphine.agents import routines
from seraphine.agents.errors import Conflict, HarnessError, Invalid, NotFound

#: Refusal of an archived agent (``agent_page`` and the service import it from here).
AGENT_ARCHIVED_TEXT = "Este agente está arquivado. Restaure-o para voltar a conversar com ele."
PAUSED_TEXT = "O agente está pausado."
ARCHIVED_TEXT = "O agente está arquivado."

logger = logging.getLogger(__name__)

ROUTINE_SOURCES_OK = ("manual", "guide", "copy")
TERMINAL = ("done", "failed", "cancelled")
LINE_STATES = ("running", "reported", "quiet", "failed", "cancelled", "skipped", "missed")
TRIGGERS = ("schedule", "manual", "catchup")
#: A run later than this after its time counts as a "catchup", not as the schedule itself.
CATCHUP_AFTER_S = 300
#: The ledger line of a routine that ran longer ago than this is out of the "week" numbers.
WEEK_DAYS = 7
#: Missed times older than the catch-up window are recorded, but at most this many per tick.
MISSED_LINES_MAX = 20
#: How far back the missed times are walked (older ones are not individually recorded).
MISSED_WALK_DAYS = 31
MISSED_WALK_MAX = 5000
#: A line that never got a run (the backend stopped between the two writes) is closed after this.
ORPHAN_LINE_S = 120
LIST_RUNS_DEFAULT = 20
LIST_RUNS_MAX = 100
PAUSE_REASON = "failures"

FAILURE_TEXTS = {
    "interrupted": "O sistema reiniciou e a execução não pôde ser retomada.",
    "interrupted_mid_action": "O sistema reiniciou no meio de uma ação, e a execução não foi retomada.",
    "budget_exceeded": "O orçamento diário do agente acabou.",
    "approval_expired": "Um pedido de aprovação expirou sem resposta.",
    "agent_unavailable": "O agente não existe ou foi desligado.",
    "engine_unavailable": "O motor do agente não está disponível.",
    "engine_auth": "O login do motor do agente deixou de valer.",
    "plan_limit": "O limite de uso do plano não voltou a tempo.",
    "provider_unavailable": "O provedor de IA ficou sem responder.",
    "owner_no_answer": "O dono não respondeu à pergunta do agente a tempo.",
}


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _parse(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def _rows(conn: Any, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _one(conn: Any, sql: str, params: tuple = ()) -> dict[str, Any] | None:
    rows = _rows(conn, sql, params)
    return rows[0] if rows else None


def _span_text(seconds: float) -> str:
    seconds = int(seconds)
    if seconds >= 3600 and seconds % 3600 == 0:
        n = seconds // 3600
        return f"{n} {'hora' if n == 1 else 'horas'}"
    n = max(1, round(seconds / 60))
    return f"{n} {'minuto' if n == 1 else 'minutos'}"


def _line_dict(row: dict[str, Any]) -> dict[str, Any]:
    """A ledger line as the API shows it."""
    return {"id": row["id"], "routine_id": row["routine_id"], "scheduled_for": row["scheduled_for"],
            "trigger": row["fired_by"], "status": row["status"], "run_id": row.get("run_id"),
            "detail": row.get("detail") or "", "finished_at": row.get("finished_at")}


def routine_preface(title: str, report: str | None) -> str:
    """What the agent is told, before the request, when a run is a routine's: nobody is there to answer,
    which routine it is and, for ``news``, the ``SEM_NOVIDADE`` rule."""
    parts = [
        "--- ROTINA ---",
        "Esta é uma execução de rotina, no horário combinado, e o dono NÃO está presente agora. Não faça "
        "perguntas de esclarecimento: faça o melhor possível com o que você tem e, se faltar alguma coisa, "
        "diga isso no relato.",
        f"Rotina: «{title}»",
    ]
    if report == "news":
        parts.append(
            f"Regra do relato: se não houver nada novo para contar, responda apenas {routines.NO_NEWS}, sem "
            "mais nenhuma palavra. Se houver novidade, relate de forma curta e clara.")
    return "\n".join(parts)


class RoutineMixin:
    """Methods of ``AgentHarnessService`` for routines. Expects ``_db``, ``_publish``, ``now``,
    ``_stopping``, ``settings``, ``guide``, ``get_def``/``_require_def``, ``ensure_home``, ``start_run``,
    ``_raw_run`` and ``_store_message`` from the service."""

    def _init_routines(self, settings: Any) -> None:
        self.routine_tick_s = max(0.05, float(getattr(settings, "agents_routine_tick_s", 30.0)))
        self.routine_catchup_s = max(0, int(getattr(settings, "agents_routine_catchup_s", 43200)))
        self.routine_fail_pause = max(1, int(getattr(settings, "agents_routine_fail_pause", 5)))
        self.routine_min_interval_min = max(1, int(getattr(settings, "agents_routine_min_interval_min", 15)))
        self.routine_max_active = max(1, int(getattr(settings, "agents_routine_max_active", 20)))
        #: Local time of this PC; tests replace it with a ``routines.FixedOffset``.
        self.local_time: routines.LocalTime = routines.LocalTime()
        self._routine_task: asyncio.Task | None = None
        self._routine_lock = asyncio.Lock()
        self.guide.now_local = self._local_now
        self.guide.min_interval_min = self.routine_min_interval_min

    # ------------------------------------------------------------------
    # Small helpers
    # ------------------------------------------------------------------

    def _local_now(self) -> datetime:
        return self.local_time.to_local(self.now())  # type: ignore[attr-defined]

    def _next_iso(self, schedule: dict[str, Any], anchor_iso: str | None, after: datetime) -> str | None:
        """The first time of ``schedule`` strictly after the UTC instant ``after``, as UTC ISO (or None)."""
        after_local = self.local_time.to_local(after)
        anchor = _parse(anchor_iso)
        anchor_local = self.local_time.to_local(anchor) if anchor else after_local
        nxt = routines.next_occurrence(schedule, after_local, anchor_local)
        return _iso(self.local_time.to_utc(nxt)) if nxt else None

    def _check_fields(self, raw: dict[str, Any], *, require_future: bool = True) -> dict[str, Any]:
        return routines.validate_routine(
            raw, now_local=self._local_now(), min_interval=self.routine_min_interval_min,
            local=self.local_time, require_future=require_future)

    def _routine_objects(self, conn: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Routine rows as the API shows them (with the phrase, the next times, the week and ``running``)."""
        if not rows:
            return []
        now = self.now()  # type: ignore[attr-defined]
        ids = [r["id"] for r in rows]
        marks = ",".join("?" for _ in ids)
        running = {r[0] for r in conn.execute(
            f"SELECT DISTINCT routine_id FROM agent_routine_runs WHERE status = 'running'"
            f" AND routine_id IN ({marks})", tuple(ids))}
        since = _iso(now - timedelta(days=WEEK_DAYS))
        week: dict[str, dict[str, int]] = {i: {"ok": 0, "total": 0} for i in ids}
        for rid, status, n in conn.execute(
                f"SELECT routine_id, status, COUNT(*) FROM agent_routine_runs WHERE routine_id IN ({marks})"
                f" AND fired_by != 'manual' AND status != 'running' AND scheduled_for >= ?"
                f" GROUP BY routine_id, status", (*ids, since)):
            week[rid]["total"] += n
            if status in ("reported", "quiet"):
                week[rid]["ok"] += n
        out: list[dict[str, Any]] = []
        for row in rows:
            schedule = json.loads(row["schedule"])
            enabled = bool(row["enabled"])
            upcoming: list[str] = []
            if enabled:
                cursor = now
                for _ in range(3):
                    nxt = self._next_iso(schedule, row.get("anchor_at"), cursor)
                    if nxt is None:
                        break
                    upcoming.append(nxt)
                    cursor = _parse(nxt)  # type: ignore[assignment]
            out.append({
                "id": row["id"], "agent_id": row["agent_id"], "project_id": row["project_id"],
                "title": row["title"], "prompt": row["prompt"], "schedule": schedule,
                "schedule_text": routines.schedule_text(schedule), "report": row["report"],
                "enabled": enabled, "paused_reason": row.get("paused_reason") or None,
                "next_run_at": row.get("next_run_at") if enabled else None, "upcoming": upcoming,
                "last_run_at": row.get("last_run_at"), "last_status": row.get("last_status"),
                "consecutive_failures": int(row.get("consecutive_failures") or 0),
                "week": week[row["id"]], "running": row["id"] in running,
                "origin": row.get("origin") or "manual", "created_at": row["created_at"],
                "updated_at": row["updated_at"]})
        return out

    async def _routine_view(self, routine_id: str) -> dict[str, Any] | None:
        def _r(conn: Any) -> dict[str, Any] | None:
            row = _one(conn, "SELECT * FROM agent_routines WHERE id = ?", (routine_id,))
            return self._routine_objects(conn, [row])[0] if row else None

        return await self._db(_r)  # type: ignore[attr-defined]

    async def _routine_changed(self, routine_id: str) -> dict[str, Any] | None:
        """Publish the routine's current state (``routine_update``) and return it."""
        routine = await self._routine_view(routine_id)
        if routine is not None:
            self._publish({"type": "routine_update", "routine": routine})  # type: ignore[attr-defined]
        return routine

    async def _require_routine(self, routine_id: str) -> dict[str, Any]:
        routine = await self._routine_view(routine_id)
        if routine is None:
            raise NotFound("rotina não encontrada")
        return routine

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def list_routines(self, agent_id: str | None = None) -> list[dict[str, Any]]:
        def _r(conn: Any) -> list[dict[str, Any]]:
            if agent_id:
                rows = _rows(conn, "SELECT * FROM agent_routines WHERE agent_id = ?"
                                   " ORDER BY created_at, rowid", (agent_id,))
            else:
                rows = _rows(conn, "SELECT * FROM agent_routines ORDER BY created_at, rowid")
            return self._routine_objects(conn, rows)

        return await self._db(_r)  # type: ignore[attr-defined]

    async def get_routine(self, routine_id: str) -> dict[str, Any] | None:
        return await self._routine_view(routine_id)

    async def routines_active_count(self) -> int:
        """Routines that are on and can run: those of an archived agent are not counted."""
        return int((await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
            "SELECT COUNT(*) FROM agent_routines r WHERE r.enabled = 1 AND NOT EXISTS ("
            "SELECT 1 FROM agent_defs d WHERE d.id = r.agent_id AND d.archived = 1)").fetchone()))[0])

    def _limit_error(self) -> Conflict:
        return Conflict(f"Este agente já tem {self.routine_max_active} rotinas ativas. Pause ou apague "
                        "alguma antes de ligar outra.", code="routine_limit")

    async def create_routine(self, *, agent_id: str, title: Any, prompt: Any, schedule: Any,
                             report: Any = None, enabled: Any = True, origin: str = "manual"
                             ) -> dict[str, Any]:
        agent = await self._require_def(agent_id)  # type: ignore[attr-defined]
        if agent["archived"]:  # a new routine would bring the archived home back (see ``ensure_home``)
            raise Conflict(AGENT_ARCHIVED_TEXT, code="agent_archived")
        if not isinstance(enabled, bool):
            raise Invalid("«enabled» precisa ser verdadeiro ou falso.")
        fields = self._check_fields({"title": title, "prompt": prompt, "schedule": schedule, "report": report})
        home = await self.ensure_home(agent["id"])  # type: ignore[attr-defined]
        now = self.now()  # type: ignore[attr-defined]
        rid = str(uuid.uuid4())
        next_run = self._next_iso(fields["schedule"], _iso(now), now) if enabled else None

        def _w(conn: Any) -> bool:
            if enabled and conn.execute(
                    "SELECT COUNT(*) FROM agent_routines WHERE agent_id = ? AND enabled = 1",
                    (agent["id"],)).fetchone()[0] >= self.routine_max_active:
                return False
            conn.execute(
                "INSERT INTO agent_routines (id, agent_id, project_id, title, prompt, schedule, report,"
                " enabled, next_run_at, anchor_at, origin, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (rid, agent["id"], home["id"], fields["title"], fields["prompt"],
                 json.dumps(fields["schedule"], ensure_ascii=False), fields["report"], 1 if enabled else 0,
                 next_run, _iso(now), origin, _iso(now), _iso(now)))
            return True

        if not await self._db(_w):  # type: ignore[attr-defined]
            raise self._limit_error()
        return await self._routine_changed(rid)  # type: ignore[return-value]

    async def update_routine(self, routine_id: str, **data: Any) -> dict[str, Any]:
        current = await self._require_routine(routine_id)
        allowed = ("title", "prompt", "schedule", "report", "enabled")
        for key in data:
            if key not in allowed:
                raise Invalid(f"campo desconhecido: {key}")
            if data[key] is None:
                raise Invalid(f"«{key}» não pode ser vazio.")
        if "enabled" in data and not isinstance(data["enabled"], bool):
            raise Invalid("«enabled» precisa ser verdadeiro ou falso.")
        merged = {"title": data.get("title", current["title"]), "prompt": data.get("prompt", current["prompt"]),
                  "report": data.get("report", current["report"]),
                  "schedule": data.get("schedule", current["schedule"])}
        fields = self._check_fields(merged, require_future=False)
        schedule_changed = fields["schedule"] != current["schedule"]
        enabled = data.get("enabled", current["enabled"])
        enabling = enabled and not current["enabled"]
        if schedule_changed or enabling:  # a one-shot time that already passed is refused (new or switched on)
            self._check_fields({**merged, "schedule": fields["schedule"]}, require_future=True)
        now = self.now()  # type: ignore[attr-defined]
        sets: dict[str, Any] = {"title": fields["title"], "prompt": fields["prompt"],
                                "report": fields["report"], "updated_at": _iso(now)}
        if schedule_changed:
            sets["schedule"] = json.dumps(fields["schedule"], ensure_ascii=False)
        if schedule_changed or enabling:
            sets["anchor_at"] = _iso(now)  # an interval counts from the creation or the last change
        if enabling:
            sets.update(paused_reason=None, consecutive_failures=0)
        if not enabled:
            sets.update(enabled=0, next_run_at=None)
            if current["enabled"]:
                sets["paused_reason"] = None  # paused by the owner: not "by failures"
        else:
            sets["enabled"] = 1
            if schedule_changed or enabling:
                sets["next_run_at"] = self._next_iso(fields["schedule"], _iso(now), now)

        def _w(conn: Any) -> bool:
            if enabling and conn.execute(
                    "SELECT COUNT(*) FROM agent_routines WHERE agent_id = ? AND enabled = 1",
                    (current["agent_id"],)).fetchone()[0] >= self.routine_max_active:
                return False
            cols = ", ".join(f"{k} = ?" for k in sets)
            conn.execute(f"UPDATE agent_routines SET {cols} WHERE id = ?", (*sets.values(), routine_id))
            return True

        if not await self._db(_w):  # type: ignore[attr-defined]
            raise self._limit_error()
        return await self._routine_changed(routine_id)  # type: ignore[return-value]

    async def delete_routine(self, routine_id: str) -> None:
        await self._require_routine(routine_id)

        def _w(conn: Any) -> None:
            conn.execute("DELETE FROM agent_routine_runs WHERE routine_id = ?", (routine_id,))
            conn.execute("DELETE FROM agent_routines WHERE id = ?", (routine_id,))

        await self._db(_w)  # type: ignore[attr-defined]
        self._publish({"type": "routine_deleted", "id": routine_id})  # type: ignore[attr-defined]

    def _delete_agent_routines(self, conn: Any, agent_id: str) -> list[str]:
        """Inside the transaction that deletes an agent: its routines and their ledger. Returns the ids."""
        ids = [r[0] for r in conn.execute("SELECT id FROM agent_routines WHERE agent_id = ?", (agent_id,))]
        for rid in ids:
            conn.execute("DELETE FROM agent_routine_runs WHERE routine_id = ?", (rid,))
        conn.execute("DELETE FROM agent_routines WHERE agent_id = ?", (agent_id,))
        return ids

    async def copy_routine(self, routine_id: str) -> dict[str, Any]:
        src = await self._require_routine(routine_id)
        now = self.now()  # type: ignore[attr-defined]
        title = src["title"][: routines.TITLE_MAX - len(routines.COPY_SUFFIX)].rstrip() + routines.COPY_SUFFIX
        rid = str(uuid.uuid4())

        def _w(conn: Any) -> None:
            conn.execute(
                "INSERT INTO agent_routines (id, agent_id, project_id, title, prompt, schedule, report,"
                " enabled, next_run_at, anchor_at, origin, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'copy', ?, ?)",
                (rid, src["agent_id"], src["project_id"], title, src["prompt"],
                 json.dumps(src["schedule"], ensure_ascii=False), src["report"], _iso(now), _iso(now),
                 _iso(now)))

        await self._db(_w)  # type: ignore[attr-defined]
        return await self._routine_changed(rid)  # type: ignore[return-value]

    async def list_routine_runs(self, routine_id: str, limit: int = LIST_RUNS_DEFAULT) -> list[dict[str, Any]]:
        await self._require_routine(routine_id)
        lim = max(1, min(int(limit), LIST_RUNS_MAX))
        rows = await self._db(lambda c: _rows(  # type: ignore[attr-defined]
            c, "SELECT * FROM agent_routine_runs WHERE routine_id = ?"
               " ORDER BY scheduled_for DESC, rowid DESC LIMIT ?", (routine_id, lim)))
        return [_line_dict(r) for r in rows]

    async def draft_routine(self, text: str, agent_id: str | None = None) -> dict[str, Any]:
        """A routine from the owner's sentence, by the assistant's brain. Creates nothing."""
        agent = await self._require_def(agent_id) if agent_id else None  # type: ignore[attr-defined]
        return await self.guide.draft_routine(text, agent)  # type: ignore[attr-defined]

    # ------------------------------------------------------------------
    # The ledger: closing a line
    # ------------------------------------------------------------------

    def _settle_line(self, conn: Any, line: dict[str, Any], status: str, detail: str
                     ) -> dict[str, Any] | None:
        """Close a ``running`` line with its final state and update the routine (last run, failures, the
        pause on the Nth failure in a row, a ``once`` switching itself off). ``None`` when the line was
        no longer running (closed by someone else)."""
        now = _iso(self.now())  # type: ignore[attr-defined]
        if not conn.execute(
                "UPDATE agent_routine_runs SET status = ?, detail = ?, finished_at = ?"
                " WHERE id = ? AND status = 'running'", (status, detail, now, line["id"])).rowcount:
            return None
        routine = _one(conn, "SELECT * FROM agent_routines WHERE id = ?", (line["routine_id"],))
        if routine is None:
            return None
        failures = int(routine.get("consecutive_failures") or 0)
        if status in ("reported", "quiet"):
            failures = 0
        elif status == "failed":
            failures += 1
        sets: dict[str, Any] = {"last_run_at": now, "last_status": status,
                                "consecutive_failures": failures, "updated_at": now}
        paused = False
        if routine["enabled"]:
            if status == "failed" and failures >= self.routine_fail_pause:
                sets.update(enabled=0, paused_reason=PAUSE_REASON, next_run_at=None)
                paused = True
            elif json.loads(routine["schedule"])["kind"] == "once":
                sets.update(enabled=0, next_run_at=None)
        cols = ", ".join(f"{k} = ?" for k in sets)
        conn.execute(f"UPDATE agent_routines SET {cols} WHERE id = ?", (*sets.values(), routine["id"]))
        return {"routine_id": routine["id"], "title": routine["title"], "project_id": routine["project_id"],
                "paused": paused, "detail": detail}

    async def _after_settle(self, info: dict[str, Any] | None) -> None:
        """Publish what a closed line changed; on a pause, the one notice in the agent's conversation."""
        if info is None:
            return
        if info["paused"]:
            text = (f"A rotina «{info['title']}» foi pausada depois de {self.routine_fail_pause} falhas "
                    f"seguidas. {info['detail']}").strip()
            try:
                await self._store_message(info["project_id"], text, "system")  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - the notice never undoes the pause
                logger.exception("routine %s: could not post the pause notice", info["routine_id"])
        await self._routine_changed(info["routine_id"])

    def _failure_text(self, conn: Any, run: dict[str, Any]) -> str:
        row = conn.execute("SELECT payload FROM agent_run_events WHERE run_id = ? AND kind = 'error'"
                           " ORDER BY id DESC LIMIT 1", (run["id"],)).fetchone()
        message = ""
        if row:
            try:
                message = str(json.loads(row[0]).get("message") or "").strip()
            except (ValueError, AttributeError):
                message = ""
        code = str(run.get("error") or "")
        if message and message != code:
            return f"A execução falhou: {message}"[:400]
        return FAILURE_TEXTS.get(code) or (f"A execução falhou ({code})." if code else "A execução falhou.")

    async def _routine_run_finished(self, run_id: str) -> None:
        """A run that belongs to a routine reached a terminal state: close its ledger line."""
        raw = await self._raw_run(run_id)  # type: ignore[attr-defined]
        if raw is None or not raw.get("routine_id") or raw["status"] not in TERMINAL:
            return

        def _w(conn: Any) -> dict[str, Any] | None:
            line = _one(conn, "SELECT * FROM agent_routine_runs WHERE run_id = ? AND status = 'running'",
                        (run_id,))
            if line is None:
                return None
            if raw["status"] == "done":
                routine = _one(conn, "SELECT report FROM agent_routines WHERE id = ?", (line["routine_id"],))
                quiet = (routine is not None and routine["report"] == "news"
                         and routines.is_no_news(raw.get("result_summary")))
                return self._settle_line(conn, line, "quiet" if quiet else "reported", "")
            if raw["status"] == "failed":
                return self._settle_line(conn, line, "failed", self._failure_text(conn, raw))
            return self._settle_line(conn, line, "cancelled", "Você parou esta execução.")

        await self._after_settle(await self._db(_w))  # type: ignore[attr-defined]

    async def _routine_reconcile(self) -> None:
        """Close the ``running`` lines whose run is over (a restart, or a missed hook), and the ones that
        never got a run."""
        def _r(conn: Any) -> list[dict[str, Any]]:
            return _rows(
                conn, "SELECT l.*, r.status AS run_status FROM agent_routine_runs l"
                      " LEFT JOIN agent_runs r ON r.id = l.run_id WHERE l.status = 'running'")

        now = self.now()  # type: ignore[attr-defined]
        for line in await self._db(_r):  # type: ignore[attr-defined]
            try:
                if line["run_id"] and line["run_status"] in TERMINAL:
                    await self._routine_run_finished(line["run_id"])
                    continue
                if line["run_id"] and line["run_status"] is None:
                    detail = "A execução não foi encontrada."
                elif not line["run_id"] and (now - (_parse(line["created_at"]) or now)).total_seconds() > ORPHAN_LINE_S:
                    detail = "A execução não chegou a começar."
                else:
                    continue
                await self._after_settle(await self._db(  # type: ignore[attr-defined]
                    lambda c: self._settle_line(c, line, "failed", detail)))
            except Exception:  # noqa: BLE001
                logger.exception("routine line %s: could not be reconciled", line["id"])

    # ------------------------------------------------------------------
    # The clock
    # ------------------------------------------------------------------

    async def _routine_start(self) -> None:
        """Boot: settle what the last run of the backend left open, look at the clock once, start it."""
        await self._routine_reconcile()
        try:
            await self.tick()
        except Exception:  # noqa: BLE001
            logger.exception("routine clock: first look failed")
        if self._routine_task is None or self._routine_task.done():
            self._routine_task = asyncio.create_task(self._routine_loop())

    async def _routine_stop(self) -> None:
        if self._routine_task is not None:
            self._routine_task.cancel()
            await asyncio.gather(self._routine_task, return_exceptions=True)
            self._routine_task = None

    async def _routine_loop(self) -> None:
        while not self._stopping:  # type: ignore[attr-defined]
            await asyncio.sleep(self.routine_tick_s)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("routine clock failed")

    async def tick(self, now: datetime | None = None) -> int:
        """One look at the clock: every enabled routine whose time has come is fired. Returns how many.
        ``now`` (UTC) is for tests; the service clock (``self.now``) decides the rest."""
        if self._stopping:  # type: ignore[attr-defined]
            return 0
        now = now or self.now()  # type: ignore[attr-defined]
        await self._routine_reconcile()
        due = await self._db(lambda c: _rows(  # type: ignore[attr-defined]
            c, "SELECT * FROM agent_routines WHERE enabled = 1 AND next_run_at IS NOT NULL"
               " AND next_run_at <= ? ORDER BY next_run_at, rowid", (_iso(now),)))
        fired = 0
        for row in due:
            try:
                await self._fire(row, now)
                fired += 1
            except Exception:  # noqa: BLE001 - one routine never stops the next ones
                logger.exception("routine %s: could not be fired", row["id"])
        return fired

    def _missed_times(self, schedule: dict[str, Any], anchor_iso: str | None, due: datetime,
                      now: datetime) -> list[datetime]:
        """Every time of the schedule from ``due`` up to ``now`` (UTC, ascending), bounded: a long gap
        only walks its last ``MISSED_WALK_DAYS`` days."""
        local = self.local_time
        now_local, due_local = local.to_local(now), local.to_local(due)
        anchor = _parse(anchor_iso)
        anchor_local = local.to_local(anchor) if anchor else due_local
        times: list[datetime] = []
        floor = now_local - timedelta(days=MISSED_WALK_DAYS)
        if due_local >= floor:
            times.append(due_local)
            cursor = due_local
        else:
            times.append(due_local)  # the very first one stays: it is what the owner last expected
            cursor = floor
        while len(times) < MISSED_WALK_MAX:
            nxt = routines.next_occurrence(schedule, cursor, anchor_local)
            if nxt is None or nxt > now_local:
                break
            times.append(nxt)
            cursor = nxt
        return [local.to_utc(t) for t in times]

    async def _fire(self, row: dict[str, Any], now: datetime) -> None:
        """A routine is due: record skipped / missed / start a run, and move ``next_run_at`` on."""
        async with self._routine_lock:
            fresh = await self._db(lambda c: _one(  # type: ignore[attr-defined]
                c, "SELECT * FROM agent_routines WHERE id = ? AND enabled = 1 AND next_run_at = ?",
                (row["id"], row["next_run_at"])))
            if fresh is None:
                return
            schedule = json.loads(fresh["schedule"])
            due = _parse(fresh["next_run_at"])
            assert due is not None
            times = self._missed_times(schedule, fresh.get("anchor_at"), due, now)
            new_next = self._next_iso(schedule, fresh.get("anchor_at"), now)
            old = [t for t in times if (now - t).total_seconds() > self.routine_catchup_s]
            recent = [t for t in times if (now - t).total_seconds() <= self.routine_catchup_s]
            span = _span_text(self.routine_catchup_s)
            # A paused or archived agent does not work: its times are recorded as skipped, which is not a failure.
            owner = await self.get_def(fresh["agent_id"])  # type: ignore[attr-defined]
            idle = (None if owner is None else ARCHIVED_TEXT if owner["archived"]
                    else PAUSED_TEXT if not owner["enabled"] else None)
            started: list[Any] = []  # [line id, scheduled_for, trigger]
            once = schedule["kind"] == "once"

            def _w(conn: Any) -> None:
                stamp = _iso(now)
                kept = ([due] if due in old else []) + old[-MISSED_LINES_MAX:]
                for t in dict.fromkeys(kept):
                    conn.execute(
                        "INSERT OR IGNORE INTO agent_routine_runs (id, routine_id, scheduled_for, fired_by,"
                        " status, detail, finished_at, created_at) VALUES (?, ?, ?, 'schedule', 'missed',"
                        " ?, ?, ?)",
                        (str(uuid.uuid4()), fresh["id"], _iso(t),
                         f"Horário perdido: a Seraphine não estava rodando e ele passou há mais de {span}.",
                         stamp, stamp))
                next_run = new_next
                if recent:
                    latest = recent[-1]
                    when = _iso(latest)
                    busy = conn.execute(
                        "SELECT 1 FROM agent_routine_runs WHERE routine_id = ? AND status = 'running' LIMIT 1",
                        (fresh["id"],)).fetchone()
                    if busy or idle:
                        conn.execute(
                            "INSERT OR IGNORE INTO agent_routine_runs (id, routine_id, scheduled_for,"
                            " fired_by, status, detail, finished_at, created_at)"
                            " VALUES (?, ?, ?, 'schedule', 'skipped', ?, ?, ?)",
                            (str(uuid.uuid4()), fresh["id"], when,
                             "Pulada: a execução anterior ainda estava rodando." if busy else idle, stamp, stamp))
                        if once and busy:  # a one-shot that could not start keeps its time: it tries again
                            next_run = fresh["next_run_at"]
                        elif once:  # its only time passed while the agent was away: it switches itself off
                            conn.execute("UPDATE agent_routines SET enabled = 0, last_status = 'skipped'"
                                         " WHERE id = ?", (fresh["id"],))
                            next_run = None
                    else:
                        trigger = "catchup" if (now - latest).total_seconds() > CATCHUP_AFTER_S else "schedule"
                        line_id = str(uuid.uuid4())
                        if conn.execute(
                                "INSERT OR IGNORE INTO agent_routine_runs (id, routine_id, scheduled_for,"
                                " fired_by, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)",
                                (line_id, fresh["id"], when, trigger, stamp)).rowcount:
                            started.extend([line_id, when, trigger])
                elif once:  # only missed times: a one-shot that cannot run any more switches itself off
                    conn.execute("UPDATE agent_routines SET enabled = 0, last_status = 'missed' WHERE id = ?",
                                 (fresh["id"],))
                    next_run = None
                conn.execute("UPDATE agent_routines SET next_run_at = ?, updated_at = ? WHERE id = ?",
                             (next_run, stamp, fresh["id"]))

            await self._db(_w)  # type: ignore[attr-defined]
            if started:
                await self._start_line(fresh, started[0], started[1], started[2])
            await self._routine_changed(fresh["id"])

    async def _start_line(self, routine: dict[str, Any], line_id: str, scheduled_for: str, trigger: str,
                          *, manual: bool = False) -> dict[str, Any] | None:
        """Start the agent's run for a ledger line that was just opened. A failure to start closes the line
        as ``failed`` (a manual run drops the line and raises instead: the owner is there to be told)."""
        agent = await self.get_def(routine["agent_id"])  # type: ignore[attr-defined]
        detail = ""
        if agent is None:
            detail = "O agente não existe mais."
        elif not manual and (agent["archived"] or not agent["enabled"]):
            # The agent was paused or archived after the clock looked: skipped, never a failure.
            line = {"id": line_id, "routine_id": routine["id"]}
            await self._after_settle(await self._db(  # type: ignore[attr-defined]
                lambda c: self._settle_line(c, line, "skipped", ARCHIVED_TEXT if agent["archived"] else PAUSED_TEXT)))
            return None
        if not detail:
            try:
                return await self.start_run(  # type: ignore[attr-defined]
                    routine["agent_id"], routine["project_id"], routine["prompt"], requested_by="routine",
                    routine=routine, routine_line=line_id)
            except HarnessError as exc:
                if manual:
                    await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
                        "DELETE FROM agent_routine_runs WHERE id = ?", (line_id,)))
                    raise
                detail = str(exc)
            except Exception:  # noqa: BLE001
                logger.exception("routine %s: could not start its run", routine["id"])
                if manual:
                    await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
                        "DELETE FROM agent_routine_runs WHERE id = ?", (line_id,)))
                    raise
                detail = "Não foi possível iniciar a execução."
        if manual:  # no agent at all
            await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
                "DELETE FROM agent_routine_runs WHERE id = ?", (line_id,)))
            raise NotFound("agente não encontrado")
        line = {"id": line_id, "routine_id": routine["id"]}
        await self._after_settle(await self._db(  # type: ignore[attr-defined]
            lambda c: self._settle_line(c, line, "failed", detail)))
        return None

    async def run_routine_now(self, routine_id: str) -> dict[str, Any]:
        """"Rodar agora": one run, even when the routine is off. It does not move ``next_run_at``."""
        await self._require_routine(routine_id)
        async with self._routine_lock:
            row = await self._db(lambda c: _one(  # type: ignore[attr-defined]
                c, "SELECT * FROM agent_routines WHERE id = ?", (routine_id,)))
            if row is None:
                raise NotFound("rotina não encontrada")
            owner = await self.get_def(row["agent_id"])  # type: ignore[attr-defined]
            if owner is not None and owner["archived"]:
                raise Conflict(AGENT_ARCHIVED_TEXT, code="agent_archived")
            now = self.now()  # type: ignore[attr-defined]
            line_id = str(uuid.uuid4())

            def _w(conn: Any) -> bool:
                if conn.execute("SELECT 1 FROM agent_routine_runs WHERE routine_id = ? AND status = 'running'"
                                " LIMIT 1", (routine_id,)).fetchone():
                    return False
                conn.execute(
                    "INSERT INTO agent_routine_runs (id, routine_id, scheduled_for, fired_by, status, created_at)"
                    " VALUES (?, ?, ?, 'manual', 'running', ?)", (line_id, routine_id, _iso(now), _iso(now)))
                return True

            if not await self._db(_w):  # type: ignore[attr-defined]
                raise Conflict("Esta rotina já está rodando. Espere ela terminar.", code="routine_running")
            routine = {**row, "schedule": json.loads(row["schedule"])}
            run = await self._start_line(routine, line_id, _iso(now), "manual", manual=True)
        return {"routine": await self._routine_changed(routine_id), "run": run}

    # ------------------------------------------------------------------
    # What a routine run is told and how it ends
    # ------------------------------------------------------------------

    async def _routine_preface(self, run: dict[str, Any]) -> str:
        """The routine preamble of a run's first prompt ('' for a run that is not a routine's)."""
        routine_id = run.get("routine_id")
        if not routine_id:
            return ""
        row = await self._db(lambda c: _one(  # type: ignore[attr-defined]
            c, "SELECT title, report FROM agent_routines WHERE id = ?", (routine_id,)))
        title = (row or {}).get("title") or run.get("routine_title") or ""
        return routine_preface(title, row["report"] if row else None)

    async def _routine_is_quiet(self, run: dict[str, Any], summary: str) -> bool:
        """Is this run's final answer the "nothing new" one of a routine that reports only news? Then the
        message is not published."""
        routine_id = run.get("routine_id")
        if not routine_id or not routines.is_no_news(summary):
            return False
        row = await self._db(lambda c: _one(  # type: ignore[attr-defined]
            c, "SELECT report FROM agent_routines WHERE id = ?", (routine_id,)))
        return row is not None and row["report"] == "news"
