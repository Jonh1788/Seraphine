"""Phase 1d: the pure parts of the run limits (action tracker, stuck-loop detector, read-only flag)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from seraphine.agents.actions import is_read_only, open_actions
from seraphine.agents.engines.claude_code import ClaudeStreamParser
from seraphine.agents.engines.codex import CodexEventParser
from seraphine.agents.loops import (
    ERROR_REPEAT_LIMIT, FAIL_STREAK_LIMIT, READ_ONLY_REPEAT_LIMIT, REPEAT_LIMIT, WINDOW,
    Action, ActionTracker, StuckDetector, make_action, normalize_error,
)


def cmd(command: str, *, failed: bool = False, error: str = "") -> Action:
    return Action("command", command, failed=failed, error=normalize_error(error) if failed else "")


def read(path: str) -> Action:
    return Action("tool_use", f"Read {path}", read_only=True)


def feed_all(actions: list[Action]) -> list[str | None]:
    det = StuckDetector()
    out = []
    for a in actions:
        fired = det.feed(a)
        out.append(fired.rule if fired else None)
    return out


# -- normalisation ----------------------------------------------------------------------


def test_numbers_colours_and_spacing_do_not_tell_two_errors_apart():
    a = normalize_error("\x1b[31mCannot  find module './x'\x1b[0m (pid 4821)")
    b = normalize_error("cannot find module './x' (PID 77)")
    assert a == b == "cannot find module './x' (pid #)"
    assert normalize_error("erro na linha 10") != normalize_error("outro erro na linha 10")
    assert len(normalize_error("x" * 1000)) == 200


def test_a_command_failure_takes_its_error_from_the_exit_code_and_last_output_line():
    done = {"command": "npm  test", "exit_code": 2, "output": "linha 1\n\nFalhou no teste 7  \n"}
    act = make_action(None, done)
    assert act.failed and act.type == "command" and act.target == "npm test"
    assert act.error == "exit 2: falhou no teste #"
    ok = make_action(None, {"command": "npm test", "exit_code": 0, "output": "ok"})
    assert not ok.failed and ok.error == ""


def test_a_paired_action_takes_its_target_from_the_start_event():
    started = {"type": "tool_use", "phase": "started", "call_id": "t", "tool": "Edit", "target": "src\\a.py"}
    done = {"type": "tool_use", "phase": "completed", "call_id": "t", "failed": True, "error": "Erro 5"}
    act = make_action(started, done)
    assert act.target == "Edit src/a.py" and act.failed and act.error == "erro #"


# -- tracker ----------------------------------------------------------------------------


def test_a_started_completed_pair_counts_once_and_a_single_event_counts_once():
    t = ActionTracker()
    s = t.feed("step", {"type": "command", "phase": "started", "call_id": "1", "command": "ls"})
    assert s.counted and s.finished is None and list(t.open) == ["1"]
    e = t.feed("command", {"command": "ls", "exit_code": 0, "phase": "completed", "call_id": "1"})
    assert not e.counted and e.finished is not None and t.open == {}
    single = t.feed("command", {"command": "ls", "exit_code": 0, "by": "agent"})
    assert single.counted and single.finished is not None
    lone = t.feed("step", {"type": "tool_use", "phase": "completed", "call_id": "z", "tool": "Read"})
    assert lone.counted and lone.finished is not None


def test_notes_messages_reasoning_and_harness_commands_are_not_actions():
    t = ActionTracker()
    for kind, payload in [("message", {"text": "oi"}), ("step", {"type": "reasoning", "text": "x"}),
                          ("step", {"type": "note", "text": "n"}), ("error", {"message": "m"}),
                          ("_session", {"session_ref": "s"}),
                          ("step", {"type": "command", "phase": "started", "call_id": "h", "by": "harness"}),
                          ("command", {"command": "echo", "by": "harness", "approval_id": "a"})]:
        seen = t.feed(kind, payload)
        assert not seen.counted and seen.finished is None
    assert t.open == {}


def test_a_new_turn_forgets_what_was_left_open():
    t = ActionTracker()
    t.feed("step", {"type": "command", "phase": "started", "call_id": "1", "command": "ls"})
    t.new_turn()
    assert t.open == {}


# -- the three rules, table driven ------------------------------------------------------

RULES: list[tuple[str, list[Action], list[str | None]]] = [
    ("same action three in a row",
     [cmd("ls"), cmd("ls"), cmd("ls")], [None, None, "repeat"]),
    ("two repeats are fine",
     [cmd("ls"), cmd("ls"), cmd("pwd"), cmd("ls")], [None, None, None, None]),
    ("a different action in between breaks the run of repeats",
     [cmd("ls"), cmd("ls"), cmd("pwd"), cmd("ls"), cmd("ls")], [None] * 5),
    ("same type but another target is another action",
     [cmd("ls a"), cmd("ls b"), cmd("ls c")], [None, None, None]),
    ("same target but another type is another action",
     [Action("command", "x"), Action("web_search", "x"), Action("command", "x")], [None] * 3),
    ("same action failing with the same error three times within the window (not in a row)",
     [cmd("t", failed=True, error="boom 1"), cmd("a"), cmd("t", failed=True, error="boom 2"),
      cmd("b"), cmd("t", failed=True, error="boom 3")], [None, None, None, None, "repeat_error"]),
    ("the same failing action with different errors is not rule 2",
     [cmd("t", failed=True, error="erro a"), cmd("a"), cmd("t", failed=True, error="erro b"),
      cmd("b"), cmd("t", failed=True, error="erro c")], [None] * 5),
    ("the third failure falls outside the last 8 actions",
     [cmd("t", failed=True, error="x")] + [cmd(f"o{i}") for i in range(WINDOW - 1)]
     + [cmd("t", failed=True, error="x")] + [cmd("o")] + [cmd("t", failed=True, error="x")],
     [None] * (1 + WINDOW - 1 + 1 + 1 + 1)),
    ("four failures in a row, all different",
     [cmd(f"f{i}", failed=True, error=f"erro {chr(97 + i)}") for i in range(4)],
     [None, None, None, "fail_streak"]),
    ("a success breaks the failure streak",
     [cmd("f1", failed=True, error="a"), cmd("f2", failed=True, error="b"), cmd("ok"),
      cmd("f3", failed=True, error="c"), cmd("f4", failed=True, error="d"),
      cmd("f5", failed=True, error="e")], [None] * 6),
]


@pytest.mark.parametrize("name,actions,expected", RULES, ids=[r[0] for r in RULES])
def test_loop_rules(name: str, actions: list[Action], expected: list[str | None]) -> None:
    assert feed_all(actions) == expected


def test_the_limits_are_the_contract_numbers():
    assert (REPEAT_LIMIT, ERROR_REPEAT_LIMIT, WINDOW, FAIL_STREAK_LIMIT, READ_ONLY_REPEAT_LIMIT) == (3, 3, 8, 4, 6)


def test_read_only_actions_need_six_repeats_in_a_row():
    rules = feed_all([read("a.py")] * 6)
    assert rules == [None] * 5 + ["repeat"]
    assert feed_all([read("a.py")] * 5 + [read("b.py")] + [read("a.py")] * 2) == [None] * 8


def test_a_repeated_non_read_only_tool_is_a_loop_at_three():
    edit = Action("tool_use", "Edit a.py")
    assert feed_all([edit] * 3) == [None, None, "repeat"]


def test_a_command_is_never_read_only_even_if_flagged():
    flagged = make_action(None, {"type": "command", "command": "cat a", "exit_code": 0, "read_only": True})
    assert flagged.read_only is False
    assert feed_all([flagged] * 3) == [None, None, "repeat"]


def test_failing_reads_still_hit_the_failure_rules():
    bad = [Action("tool_use", "Read a.py", failed=True, error="nao existe", read_only=True)] * 3
    assert feed_all(bad) == [None, None, "repeat_error"]


def test_fired_carries_the_action_and_the_count():
    det = StuckDetector()
    fired = None
    for _ in range(3):
        fired = det.feed(make_action(None, {"command": "ls", "exit_code": 0}))
    assert fired is not None and fired.rule == "repeat" and fired.count == 3
    assert fired.action.payload["command"] == "ls"


# -- read-only flag: helper and adapters ------------------------------------------------


def ev(kind: str, **payload: Any) -> dict:
    return {"kind": kind, "payload": payload}


def test_open_actions_can_leave_out_the_read_only_ones():
    events = [ev("step", type="tool_use", phase="started", call_id="r", tool="Read", read_only=True),
              ev("step", type="command", phase="started", call_id="c", command="npm i", read_only=True)]
    assert [a["call_id"] for a in open_actions(events)] == ["r", "c"]
    # a command is never read-only, whatever the payload says
    assert [a["call_id"] for a in open_actions(events, ignore_read_only=True)] == ["c"]
    assert is_read_only({"type": "web_search", "read_only": True})
    assert not is_read_only({"type": "command", "read_only": True}) and not is_read_only({"type": "tool_use"})


def _claude(parser: ClaudeStreamParser, tool: str, tool_id: str = "u1", **inp: Any) -> list:
    out = parser.feed(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tool_id, "name": tool, "input": inp or {"file_path": "a.py"}}]}}))
    out += parser.feed(json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}]}}))
    return [payload for _, payload in out]


@pytest.mark.parametrize("tool,flagged", [
    ("Read", True), ("Glob", True), ("Grep", True), ("WebSearch", True),
    ("Bash", False), ("Edit", False), ("Write", False), ("WebFetch", False),
])
def test_claude_adapter_flags_only_the_read_only_tools(tool: str, flagged: bool):
    started, completed = _claude(ClaudeStreamParser(), tool)
    assert started["phase"] == "started" and completed["phase"] == "completed"
    assert started.get("read_only") is (True if flagged else None)
    assert completed.get("read_only") is (True if flagged else None)


def test_claude_adapter_marks_a_failed_tool_on_the_completed_step():
    p = ClaudeStreamParser()
    p.feed(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "false"}}]}}))
    out = p.feed(json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "b1", "is_error": True, "content": "exit 1"}]}}))
    done = out[0][1]
    assert done["failed"] is True and done["error"] == "exit 1" and "read_only" not in done


def test_codex_adapter_flags_web_search_but_not_commands():
    p = CodexEventParser()
    lines = [
        {"type": "item.started", "item": {"id": "w", "type": "web_search", "query": "q"}},
        {"type": "item.completed", "item": {"id": "w", "type": "web_search", "query": "q"}},
        {"type": "item.started", "item": {"id": "c", "type": "command_execution", "command": "ls"}},
        {"type": "item.completed", "item": {"id": "c", "type": "command_execution", "command": "ls",
                                            "exit_code": 0, "aggregated_output": "a"}},
    ]
    events = [e for line in lines for e in p.feed(json.dumps(line))]
    web = [pl for _, pl in events if pl.get("type") == "web_search"]
    assert len(web) == 2 and all(pl["read_only"] is True for pl in web)
    commands = [pl for _, pl in events if pl.get("command") == "ls"]
    assert len(commands) == 2 and all("read_only" not in pl for pl in commands)
