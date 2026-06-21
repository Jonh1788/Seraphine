import pytest

from seraphine.email_urgency import triage


class FakeLLM:
    def __init__(self, result=None, raise_exc=False):
        self._result = result or {"urgency": "high", "reason": "fatura vence hoje"}
        self._raise = raise_exc
        self.calls = []

    async def tool_call_json(self, *, system, user, tool, cache_system=False, max_tokens=1024, model=None):
        self.calls.append({"system": system, "user": user, "tool": tool, "cache_system": cache_system})
        if self._raise:
            raise RuntimeError("boom")
        return self._result


def test_tool_schema_is_an_enum():
    props = triage.URGENCY_TOOL["input_schema"]["properties"]
    assert props["urgency"]["enum"] == ["high", "medium", "low"]
    assert triage.URGENCY_TOOL["name"] == "classify_urgency"


def test_system_prompt_is_strict_and_anti_marketing():
    s = triage.TRIAGE_SYSTEM.lower()
    assert "marketing" in s
    assert "phishing" in s
    assert "newsletter" in s


@pytest.mark.asyncio
async def test_classify_passes_email_fields_and_returns_normalized():
    llm = FakeLLM({"urgency": "HIGH", "reason": "x" * 500})
    out = await triage.classify_urgency(llm, sender="Banco <b@x.com>", subject="Fatura", snippet="vence hoje")
    assert out["urgency"] == "high"  # lowercased + valid
    assert len(out["reason"]) <= 200  # clamped
    call = llm.calls[0]
    assert call["tool"] is triage.URGENCY_TOOL
    assert call["cache_system"] is True
    assert "Fatura" in call["user"] and "Banco" in call["user"]


@pytest.mark.asyncio
async def test_classify_invalid_urgency_falls_back_to_low():
    llm = FakeLLM({"urgency": "URGENTÍSSIMO", "reason": "r"})
    out = await triage.classify_urgency(llm, sender="a", subject="b", snippet="c")
    assert out["urgency"] == "low"


@pytest.mark.asyncio
async def test_classify_handles_llm_error_and_none():
    assert (await triage.classify_urgency(None, sender="a", subject="b", snippet="c"))["urgency"] == "low"
    llm = FakeLLM(raise_exc=True)
    assert (await triage.classify_urgency(llm, sender="a", subject="b", snippet="c"))["urgency"] == "low"
