"""Receipts of the agents' writes (phase 3c): what is kept to undo each kind of write, and how an
undo checks that it would not overwrite something the owner changed in the meantime.

* A **creation** keeps the id of what was created. Undoing it removes the item.
* A **change** keeps the full previous values of the fields it touched. Undoing it puts them back.
* Both keep a **fingerprint** of the item's state right after the write (a SHA-256 of the fields that
  matter, ``updated_at`` included). The undo recomputes it from the item as it is now: if it differs,
  somebody else edited the item after the agent and the undo is refused (``UndoConflict``), with
  nothing changed.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

KIND_CREATE = "create"
KIND_UPDATE = "update"


class UndoConflict(Exception):
    """The item changed after the agent's write (or cannot be reached): nothing is touched."""


@dataclass
class ActionDraft:
    """What a write tool tells the gateway so that the write gets a receipt."""
    kind: str                 # KIND_CREATE | KIND_UPDATE
    target_type: str          # note | project_task | reminder
    target_id: str
    label: str                # "Criou a nota «Compras»"
    fingerprint: str
    before: dict[str, Any] | None = None


@dataclass
class Outcome:
    """Result of a tool that needs the context of the call (writes, ``ask_owner``)."""
    text: str
    draft: ActionDraft | None = None


@dataclass
class CallCtx:
    """Where a call comes from: the run, its agent and project, and the harness service."""
    run_id: str
    agent_id: str
    project_id: str
    task_id: str | None
    svc: Any = field(repr=False)


def fingerprint(state: dict[str, Any] | None) -> str:
    raw = json.dumps(state, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def note_state(note: dict[str, Any]) -> dict[str, Any]:
    return {"title": note.get("title"), "content": note.get("content"),
            "tags": list(note.get("tags") or []), "updated_at": note.get("updated_at")}


def task_state(task: dict[str, Any]) -> dict[str, Any]:
    return {k: task.get(k) for k in ("title", "description", "status", "priority", "updated_at")}


def reminder_state(entry: dict[str, Any]) -> dict[str, Any]:
    return {k: entry.get(k) for k in ("message", "fire_at", "recurring")}


async def reminder_entry(sv: Any, reminder_id: str) -> dict[str, Any] | None:
    if sv.reminders is None:
        return None
    for entry in sv.reminders.list_reminders():
        if entry.get("id") == reminder_id:
            return entry
    return None


async def _current(svc: Any, sv: Any, target_type: str, target_id: str) -> dict[str, Any] | None:
    """The item's state now, or None when it no longer exists."""
    if target_type == "note":
        if sv.notes is None:
            raise UndoConflict("As notas não estão disponíveis agora; nada foi mudado.")
        note = await sv.notes.get(target_id)
        return note_state(note.to_dict()) if note is not None else None
    if target_type == "project_task":
        task = await svc.get_task(target_id)
        return task_state(task) if task is not None else None
    if target_type == "reminder":
        if sv.reminders is None:
            raise UndoConflict("Os lembretes não estão disponíveis agora; nada foi mudado.")
        entry = await reminder_entry(sv, target_id)
        return reminder_state(entry) if entry is not None else None
    raise UndoConflict("Esta ação não pode ser desfeita por aqui; nada foi mudado.")


async def revert(svc: Any, sv: Any, row: dict[str, Any]) -> None:
    """Undo the write described by an ``agent_actions`` row. Raises ``UndoConflict`` (nothing
    changed) when the item is no longer as the agent left it."""
    target_type, target_id = row["target_type"], row["target_id"]
    current = await _current(svc, sv, target_type, target_id)
    if row["kind"] == KIND_CREATE:
        if current is None:
            return  # already gone (removed by the owner, or a reminder that has fired): nothing to remove
        if fingerprint(current) != row["fingerprint"]:
            raise UndoConflict("O item foi alterado depois que o agente o criou; desfazer apagaria essa "
                               "alteração. Nada foi mudado.")
        await _remove(svc, sv, target_type, target_id)
        return
    if current is None or fingerprint(current) != row["fingerprint"]:
        raise UndoConflict("O item foi alterado (ou apagado) depois da mudança do agente; desfazer apagaria "
                           "essa alteração. Nada foi mudado.")
    before = json.loads(row["before_json"] or "{}")
    if target_type == "note":
        await sv.notes.update(target_id, **before)
    elif target_type == "project_task":
        await svc.update_task(target_id, **before)


async def _remove(svc: Any, sv: Any, target_type: str, target_id: str) -> None:
    if target_type == "note":
        await sv.notes.delete(target_id)
    elif target_type == "project_task":
        await svc._db(lambda c: c.execute("DELETE FROM agent_tasks WHERE id = ?", (target_id,)))
    elif target_type == "reminder":
        sv.reminders.cancel_reminder(target_id)
