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
