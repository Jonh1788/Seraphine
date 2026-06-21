import httpx
import pytest
import respx

from seraphine.deepsearch.providers import OpenRouterClient, RoleLLM, resolve_role_model


@pytest.mark.asyncio
@respx.mock
async def test_openrouter_complete():
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})
    )
    c = OpenRouterClient(api_key="sk-or-x")
    out = await c.complete([{"role": "user", "content": "yo"}], model="openai/gpt-4o-mini")
    assert out == "hi"
    req = respx.calls.last.request
    assert req.headers["authorization"] == "Bearer sk-or-x"
    assert req.headers["http-referer"]  # attribution header present


class _FakeAnthropic:  # stand-in for app.state.llm
    async def tool_call_json(self, **kw):
        return {"ok": True}


@pytest.mark.asyncio
async def test_resolve_cliproxy_uses_app_llm():
    rl = resolve_role_model(
        "cliproxy:claude-haiku-4-5-20251001", app_llm=_FakeAnthropic(), openrouter_key=""
    )
    assert rl.provider == "cliproxy"
    assert rl.model == "claude-haiku-4-5-20251001"


@pytest.mark.asyncio
async def test_resolve_openrouter_without_key_falls_back_to_cliproxy():
    rl = resolve_role_model(
        "openrouter:openai/gpt-4o-mini", app_llm=_FakeAnthropic(), openrouter_key=""
    )
    assert rl.provider == "cliproxy"  # fell back (no key)


@pytest.mark.asyncio
async def test_resolve_openrouter_with_key():
    rl = resolve_role_model(
        "openrouter:openai/gpt-4o-mini", app_llm=_FakeAnthropic(), openrouter_key="sk-or-x"
    )
    assert rl.provider == "openrouter"
    assert rl.model == "openai/gpt-4o-mini"
