"""Smoke test: the new _run_agentic_collect mirrors what the SSE
stream would have emitted, but as a plain return value. Mocks LLM +
services; we only check that the function exists and threads outputs
correctly."""
import pytest
from unittest.mock import AsyncMock, MagicMock

from aura.chat.routes import _run_agentic_collect  # the new function


class _Token:
    def __init__(self, *, text="", tool_calls=None, done=False):
        self.text = text
        self.tool_calls = tool_calls
        self.done = done


@pytest.mark.asyncio
async def test_collect_returns_full_text_for_plain_reply():
    llm = MagicMock()
    async def _stream(msgs, tools=None, think=False):
        for tok in (_Token(text="Olá! "), _Token(text="tudo bem?", done=True)):
            yield tok
    llm.chat = _stream

    svc = AsyncMock()
    svc.add_message = AsyncMock(return_value="msg-id")
    svc.update_title = AsyncMock()

    out = await _run_agentic_collect(
        llm=llm,
        finance=AsyncMock(),
        tasks_svc=AsyncMock(),
        recurring_svc=AsyncMock(),
        projects_svc=None,
        habits_svc=None,
        knowledge_svc=None,
        goals_svc=None,
        svc=svc,
        uid="u1",
        conversation_id="c1",
        user_text="oi",
        msgs=[],
        is_first_exchange=False,
    )
    assert out["reply"] == "Olá! tudo bem?"
    assert out["transactions"] == []
    assert out["tasks"] == []
    assert out["recurring"] == []
    assert out["chips"] == []
    svc.add_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_collect_recurring_with_materialized_task_appends_both(monkeypatch):
    """create_recurring_task can produce both a `recurring` rule and a
    `materialized_task` for today; both must land in the return dict."""
    from aura.chat import routes as chat_routes

    # Mock the underlying tool to deliver the recurring + materialized
    # combo on the first round, then a plain done token on the second.
    async def fake_exec_recurring(*args, **kwargs):
        return {
            "ok": True,
            "recurring": {"id": 1, "title": "Lixo segunda", "frequency": "weekly"},
            "materialized_task": {
                "id": 99, "title": "Lixo segunda",
                "status": "pending", "due_date": "2026-05-04",
                "due_time": "10:00", "description": "",
            },
        }
    monkeypatch.setattr(chat_routes, "_exec_create_recurring_task", fake_exec_recurring)

    llm = MagicMock()
    call_count = {"n": 0}

    async def _stream(msgs, tools=None, think=False):
        call_count["n"] += 1
        if call_count["n"] == 1:
            yield _Token(
                tool_calls=[{
                    "function": {
                        "name": "create_recurring_task",
                        "arguments": '{"title":"Lixo segunda","frequency":"weekly","weekday":0,"time":"10:00"}',
                    },
                }],
                done=True,
            )
        else:
            yield _Token(text="Anotado!", done=True)
    llm.chat = _stream

    svc = AsyncMock()
    svc.add_message = AsyncMock(return_value="msg-id")

    out = await _run_agentic_collect(
        llm=llm,
        finance=AsyncMock(),
        tasks_svc=AsyncMock(),
        recurring_svc=AsyncMock(),
        projects_svc=None,
        habits_svc=None,
        knowledge_svc=None,
        goals_svc=None,
        svc=svc,
        uid="u1",
        conversation_id="c1",
        user_text="lixo toda segunda 10h",
        msgs=[],
        is_first_exchange=False,
    )
    assert out["reply"] == "Anotado!"
    assert len(out["recurring"]) == 1
    assert out["recurring"][0]["title"] == "Lixo segunda"
    # The materialized task MUST also land in the tasks accumulator
    assert any(t["id"] == 99 for t in out["tasks"])
