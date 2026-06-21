"""RoutineService -- CRUD + seeding for prompt-launcher routines.

Single-tenant: no user_id scoping. Routines are NOT materialized into tasks;
each carries a prompt that the frontend launches into the chat composer. The
code-owned catalog is seeded once (idempotently) so the table is real data on
first boot while still being editable/toggleable and extensible by the user.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from core_db import Store

from seraphine.recurring.models import Routine

logger = logging.getLogger(__name__)


_SELECT_COLS = (
    "id, name, detail, kind, trigger, enabled, prompt, icon, icon_bg,"
    " icon_color, job_name, builtin, sort_order, created_at, updated_at"
)

_VALID_KINDS = ("scheduled", "manual")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_routine(row: tuple[Any, ...]) -> Routine:
    return Routine(
        id=row[0],
        name=row[1],
        detail=row[2] or "",
        kind=row[3],
        trigger=row[4],
        enabled=bool(row[5]),
        prompt=row[6] or "",
        icon=row[7],
        icon_bg=row[8],
        icon_color=row[9],
        job_name=row[10],
        builtin=bool(row[11]),
        sort_order=row[12] if row[12] is not None else 0,
        created_at=row[13],
        updated_at=row[14],
    )


# Code-owned catalog. Seeded once (idempotently keyed by the stable string id)
# so existing prompts stay real data while the table also accepts user-created
# routines. Mirrors frontend/src/routines/catalog.ts; ids are stable slugs.
_DEFAULT_ROUTINES: list[dict[str, Any]] = [
    {
        "id": "morning",
        "name": "Comecar o dia",
        "detail": "Agenda, tarefas, saude, clima e uma ordem clara de prioridade.",
        "kind": "scheduled",
        "trigger": "08:00 · todo dia",
        "enabled": True,
        "icon": "coffee",
        "icon_bg": "rgba(255, 167, 38, 0.14)",
        "icon_color": "#ffa726",
        "job_name": None,
        "prompt": (
            "Faz meu briefing da manha: agenda de hoje, tarefas importantes,"
            " pendencias, saude/sono se tiver dados, clima e as 3 prioridades"
            " do dia."
        ),
    },
    {
        "id": "shutdown",
        "name": "Encerrar o dia",
        "detail": "Fecha loops, captura aprendizados e prepara amanha.",
        "kind": "scheduled",
        "trigger": "22:00 · todo dia",
        "enabled": True,
        "icon": "moon",
        "icon_bg": "rgba(129, 140, 248, 0.14)",
        "icon_color": "#818cf8",
        "job_name": "day_review",
        "prompt": (
            "Vamos encerrar o dia: revisa o que ficou aberto, registra"
            " aprendizados importantes na memoria, sugere o que arquivar e"
            " prepara um plano simples para amanha."
        ),
    },
    {
        "id": "weekly",
        "name": "Revisao semanal",
        "detail": "Resumo de tarefas, habitos, financas, saude, decisoes e open loops.",
        "kind": "scheduled",
        "trigger": "Dom · 18:00",
        "enabled": False,
        "icon": "check-circle",
        "icon_bg": "rgba(66, 165, 245, 0.14)",
        "icon_color": "#42a5f5",
        "job_name": "weekly_reflection",
        "prompt": (
            "Faz minha revisao semanal completa: tarefas criadas e concluidas,"
            " habitos, financas, saude, decisoes, open loops e sugestoes"
            " praticas para a proxima semana."
        ),
    },
    {
        "id": "focus",
        "name": "Foco profundo",
        "detail": "Escolhe uma tarefa, reduz ruido e sugere um bloco de trabalho.",
        "kind": "manual",
        "trigger": None,
        "enabled": True,
        "icon": "target",
        "icon_bg": "var(--accent-soft)",
        "icon_color": "var(--accent)",
        "job_name": None,
        "prompt": (
            "Quero entrar em foco profundo. Escolhe a tarefa mais importante"
            " agora, define um bloco de foco, remove distracoes e me diz"
            " exatamente por onde comecar."
        ),
    },
    {
        "id": "meeting",
        "name": "Preparar reuniao",
        "detail": "Busca proximos eventos e monta contexto, notas ligadas e perguntas.",
        "kind": "manual",
        "trigger": None,
        "enabled": True,
        "icon": "calendar",
        "icon_bg": "rgba(74, 222, 128, 0.14)",
        "icon_color": "#4ade80",
        "job_name": None,
        "prompt": (
            "Prepara minha proxima reuniao: olha agenda, notas e open loops"
            " relacionados. Me da contexto, riscos, perguntas e proximas acoes."
        ),
    },
    {
        "id": "project-plan",
        "name": "Planejar projeto",
        "detail": "Transforma uma ideia em escopo, riscos, marcos e proximas acoes.",
        "kind": "manual",
        "trigger": None,
        "enabled": True,
        "icon": "target",
        "icon_bg": "var(--accent-soft)",
        "icon_color": "var(--accent)",
        "job_name": None,
        "prompt": (
            "Vamos planejar um projeto de trabalho. Use list_work_projects; se"
            " nao existir o projeto certo, use create_work_project. Depois crie"
            " as primeiras tarefas com add_task e vincule ao projeto com"
            " link_work_project_item."
        ),
    },
    {
        "id": "project-review",
        "name": "Revisar sprint",
        "detail": "Repassa projetos ativos, tarefas abertas, bloqueios e entregas.",
        "kind": "manual",
        "trigger": None,
        "enabled": True,
        "icon": "check-circle",
        "icon_bg": "rgba(66, 165, 245, 0.14)",
        "icon_color": "#42a5f5",
        "job_name": None,
        "prompt": (
            "Faz uma revisao de sprint dos meus trabalhos. Use"
            " list_work_projects e o briefing/autopilot de trabalho se"
            " disponivel. Liste bloqueios, decisoes pendentes e crie ou"
            " atualize tarefas reais quando eu aprovar."
        ),
    },
    {
        "id": "project-close",
        "name": "Fechar entrega",
        "detail": "Confere pendencias, evidencias, comunicacao e aprendizado.",
        "kind": "manual",
        "trigger": None,
        "enabled": True,
        "icon": "moon",
        "icon_bg": "rgba(129, 140, 248, 0.14)",
        "icon_color": "#818cf8",
        "job_name": None,
        "prompt": (
            "Me ajuda a fechar uma entrega de trabalho. Encontre o projeto com"
            " list_work_projects, confira pendencias vinculadas, gere checklist"
            " final, registre uma nota de aprendizado se fizer sentido e"
            " proponha marcar o projeto como done."
        ),
    },
    {
        "id": "project-meeting",
        "name": "Reuniao de projeto",
        "detail": "Prepara contexto, status, riscos e perguntas para alinhamento.",
        "kind": "manual",
        "trigger": None,
        "enabled": True,
        "icon": "calendar",
        "icon_bg": "rgba(74, 222, 128, 0.14)",
        "icon_color": "#4ade80",
        "job_name": None,
        "prompt": (
            "Prepara uma reuniao de projeto. Use list_work_projects para"
            " identificar o contexto, traga status, tarefas abertas, decisoes,"
            " riscos, perguntas e proximas acoes; crie tarefas de follow-up se"
            " eu confirmar."
        ),
    },
]


class RoutineService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Seeding
    # ------------------------------------------------------------------

    async def seed_defaults(self) -> int:
        """Insert any code-owned catalog routine not already present (keyed by
        its stable string id). Idempotent: re-running never duplicates and
        never overwrites a user's edits to an already-seeded routine.

        Returns the number of routines inserted this run.
        """

        def _work() -> int:
            inserted = 0
            ts = _now_iso()
            with self._store._connect() as conn:
                existing = {
                    row[0]
                    for row in conn.execute("SELECT id FROM routines").fetchall()
                }
                for order, spec in enumerate(_DEFAULT_ROUTINES):
                    if spec["id"] in existing:
                        continue
                    conn.execute(
                        "INSERT INTO routines"
                        " (id, name, detail, kind, trigger, enabled, prompt,"
                        "  icon, icon_bg, icon_color, job_name, builtin,"
                        "  sort_order, created_at, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                        (
                            spec["id"],
                            spec["name"],
                            spec["detail"],
                            spec["kind"],
                            spec["trigger"],
                            1 if spec["enabled"] else 0,
                            spec["prompt"],
                            spec["icon"],
                            spec["icon_bg"],
                            spec["icon_color"],
                            spec["job_name"],
                            order,
                            ts,
                            ts,
                        ),
                    )
                    inserted += 1
            return inserted

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def list_all(self) -> list[Routine]:
        def _work() -> list[Routine]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM routines"
                    " ORDER BY builtin DESC, sort_order ASC, created_at ASC",
                ).fetchall()
            return [_row_to_routine(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get(self, routine_id: str) -> Routine | None:
        def _work() -> Routine | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM routines WHERE id = ?",
                    (routine_id,),
                ).fetchone()
            return _row_to_routine(row) if row else None

        return await asyncio.to_thread(_work)

    async def create(
        self,
        *,
        name: str,
        prompt: str,
        detail: str = "",
        kind: str = "manual",
        trigger: str | None = None,
        enabled: bool = True,
        icon: str | None = None,
        icon_bg: str | None = None,
        icon_color: str | None = None,
        job_name: str | None = None,
    ) -> Routine:
        name = name.strip()
        if not name:
            raise ValueError("name is required")
        if kind not in _VALID_KINDS:
            raise ValueError(f"invalid kind: {kind!r}")

        rid = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> Routine:
            with self._store._connect() as conn:
                # New user routines sort after the seeded catalog.
                max_order = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) FROM routines",
                ).fetchone()[0]
                conn.execute(
                    "INSERT INTO routines"
                    " (id, name, detail, kind, trigger, enabled, prompt,"
                    "  icon, icon_bg, icon_color, job_name, builtin,"
                    "  sort_order, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
                    (
                        rid,
                        name,
                        (detail or "").strip(),
                        kind,
                        trigger,
                        1 if enabled else 0,
                        (prompt or "").strip(),
                        icon,
                        icon_bg,
                        icon_color,
                        job_name,
                        int(max_order) + 1,
                        ts,
                        ts,
                    ),
                )
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM routines WHERE id = ?",
                    (rid,),
                ).fetchone()
            return _row_to_routine(row)

        return await asyncio.to_thread(_work)

    async def update(
        self,
        routine_id: str,
        *,
        enabled: bool | None = None,
        name: str | None = None,
        detail: str | None = None,
        trigger: str | None = None,
        prompt: str | None = None,
        kind: str | None = None,
        _trigger_provided: bool = False,
    ) -> Routine | None:
        """Patch-style update. Fields not mentioned stay untouched."""
        sets: list[str] = []
        params: list[Any] = []
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        if name is not None:
            sets.append("name = ?")
            params.append(name.strip())
        if detail is not None:
            sets.append("detail = ?")
            params.append(detail.strip())
        if _trigger_provided:
            sets.append("trigger = ?")
            params.append(trigger)
        if prompt is not None:
            sets.append("prompt = ?")
            params.append(prompt.strip())
        if kind is not None:
            if kind not in _VALID_KINDS:
                raise ValueError(f"invalid kind: {kind!r}")
            sets.append("kind = ?")
            params.append(kind)

        if not sets:
            return await self.get(routine_id)

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.append(routine_id)

        def _work() -> Routine | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE routines SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM routines WHERE id = ?",
                    (routine_id,),
                ).fetchone()
            return _row_to_routine(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, routine_id: str) -> int:
        """Delete a routine. Builtin (code-owned) routines are protected."""

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM routines WHERE id = ? AND builtin = 0",
                    (routine_id,),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)
