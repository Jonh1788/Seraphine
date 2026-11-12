"""Which actions of a run were started and never finished.

An *action* is anything an engine does besides thinking and writing: run a
command, change a file, call a tool. It shows up as two ``step`` events linked
by ``call_id`` (``phase`` ``started`` then ``completed``). The command that the
harness itself runs after an approval is bracketed the same way, and its
``command`` event (which carries ``approval_id``) counts as the end.

This is the single source of truth for the restart decision (``_recover``): an
open action means something may have stopped half way, so the run is not resumed
-- unless every open action is read-only (see ``is_read_only``): cutting a read leaves
nothing half done.
"""

from __future__ import annotations

from typing import Any, Iterable


def is_read_only(payload: dict[str, Any]) -> bool:
    """The engine adapter marked this action step as read-only (reading or searching files,
    searching the web). Terminal commands are never marked."""
    return payload.get("read_only") is True and payload.get("type") != "command"


def open_actions(events: Iterable[dict[str, Any]], *,
                 ignore_read_only: bool = False) -> list[dict[str, Any]]:
    """Payloads of the ``started`` steps that have no matching end, oldest first.

    ``events`` are run events in order (``{"kind": ..., "payload": {...}}``, as
    ``AgentHarnessService.list_events`` returns them). A ``status`` event closes
    the engine turn, so anything still open before it was abandoned by the engine
    on its own and is not an interruption; so does the ``interrupted_by_owner`` note
    (the owner cut the turn and the agent was warned about what was open).
    ``ignore_read_only``: leave out the read-only actions (the boot decision).
    """
    pending: dict[str, dict[str, Any]] = {}
    for event in events:
        kind = event.get("kind")
        payload = event.get("payload")
        if not isinstance(payload, dict):
            continue
        if kind == "status" or (kind == "step" and payload.get("reason") == "interrupted_by_owner"):
            pending.clear()  # the owner cut the turn: the agent is told about the open action
        elif kind == "step" and payload.get("call_id") is not None:
            call_id = str(payload["call_id"])
            if payload.get("phase") == "started":
                pending.pop(call_id, None)
                pending[call_id] = payload
            elif payload.get("phase") == "completed":
                pending.pop(call_id, None)
        elif kind == "command":
            ended = payload.get("call_id") or payload.get("approval_id")
            if ended is not None:
                pending.pop(str(ended), None)
    out = list(pending.values())
    return [a for a in out if not is_read_only(a)] if ignore_read_only else out
