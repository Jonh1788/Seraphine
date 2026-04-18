from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

from fastapi.testclient import TestClient

from seraphine.conversation.engine import ConversationEngine
from llm_adapters.types import ChatMessage, Token
from seraphine.main import app
from seraphine.memory.store import MemoryStore
from seraphine.tts.moss import FakeTTSAdapter


class FakeLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        for c in ["o", "i", "!"]:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


def test_ws_user_message_streams(tmp_path: Path) -> None:
    with TestClient(app) as client:
        # Override engine with a fake-LLM-backed one using a temp store.
        store = MemoryStore(tmp_path / "ws.sqlite")
        import asyncio

        asyncio.get_event_loop().run_until_complete(store.ensure_schema())
        app.state.engine = ConversationEngine(FakeLLM(), store)

        with client.websocket_connect("/ws/conversation") as ws:
            ws.send_json({"type": "user_message", "content": "oi"})
            frames: list[dict] = []
            while True:
                msg = ws.receive_json()
                frames.append(msg)
                if msg.get("type") == "turn_end":
                    break

    token_frames = [f for f in frames if f["type"] == "token"]
    end_frames = [f for f in frames if f["type"] == "turn_end"]
    assert len(token_frames) >= 1
    assert len(end_frames) == 1
    assert token_frames[0]["conversation_id"] == end_frames[0]["conversation_id"]
    assert token_frames[0]["turn_id"] == end_frames[0]["turn_id"]


def test_ws_user_message_speak(tmp_path: Path) -> None:
    """When `speak: true` is sent, the correct event ordering is:
    tts_start → binary PCM chunks → tts_end → turn_end.
    turn_end is deferred until after the speech worker finishes."""
    # NOTE: This test imports llm_adapters which may not be installed in every
    # local venv.  It runs in CI where the full dependency set is available.
    with TestClient(app) as client:
        store = MemoryStore(tmp_path / "speak.sqlite")
        import asyncio

        asyncio.get_event_loop().run_until_complete(store.ensure_schema())
        app.state.engine = ConversationEngine(FakeLLM(), store)
        app.state.tts = FakeTTSAdapter([b"\x00\x01\x02\x03", b"\x04\x05"])

        with client.websocket_connect("/ws/conversation") as ws:
            ws.send_json({"type": "user_message", "content": "oi", "speak": True})

            order: list[str] = []
            saw_tts_start = False
            saw_tts_end = False
            saw_turn_end = False
            binary_frames = 0
            tts_turn_id: str | None = None

            for _ in range(20):
                msg = ws.receive()
                if "text" in msg and msg["text"] is not None:
                    import json as _json

                    obj = _json.loads(msg["text"])
                    t = obj.get("type")
                    if t == "tts_start":
                        saw_tts_start = True
                        tts_turn_id = obj.get("turn_id")
                        order.append("tts_start")
                        assert obj.get("sample_rate") == 24000
                    elif t == "tts_end":
                        saw_tts_end = True
                        assert obj.get("turn_id") == tts_turn_id
                        order.append("tts_end")
                    elif t == "turn_end":
                        saw_turn_end = True
                        assert obj.get("turn_id") == tts_turn_id
                        order.append("turn_end")
                        break
                elif "bytes" in msg and msg["bytes"] is not None:
                    binary_frames += 1

    assert saw_tts_start and saw_tts_end and saw_turn_end
    assert binary_frames >= 1
    # Core invariant: tts_start and tts_end must both precede turn_end.
    assert order.index("tts_start") < order.index("turn_end"), f"bad ordering: {order}"
    assert order.index("tts_end") < order.index("turn_end"), f"bad ordering: {order}"


class MultiSentenceLLM:
    """Yields a 3-sentence reply token by token to exercise sentence-level
    streaming TTS in the WS layer."""

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        for piece in [
            "Olá",
            ".",
            " ",
            "Como",
            " você",
            " está",
            "?",
            " ",
            "Tudo",
            " bem",
            ".",
        ]:
            yield Token(text=piece, done=False)
        yield Token(text="", done=True)


def test_ws_speak_starts_tts_before_turn_end(tmp_path: Path) -> None:
    """With sentence-level streaming, the first complete sentence should
    trigger tts_start (and at least one binary PCM frame) BEFORE the final
    turn_end is sent. This proves the worker isn't waiting for the whole
    LLM reply before starting synthesis."""
    with TestClient(app) as client:
        store = MemoryStore(tmp_path / "stream.sqlite")
        import asyncio

        asyncio.get_event_loop().run_until_complete(store.ensure_schema())
        app.state.engine = ConversationEngine(MultiSentenceLLM(), store)
        # Each sentence becomes one TTS call → one binary PCM chunk.
        app.state.tts = FakeTTSAdapter([b"\xaa\xbb\xcc\xdd"])

        with client.websocket_connect("/ws/conversation") as ws:
            ws.send_json({"type": "user_message", "content": "fala", "speak": True})

            order: list[str] = []
            binary_count = 0

            for _ in range(60):
                msg = ws.receive()
                if "text" in msg and msg["text"] is not None:
                    import json as _json

                    obj = _json.loads(msg["text"])
                    t = obj.get("type")
                    if t in ("tts_start", "turn_end", "tts_end"):
                        order.append(t)
                    if t == "tts_end":
                        break
                elif "bytes" in msg and msg["bytes"] is not None:
                    binary_count += 1
                    order.append("binary")

    # Critical assertion: tts_start must precede turn_end (proves the worker
    # was synthesizing the first sentence while the LLM was still emitting
    # later tokens). At least one binary frame must also arrive before
    # turn_end (the first sentence's audio).
    assert "tts_start" in order
    assert "turn_end" in order
    assert "tts_end" in order
    assert order.index("tts_start") < order.index("turn_end"), order
    first_binary = order.index("binary") if "binary" in order else -1
    assert first_binary != -1
    assert first_binary < order.index("turn_end"), order
    # Three sentences (Olá. / Como você está? / Tudo bem.) → at least three
    # FakeTTSAdapter calls → at least three binary frames.
    assert binary_count >= 3
