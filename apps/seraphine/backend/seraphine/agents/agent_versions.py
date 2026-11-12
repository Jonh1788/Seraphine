"""Version history of an agent's text (phase 6c).

The five editable text fields of an agent (``VERSION_FIELDS``) are recorded as a version when the agent is
created and every time one of them changes, whatever the path (owner form, guide proposal, ready-made team,
restore). The one place that does it is ``AgentHarnessService.create_def`` / ``update_def``, inside the same
transaction as the write, through ``VersionMixin._record_version``: nothing else writes those columns.

An agent that existed before this feature has no version yet: its first version ("as it was when the history
began") is made lazily, on the first read of the history or just before the first change.
"""

from __future__ import annotations

import json
from typing import Any

from seraphine.agents.errors import Conflict, NotFound
from seraphine.agents.routine_service import _iso, _one, _rows

VERSION_FIELDS = ("name", "role", "description", "instructions", "suggestions")
CHANGED_BY = ("owner", "guide", "pack", "restore")
#: Most versions the history route lists (the newest ones).
VERSIONS_LIST_MAX = 50
NOTE_CREATED = "Criado."
NOTE_BEGAN = "Como estava quando o histórico começou."
NOTE_GUIDE = "Mudança pedida na conversa com a Seraphine."
NOTE_OWNER = "Mudança feita por você."
NOTE_PACK = "Criado a partir de um time pronto."
NOTE_GUIDE_CREATED = "Criado pela Seraphine."


def note_restore(version: int) -> str:
    return f"Voltou para a versão {version}."


def _suggestions(raw: Any) -> list[str]:
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    return [str(x) for x in data if isinstance(x, str)] if isinstance(data, list) else []


def text_state(source: dict[str, Any]) -> dict[str, Any]:
    """The five fields of an agent row, an agent object or a version row, with ``suggestions`` as a list."""
    return {"name": str(source.get("name") or ""), "role": str(source.get("role") or ""),
            "description": str(source.get("description") or ""),
            "instructions": str(source.get("instructions") or ""),
            "suggestions": _suggestions(source.get("suggestions"))}


def changed_fields(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    return [f for f in VERSION_FIELDS if before.get(f) != after.get(f)]


def version_dict(row: dict[str, Any]) -> dict[str, Any]:
    out = text_state(row)
    try:
        fields = json.loads(row.get("changed_fields") or "[]")
    except ValueError:
        fields = []
    out.update(version=int(row["version"]), changed_by=row["changed_by"], note=row.get("note") or "",
               changed_fields=[f for f in fields if f in VERSION_FIELDS], created_at=row["created_at"])
    return out


class VersionMixin:
    """Methods of ``AgentHarnessService`` for the history. Expects ``_db``, ``now`` and ``_require_def``."""

    def _insert_version(self, conn: Any, agent_id: str, version: int, state: dict[str, Any], changed_by: str,
                        note: str, fields: list[str]) -> None:
        conn.execute(
            "INSERT INTO agent_versions (agent_id, version, name, role, description, instructions, suggestions,"
            " changed_by, note, changed_fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (agent_id, version, state["name"], state["role"], state["description"], state["instructions"],
             json.dumps(state["suggestions"], ensure_ascii=False), changed_by, note,
             json.dumps(fields), _iso(self.now())))  # type: ignore[attr-defined]

    def _record_version(self, conn: Any, agent_id: str, before: dict[str, Any] | None,
                        after: dict[str, Any], changed_by: str, note: str) -> int | None:
        """Inside the transaction of a write: the version for it, or ``None`` when none of the five fields
        changed. ``before`` is ``None`` for a creation. An agent with no history yet first gets its version 1
        (its state before this change)."""
        last = conn.execute("SELECT MAX(version) FROM agent_versions WHERE agent_id = ?", (agent_id,)).fetchone()[0]
        if before is None:
            self._insert_version(conn, agent_id, 1, after, changed_by, note, list(VERSION_FIELDS))
            return 1
        fields = changed_fields(before, after)
        if not fields:
            return None
        if last is None:
            self._insert_version(conn, agent_id, 1, before, "owner", NOTE_BEGAN, [])
            last = 1
        self._insert_version(conn, agent_id, last + 1, after, changed_by, note, fields)
        return last + 1

    def _ensure_history(self, conn: Any, agent_id: str) -> None:
        """The lazy version 1 of an agent that existed before the history did."""
        if conn.execute("SELECT 1 FROM agent_versions WHERE agent_id = ? LIMIT 1", (agent_id,)).fetchone():
            return
        row = _one(conn, "SELECT * FROM agent_defs WHERE id = ?", (agent_id,))
        if row is not None:
            self._insert_version(conn, agent_id, 1, text_state(row), "owner", NOTE_BEGAN, [])

    def _delete_agent_versions(self, conn: Any, agent_id: str) -> None:
        conn.execute("DELETE FROM agent_versions WHERE agent_id = ?", (agent_id,))

    async def _versions_of(self, agent_ids: list[str]) -> dict[str, int]:
        """``{agent id: latest version number}`` (0 when an agent has no history yet)."""
        out = {a: 0 for a in agent_ids}
        if not agent_ids:
            return out
        marks = ",".join("?" for _ in agent_ids)
        rows = await self._db(lambda c: c.execute(  # type: ignore[attr-defined]
            f"SELECT agent_id, MAX(version) FROM agent_versions WHERE agent_id IN ({marks}) GROUP BY agent_id",
            tuple(agent_ids)).fetchall())
        for agent_id, number in rows:
            out[agent_id] = int(number)
        return out

    async def list_versions(self, agent_id: str) -> list[dict[str, Any]]:
        """The agent's versions, newest first (at most ``VERSIONS_LIST_MAX``)."""
        await self._require_def(agent_id)  # type: ignore[attr-defined]

        def _r(conn: Any) -> list[dict[str, Any]]:
            self._ensure_history(conn, agent_id)
            return _rows(conn, "SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT ?",
                         (agent_id, VERSIONS_LIST_MAX))

        return [version_dict(r) for r in await self._db(_r)]  # type: ignore[attr-defined]

    async def restore_version(self, agent_id: str, version: Any) -> dict[str, Any]:
        """The five fields go back to what they were in ``version``; that is a new version (``restore``)."""
        agent = await self._require_def(agent_id)  # type: ignore[attr-defined]
        try:
            number = int(version)
        except (TypeError, ValueError):
            raise NotFound("versão não encontrada") from None

        def _r(conn: Any) -> dict[str, Any] | None:
            self._ensure_history(conn, agent_id)
            return _one(conn, "SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?",
                        (agent_id, number))

        row = await self._db(_r)  # type: ignore[attr-defined]
        if row is None:
            raise NotFound("versão não encontrada")
        target = text_state(row)
        if not changed_fields(text_state(agent), target):
            raise Conflict("Esta versão já é a atual.", code="version_current")
        updated = await self.update_def(  # type: ignore[attr-defined]
            agent_id, changed_by="restore", note=note_restore(number), name=target["name"], role=target["role"],
            description=target["description"], instructions=target["instructions"],
            suggestions=target["suggestions"])
        newest = await self._db(lambda c: _one(  # type: ignore[attr-defined]
            c, "SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1", (agent_id,)))
        return {"def": updated, "version": version_dict(newest) if newest else None}
