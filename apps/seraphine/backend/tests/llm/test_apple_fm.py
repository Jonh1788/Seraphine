import asyncio

import pytest

from llm_adapters.apple_fm import AppleFoundationModelsClient
from llm_adapters.types import ChatMessage, LLMUnavailableError


def test_unavailable_on_old_macos(monkeypatch):
    monkeypatch.setattr("llm_adapters.apple_fm._macos_major", lambda: 15)
    assert AppleFoundationModelsClient().is_available() is False


def test_chat_raises_when_unavailable(monkeypatch):
    monkeypatch.setattr("llm_adapters.apple_fm._macos_major", lambda: 0)

    async def go():
        c = AppleFoundationModelsClient()
        with pytest.raises(LLMUnavailableError):
            async for _ in c.chat([ChatMessage(role="user", content="oi")]):
                pass

    asyncio.run(go())


def test_available_requires_helper(monkeypatch):
    monkeypatch.setattr("llm_adapters.apple_fm._macos_major", lambda: 26)
    monkeypatch.setattr("llm_adapters.apple_fm.shutil.which", lambda _: None)

    # Bogus helper path + no afm-cli on PATH → unavailable.
    c = AppleFoundationModelsClient(helper_path="/nonexistent/afm-cli")
    assert c.is_available() is False

    # Helper now exists and is executable → available.
    monkeypatch.setattr("llm_adapters.apple_fm.os.path.exists", lambda _: True)
    monkeypatch.setattr("llm_adapters.apple_fm.os.access", lambda _p, _m: True)
    assert c.is_available() is True


def test_chat_streams_with_mocked_subprocess(monkeypatch):
    monkeypatch.setattr("llm_adapters.apple_fm._macos_major", lambda: 26)
    monkeypatch.setattr("llm_adapters.apple_fm.os.path.exists", lambda _: True)
    monkeypatch.setattr("llm_adapters.apple_fm.os.access", lambda _p, _m: True)

    class FakeStdin:
        def write(self, b):
            pass

        async def drain(self):
            pass

        def close(self):
            pass

    class FakeStdout:
        def __init__(self):
            self._lines = [b"ol\xc3\xa1\n", b"mundo\n", b""]

        async def readline(self):
            return self._lines.pop(0)

    class FakeProc:
        def __init__(self):
            self.stdin = FakeStdin()
            self.stdout = FakeStdout()

        async def wait(self):
            return 0

    async def fake_exec(*a, **k):
        return FakeProc()

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_exec)

    async def go():
        c = AppleFoundationModelsClient(helper_path="/some/afm-cli")
        tokens = []
        async for t in c.chat([ChatMessage(role="user", content="oi")]):
            tokens.append(t)
        return tokens

    tokens = asyncio.run(go())
    texts = [t.text for t in tokens if not t.done]
    assert texts == ["olá", "mundo"]
    assert tokens[-1].done is True and tokens[-1].text == ""


def test_aclose_noop():
    assert asyncio.run(AppleFoundationModelsClient().aclose()) is None
