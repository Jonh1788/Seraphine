import json
from unittest.mock import AsyncMock

import pytest

from llm_adapters.codex import CodexClient
from llm_adapters.types import LLMUnavailableError
from seraphine.config import Settings
from seraphine.llm.selection import SelectableEngine


TOOLS = [{"type": "function", "function": {"name": "list_tasks", "parameters": {"type": "object"}}}]


def test_codex_reply_preserves_portuguese():
    reply = CodexClient._parse_reply(json.dumps({"text": "Olá, Jonathan!", "tool_calls": []}), [])
    assert reply.text == "Olá, Jonathan!"
    assert reply.done and not reply.tool_calls


def test_codex_tools_use_seraphine_contract():
    reply = CodexClient._parse_reply(json.dumps({"text": "", "tool_calls": [{"name": "list_tasks", "arguments": '{"status":"open"}'}]}), TOOLS)
    assert reply.tool_calls == [{"function": {"name": "list_tasks", "arguments": {"status": "open"}}}]


@pytest.mark.parametrize("name,args", [("run_shell", "{}"), ("list_tasks", "[]"), ("list_tasks", "invalid")])
def test_codex_rejects_invalid_tools(name, args):
    with pytest.raises(LLMUnavailableError):
        CodexClient._parse_reply(json.dumps({"text": "", "tool_calls": [{"name": name, "arguments": args}]}), TOOLS)


@pytest.mark.asyncio
async def test_selection_persists_and_keeps_inflight_engine_open(monkeypatch):
    settings = Settings(_env_file=None, llm_backend="ollama", llm_model="qwen2.5:3b")
    llm = SelectableEngine(settings)
    store = AsyncMock()
    old = llm._engine
    monkeypatch.setattr(CodexClient, "check_available", AsyncMock())
    await llm.select("codex", store)
    assert llm.selection == "codex" and llm.info.name == "Codex"
    assert old in llm._retired
    store.set_kv.assert_awaited_once_with("llm_backend", "codex")
    store.delete_kv.assert_awaited_once_with("chat_model")
    await llm.aclose()


@pytest.mark.asyncio
async def test_failed_login_preserves_previous_selection(monkeypatch):
    settings = Settings(_env_file=None, llm_backend="ollama", llm_model="qwen2.5:3b")
    llm = SelectableEngine(settings)
    store = AsyncMock()
    monkeypatch.setattr(CodexClient, "check_available", AsyncMock(side_effect=LLMUnavailableError("Entre no Codex")))
    with pytest.raises(LLMUnavailableError):
        await llm.select("codex", store)
    assert llm.selection == "ollama"
    store.set_kv.assert_not_awaited()
    await llm.aclose()
