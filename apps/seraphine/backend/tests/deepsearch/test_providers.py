import httpx
import pytest
import respx

from seraphine.deepsearch.providers import OpenRouterClient


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
