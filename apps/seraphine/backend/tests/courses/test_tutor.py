import pytest

from seraphine.courses import tutor


class FakeAppLLM:
    def __init__(self):
        self.calls = []
    async def tool_call_json(self, **kw):
        self.calls.append(kw)
        return {"ok": True}


def test_none_spec_returns_app_llm():
    app = FakeAppLLM()
    assert tutor.tutor_llm(None, app_llm=app, openrouter_key="") is app
    assert tutor.tutor_llm("", app_llm=app, openrouter_key="") is app


@pytest.mark.asyncio
async def test_tutor_wraps_role_llm(monkeypatch):
    captured = {}
    class FakeRole:
        provider = "openrouter"; model = "x"
        async def complete_json(self, *, system, user, tool, max_tokens=1024):
            captured.update(system=system, user=user, tool=tool, max_tokens=max_tokens)
            return {"lessons": []}
    monkeypatch.setattr(tutor, "resolve_role_model", lambda spec, *, app_llm, openrouter_key: FakeRole())
    t = tutor.tutor_llm("openrouter:x", app_llm=FakeAppLLM(), openrouter_key="k")
    out = await t.tool_call_json(system="s", user="u", tool={"name": "t"}, max_tokens=3000)
    assert out == {"lessons": []}
    assert captured["max_tokens"] == 3000


@pytest.mark.asyncio
async def test_role_complete_json_forwards_max_tokens_cliproxy():
    from seraphine.deepsearch.providers import RoleLLM
    app = FakeAppLLM()
    role = RoleLLM(provider="cliproxy", model="claude-x", _app_llm=app)
    await role.complete_json(system="s", user="u", tool={"name": "t"}, max_tokens=2222)
    assert app.calls[0]["max_tokens"] == 2222
    assert app.calls[0]["model"] == "claude-x"
