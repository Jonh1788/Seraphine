"""The agent page, pausing and archiving, the usage report and the undo of a team (phase 6c, part 2).

``AgentPageMixin`` is part of ``AgentHarnessService`` (kept in its own file because the service is large).
Nothing here widens a permission: archiving, restoring, the checklist and the undo never touch the grants,
the engine or the command permission. The only things stored are the owner's "not now" answers (key-value
store, ``agents.checklist.<id>``) and the batches of a team creation (``agent_team_batches``).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, time as dtime, timedelta
from typing import Any

from seraphine.agents import catalog
from seraphine.agents.errors import Conflict, Invalid, NotFound
from seraphine.agents.providers import ProviderRegistry, canon_engine
from seraphine.agents.routine_service import AGENT_ARCHIVED_TEXT, _iso, _one, _parse, _rows

CHECKLIST_PREFIX = "agents.checklist."
CHECKLIST_FLAGS = ("access_ok", "routine_skipped", "dismissed")
#: Every flag kept under the key; ``access_changed`` is set by the grants route, never by the owner's PUT.
_STORED_FLAGS = (*CHECKLIST_FLAGS, "access_changed")
USAGE_DAYS = (7, 30, 90)
USAGE_DEFAULT_DAYS = 30
_ACTIVE_SQL = "('queued','running','waiting_approval','parked')"
ENGINE_LABELS = {"claude_code": "Plano do Claude (Claude Code)", "codex": "Plano do ChatGPT (Codex)"}
BATCH_UNDONE_TEXT = "Esta criação de time já foi desfeita."
BATCH_EXPIRED_TEXT = "O prazo para desfazer esta criação de time passou."
KEPT_BUSY_TEXT = "Está trabalhando agora, então ficou como está."


def checklist_key(agent_id: str) -> str:
    return f"{CHECKLIST_PREFIX}{agent_id}"


class AgentPageMixin:
    """Methods of ``AgentHarnessService`` for archiving, the agent page, usage and team batches. Expects ``_db``,
    ``store``, ``now``, ``local_time``, ``engines``, ``providers``, ``_ready``, ``get_def``/``_require_def``,
    ``_home_row``, ``delete_def`` and ``gateway`` from the service."""

    def _init_agent_page(self, settings: Any) -> None:
        self.team_undo_s = max(0, int(getattr(settings, "agents_team_undo_s", 86400)))
        self._checklist_lock = asyncio.Lock()
        self._batch_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Pause is ``enabled = false`` (the ordinary PATCH); archiving is here
    # ------------------------------------------------------------------

    async def archive_def(self, agent_id: str) -> dict[str, Any]:
        """The agent leaves the lists and gets nothing; its home is archived with it. Everything stays.
        Calling it again changes nothing. ``agent_busy`` while a run is in progress."""
        await self._require_def(agent_id)  # type: ignore[attr-defined]
        stamp = _iso(self.now())  # type: ignore[attr-defined]

        def _w(conn: Any) -> str:
            row = _one(conn, "SELECT archived FROM agent_defs WHERE id = ?", (agent_id,))
            if row is None:
                return "gone"
            if row["archived"]:
                return "same"
            if conn.execute(f"SELECT 1 FROM agent_runs WHERE agent_id = ? AND status IN {_ACTIVE_SQL} LIMIT 1",
                            (agent_id,)).fetchone():
                return "busy"
            conn.execute("UPDATE agent_defs SET archived = 1, archived_at = ? WHERE id = ?", (stamp, agent_id))
            conn.execute("UPDATE agent_projects SET archived = 1 WHERE kind = 'home' AND agent_id = ?",
                         (agent_id,))
            return "ok"

        verdict = await self._db(_w)  # type: ignore[attr-defined]
        if verdict == "gone":
            raise NotFound("agente não encontrado")
        if verdict == "busy":
            raise Conflict("O agente está trabalhando agora. Espere ele terminar, ou pare a execução, "
                           "antes de arquivar.", code="agent_busy")
        return await self._require_def(agent_id)  # type: ignore[attr-defined,return-value]

    async def unarchive_def(self, agent_id: str) -> dict[str, Any]:
        """The agent and its home come back as they were (routines keep being on or paused as they were)."""
        await self._require_def(agent_id)  # type: ignore[attr-defined]

        def _w(conn: Any) -> None:
            conn.execute("UPDATE agent_defs SET archived = 0, archived_at = NULL WHERE id = ?", (agent_id,))
            conn.execute("UPDATE agent_projects SET archived = 0 WHERE kind = 'home' AND agent_id = ?",
                         (agent_id,))

        await self._db(_w)  # type: ignore[attr-defined]
        return await self._require_def(agent_id)  # type: ignore[attr-defined,return-value]

    # ------------------------------------------------------------------
    # The page
    # ------------------------------------------------------------------

    async def _stored_checklist(self, agent_id: str) -> dict[str, bool]:
        raw = await self.store.get_kv(checklist_key(agent_id))  # type: ignore[attr-defined]
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        return {k: data.get(k) is True for k in _STORED_FLAGS}

    async def _merge_checklist(self, agent_id: str, **flags: bool) -> None:
        async with self._checklist_lock:
            stored = await self._stored_checklist(agent_id)
            stored.update(flags)
            await self.store.set_kv(checklist_key(agent_id), json.dumps(stored))  # type: ignore[attr-defined]

    async def _note_access_changed(self, agent_id: str) -> None:
        """The owner set the access with their own hand: that counts as having looked at it."""
        await self._merge_checklist(agent_id, access_changed=True)

    async def _page_engine(self, agent: dict[str, Any]) -> dict[str, Any]:
        """``{ready, label, how}`` of the agent's engine: ready when the engine, or its fallback, can work now."""
        engine = canon_engine(agent["engine"]) or ""
        provider_id = agent.get("provider")
        ok, reason = await self._ready(engine, provider_id)  # type: ignore[attr-defined]
        fallback = canon_engine(agent.get("fallback_engine"))
        if not ok and fallback and fallback in self.engines:  # type: ignore[attr-defined]
            fb_provider = agent.get("fallback_provider") or self.providers.default_for(fallback)  # type: ignore[attr-defined]
            ok = (await self._ready(fallback, fb_provider))[0]  # type: ignore[attr-defined]
        entry = self.providers.get(provider_id)  # type: ignore[attr-defined]
        if engine in ENGINE_LABELS:
            label = ENGINE_LABELS[engine]
        elif entry is not None:
            label = f"{entry.label.split(' (')[0]} (só conversa)"
        else:
            label = "Só conversa" if engine == "chat" else engine
        how = ""
        if not ok:
            how = (ProviderRegistry.how_to_ready(entry, False, reason) if entry is not None
                   else "Conecte um motor nos ajustes dos agentes.")
        return {"ready": bool(ok), "label": label, "how": how}

    def _checklist_view(self, stored: dict[str, bool], *, engine_ready: bool, has_done_run: bool,
                        routines_total: int) -> dict[str, Any]:
        items = [
            {"id": "engine", "done": engine_ready, "optional": False},
            {"id": "first_talk", "done": has_done_run, "optional": False},
            {"id": "access", "done": stored["access_ok"] or stored["access_changed"], "optional": False},
            {"id": "routine", "done": routines_total > 0 or stored["routine_skipped"], "optional": True},
        ]
        return {"items": items, "done": sum(1 for i in items if i["done"]), "total": len(items),
                "dismissed": stored["dismissed"]}

    async def _agent_facts(self, agent_id: str) -> dict[str, Any]:
        """Counts read from the real data: routines, runs, tokens."""
        def _r(conn: Any) -> dict[str, Any]:
            routines = _rows(conn, "SELECT enabled, next_run_at FROM agent_routines WHERE agent_id = ?",
                             (agent_id,))
            nxt = [r["next_run_at"] for r in routines if r["enabled"] and r["next_run_at"]]
            run = conn.execute(
                "SELECT COUNT(*), MAX(created_at), COALESCE(SUM(tokens_in), 0), COALESCE(SUM(tokens_out), 0),"
                " COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0)"
                " FROM agent_runs WHERE agent_id = ?", (agent_id,)).fetchone()
            return {"routines_total": len(routines), "routines_active": sum(1 for r in routines if r["enabled"]),
                    "next_run_at": min(nxt) if nxt else None, "runs": int(run[0]), "last_run_at": run[1],
                    "tokens_in": int(run[2]), "tokens_out": int(run[3]), "done_runs": int(run[4])}

        return await self._db(_r)  # type: ignore[attr-defined]

    async def agent_page(self, agent_id: str) -> dict[str, Any]:
        """Everything the "Sobre" tab shows, computed now."""
        agent = await self._require_def(agent_id)  # type: ignore[attr-defined]
        home = await self.get_project(agent["home_project_id"]) if agent.get("home_project_id") else None  # type: ignore[attr-defined]
        engine = await self._page_engine(agent)
        facts = await self._agent_facts(agent_id)
        stored = await self._stored_checklist(agent_id)
        return {
            "def": agent,
            "home": home,
            "engine": engine,
            "access": [{"group": g.id, "label": g.label, "level": agent["grants"].get(g.id, g.default)}
                       for g in catalog.GRANT_GROUPS],
            "routines": {"total": facts["routines_total"], "active": facts["routines_active"],
                         "next_run_at": facts["next_run_at"]},
            "activity": {"runs": facts["runs"], "last_run_at": facts["last_run_at"],
                         "tokens_in": facts["tokens_in"], "tokens_out": facts["tokens_out"]},
            "checklist": self._checklist_view(stored, engine_ready=engine["ready"],
                                              has_done_run=facts["done_runs"] > 0,
                                              routines_total=facts["routines_total"]),
        }

    async def update_checklist(self, agent_id: str, **fields: Any) -> dict[str, Any]:
        """The owner's answers: ``access_ok`` ("Está bom assim"), ``routine_skipped`` ("Agora não") and
        ``dismissed`` (hide the card). Returns the checklist as the page shows it."""
        agent = await self._require_def(agent_id)  # type: ignore[attr-defined]
        for key, value in fields.items():
            if key not in CHECKLIST_FLAGS:
                raise Invalid(f"campo desconhecido: {key}")
            if not isinstance(value, bool):
                raise Invalid(f"«{key}» precisa ser verdadeiro ou falso.")
        if fields:
            await self._merge_checklist(agent_id, **fields)
        engine = await self._page_engine(agent)
        facts = await self._agent_facts(agent_id)
        return self._checklist_view(await self._stored_checklist(agent_id), engine_ready=engine["ready"],
                                    has_done_run=facts["done_runs"] > 0, routines_total=facts["routines_total"])

    # ------------------------------------------------------------------
    # Usage
    # ------------------------------------------------------------------

    async def usage(self, days: Any = USAGE_DEFAULT_DAYS) -> dict[str, Any]:
        """What was measured in the last ``days`` LOCAL days (today included): runs, tokens, and the cost
        only where an engine reported one. Nothing is estimated."""
        if isinstance(days, bool) or not isinstance(days, int) or days not in USAGE_DAYS:
            raise Invalid("O período precisa ser de 7, 30 ou 90 dias.")
        local = self.local_time  # type: ignore[attr-defined]
        today = local.to_local(self.now()).date()  # type: ignore[attr-defined]
        first = today - timedelta(days=days - 1)
        # Fetched a day early and cut by parsed local day below, so the text order of the stamps never decides.
        start = _iso(local.to_utc(datetime.combine(first, dtime.min)) - timedelta(days=1))

        def _r(conn: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
            agents = _rows(conn, "SELECT id, name, archived FROM agent_defs ORDER BY created_at, rowid")
            runs = _rows(conn, "SELECT r.agent_id, r.requested_by, r.tokens_in, r.tokens_out, r.cost_usd,"
                               " r.created_at FROM agent_runs r JOIN agent_defs d ON d.id = r.agent_id"
                               " WHERE r.created_at >= ? ORDER BY r.created_at", (start,))
            return agents, runs

        agents, runs = await self._db(_r)  # type: ignore[attr-defined]
        per: dict[str, dict[str, Any]] = {
            a["id"]: {"agent_id": a["id"], "name": a["name"], "archived": bool(a["archived"]), "runs": 0,
                      "routine_runs": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "cost_known": False,
                      "last_run_at": None} for a in agents}
        by_day = {(first + timedelta(days=i)).isoformat(): {"date": (first + timedelta(days=i)).isoformat(),
                                                             "runs": 0, "tokens_in": 0, "tokens_out": 0,
                                                             "cost_usd": 0.0} for i in range(days)}
        totals = {"runs": 0, "routine_runs": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}
        for run in runs:
            moment = _parse(run["created_at"])
            day = by_day.get(local.to_local(moment).date().isoformat()) if moment else None
            if day is None:  # not inside the window of local days (a clock set back, say)
                continue
            tin, tout = int(run["tokens_in"] or 0), int(run["tokens_out"] or 0)
            cost = float(run["cost_usd"] or 0.0)
            row = per[run["agent_id"]]
            routine = run["requested_by"] == "routine"
            for bucket in (row, totals):
                bucket["runs"] += 1
                bucket["routine_runs"] += 1 if routine else 0
                bucket["tokens_in"] += tin
                bucket["tokens_out"] += tout
                bucket["cost_usd"] += cost
            row["cost_known"] = row["cost_known"] or cost > 0
            if row["last_run_at"] is None or run["created_at"] > row["last_run_at"]:
                row["last_run_at"] = run["created_at"]
            day["runs"] += 1
            day["tokens_in"] += tin
            day["tokens_out"] += tout
            day["cost_usd"] += cost
        for bucket in (totals, *per.values(), *by_day.values()):
            bucket["cost_usd"] = round(bucket["cost_usd"], 6)
        rows = sorted(per.values(), key=lambda a: -a["runs"])  # stable: creation order among equals
        return {"days": days, "totals": totals, "agents": rows, "by_day": list(by_day.values())}

    # ------------------------------------------------------------------
    # Undo of a team
    # ------------------------------------------------------------------

    async def _record_batch(self, origin: str, created: list[dict[str, Any]]) -> dict[str, Any] | None:
        """Remember the agents a team creation made. ``None`` when nothing was created."""
        if not created:
            return None
        now = self.now()  # type: ignore[attr-defined]
        batch_id = str(uuid.uuid4())
        until = _iso(now + timedelta(seconds=self.team_undo_s))
        agents = [{"agent_id": item["def"]["id"], "name": item["def"]["name"]} for item in created]
        await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
            "INSERT INTO agent_team_batches (id, origin, agents, created_at, undo_until) VALUES (?, ?, ?, ?, ?)",
            (batch_id, origin, json.dumps(agents, ensure_ascii=False), _iso(now), until)))
        return {"id": batch_id, "undo_until": until}

    async def _batch_row(self, batch_id: str) -> dict[str, Any]:
        row = await self._db(lambda c: _one(  # type: ignore[attr-defined]
            c, "SELECT * FROM agent_team_batches WHERE id = ?", (batch_id,)))
        if row is None:
            raise NotFound("criação de time não encontrada")
        return row

    async def get_batch(self, batch_id: str) -> dict[str, Any]:
        row = await self._batch_row(batch_id)
        agents = json.loads(row["agents"])
        ids = [a["agent_id"] for a in agents]
        marks = ",".join("?" for _ in ids)
        alive = {r[0] for r in await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
            f"SELECT id FROM agent_defs WHERE id IN ({marks})", tuple(ids)).fetchall())} if ids else set()
        until = _parse(row["undo_until"])
        can_undo = row["undone_at"] is None and until is not None and self.now() < until  # type: ignore[attr-defined]
        return {"batch": {"id": row["id"], "undo_until": row["undo_until"], "undone_at": row["undone_at"],
                          "can_undo": can_undo,
                          "agents": [{"agent_id": a["agent_id"], "name": a["name"], "exists": a["agent_id"] in alive}
                                     for a in agents]}}

    async def undo_batch(self, batch_id: str) -> dict[str, Any]:
        """Remove what a team creation made, but only what was not used: an agent that never ran is deleted
        (through the ordinary delete: routines, history and checklist go, the home is archived and the folder
        stays), one that already ran is archived, one with a run in progress is left as it is."""
        async with self._batch_lock:
            row = await self._batch_row(batch_id)
            if row["undone_at"]:
                raise Conflict(BATCH_UNDONE_TEXT, code="already_undone")
            until = _parse(row["undo_until"])
            if until is None or self.now() >= until:  # type: ignore[attr-defined]
                raise Conflict(BATCH_EXPIRED_TEXT, code="undo_expired")
            out: dict[str, list[dict[str, Any]]] = {"removed": [], "archived": [], "kept": []}
            for item in json.loads(row["agents"]):
                agent_id = item["agent_id"]
                agent = await self.get_def(agent_id)  # type: ignore[attr-defined]
                if agent is None:  # already gone: nothing to undo
                    continue
                ref = {"agent_id": agent_id, "name": agent["name"]}
                counts = await self._db(lambda c, a=agent_id: c.execute(  # type: ignore[attr-defined]
                    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN status IN " + _ACTIVE_SQL + " THEN 1 ELSE 0 END), 0)"
                    " FROM agent_runs WHERE agent_id = ?", (a,)).fetchone())
                if counts[1]:
                    out["kept"].append({**ref, "detail": KEPT_BUSY_TEXT})
                    continue
                try:
                    if counts[0]:
                        await self.archive_def(agent_id)
                        out["archived"].append(ref)
                    else:
                        await self.delete_def(agent_id)  # type: ignore[attr-defined]
                        out["removed"].append(ref)
                except Conflict:  # a run started between the look and the change
                    out["kept"].append({**ref, "detail": KEPT_BUSY_TEXT})
            await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
                "UPDATE agent_team_batches SET undone_at = ? WHERE id = ?", (_iso(self.now()), batch_id)))
            return out
