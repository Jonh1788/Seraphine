"""Counting a run's actions and spotting a stuck loop (phase 1d). Pure: no I/O, no clock.

``ActionTracker`` turns the engine's events into *actions*: a started/completed pair is
one action, a single-event action is one action. ``StuckDetector`` is fed each finished
action and answers with the rule that fired, if any.

The rules (numbers in code, not in settings):

* ``repeat``: the same action (same type and same target or command) ``REPEAT_LIMIT``
  times in a row; ``READ_ONLY_REPEAT_LIMIT`` when it only reads (reading a file again is
  often legitimate);
* ``repeat_error``: the same action failing with the same error ``ERROR_REPEAT_LIMIT``
  times within the last ``WINDOW`` actions;
* ``fail_streak``: ``FAIL_STREAK_LIMIT`` actions in a row failing.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any

REPEAT_LIMIT = 3
READ_ONLY_REPEAT_LIMIT = 6
ERROR_REPEAT_LIMIT = 3
WINDOW = 8
FAIL_STREAK_LIMIT = 4

#: ``step`` types that are actions of the agent (a ``command`` is a ``command`` event or step).
ACTION_TYPES = frozenset({"command", "file_change", "web_search", "tool_use", "tool_call", "seraphine_tool"})
_TARGET_MAX = 200
_ERROR_MAX = 200
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_DIGITS = re.compile(r"\d+")


def _squash(text: str) -> str:
    return " ".join(str(text or "").split())


def normalize_error(text: str) -> str:
    """The error text without what changes between two identical failures: colours, case,
    spacing and numbers (pids, line numbers, times). Only its first 200 characters count.

    ``"Cannot find module './x' (pid 4821)"`` -> ``"cannot find module './x' (pid #)"``."""
    return _DIGITS.sub("#", _squash(_ANSI.sub("", str(text or ""))).lower())[:_ERROR_MAX]


def _last_line(output: str) -> str:
    lines = [ln.strip() for ln in _ANSI.sub("", str(output or "")).splitlines() if ln.strip()]
    return lines[-1] if lines else ""


@dataclass(frozen=True)
class Action:
    type: str
    #: What the action did: command, tool + target, query, changed paths (normalised).
    target: str
    failed: bool = False
    #: Normalised error text of a failed action ("" when there is none).
    error: str = ""
    read_only: bool = False
    #: The step payload (for the message to the owner).
    payload: dict = field(default_factory=dict, compare=False, hash=False)

    @property
    def signature(self) -> tuple[str, str]:
        return (self.type, self.target)


def _target(payload: dict[str, Any]) -> str:
    kind = payload.get("type")
    if kind == "command":
        return _squash(payload.get("command"))[:_TARGET_MAX]
    if kind == "file_change":
        paths = sorted(str(c.get("path", "")).replace("\\", "/")
                       for c in payload.get("changes") or [] if isinstance(c, dict))
        return ",".join(paths)[:_TARGET_MAX]
    if kind == "web_search":
        return _squash(payload.get("query")).lower()[:_TARGET_MAX]
    tool = str(payload.get("tool") or "")
    if kind == "seraphine_tool":  # the label carries the arguments in words ("Buscou nas notas: x")
        return _squash(f"{tool} {str(payload.get('label') or '').lower()}")[:_TARGET_MAX]
    return _squash(f"{tool} {str(payload.get('target') or '').replace(chr(92), '/')}")[:_TARGET_MAX]


def make_action(started: dict[str, Any] | None, done: dict[str, Any]) -> Action:
    """The action from its end event (``done``), completed with its start event if known.

    A command fails when its exit code is not 0 (the error is the last line of its output,
    with the exit code); other actions fail when the adapter says ``failed``."""
    merged = {**(started or {}), **done}
    kind = str(merged.get("type") or "command")
    merged["type"] = kind
    failed = bool(done.get("failed")) or done.get("ok") is False  # ``ok`` is the gateway's way
    error = normalize_error(str(done.get("error") or ""))
    code = done.get("exit_code")
    if kind == "command" and isinstance(code, int) and not isinstance(code, bool) and code != 0:
        # The exit code stays as it is: exit 1 and exit 127 are not the same failure.
        failed, error = True, f"exit {code}: {normalize_error(_last_line(str(done.get('output') or '')))}"
    return Action(type=kind, target=_target(merged), failed=failed, error=error if failed else "",
                  read_only=merged.get("read_only") is True and kind != "command", payload=merged)


@dataclass
class Seen:
    #: This event is a new action for the count.
    counted: bool = False
    #: The action finished with this event (None for the start of a paired action).
    finished: Action | None = None


class ActionTracker:
    """Follows the actions of one run. ``open`` holds the paired actions not yet finished."""

    def __init__(self) -> None:
        self.open: dict[str, dict[str, Any]] = {}

    def new_turn(self) -> None:
        """A turn cut or ended abandons whatever was open in it."""
        self.open.clear()

    def feed(self, kind: str, payload: dict[str, Any]) -> Seen:
        # What the harness itself runs after an approval is not the agent's action.
        if payload.get("by") == "harness" or kind.startswith("_"):
            return Seen()
        is_action = (kind == "command" or (kind == "step" and payload.get("type") in ACTION_TYPES))
        if not is_action:
            return Seen()
        phase, call_id = payload.get("phase"), payload.get("call_id")
        cid = str(call_id) if call_id is not None else None
        if phase == "started" and cid is not None:
            self.open[cid] = payload
            return Seen(counted=True)
        started = self.open.pop(cid, None) if cid is not None else None
        return Seen(counted=started is None, finished=make_action(started, payload))


@dataclass(frozen=True)
class Fired:
    rule: str  # repeat | repeat_error | fail_streak
    action: Action
    count: int


class StuckDetector:
    """Fed the finished actions of one run, in order."""

    def __init__(self) -> None:
        self._recent: deque[Action] = deque(maxlen=WINDOW)

    def feed(self, action: Action) -> Fired | None:
        self._recent.append(action)
        recent = list(self._recent)

        streak = 0
        for past in reversed(recent):
            if past.signature != action.signature:
                break
            streak += 1
        limit = READ_ONLY_REPEAT_LIMIT if action.read_only else REPEAT_LIMIT
        if streak >= limit:
            return Fired("repeat", action, streak)

        if action.failed:
            same = sum(1 for past in recent
                       if past.failed and past.signature == action.signature and past.error == action.error)
            if same >= ERROR_REPEAT_LIMIT:
                return Fired("repeat_error", action, same)
            failing = 0
            for past in reversed(recent):
                if not past.failed:
                    break
                failing += 1
            if failing >= FAIL_STREAK_LIMIT:
                return Fired("fail_streak", action, failing)
        return None
