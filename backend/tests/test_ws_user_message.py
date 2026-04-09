from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator

from fastapi.testclient import TestClient

from seraphine.conversation.engine import ConversationEngine
from seraphine.llm.types import ChatMessage, Token
from seraphine.main import app
from seraphine.memory.store import MemoryStore
from seraphine.tts.moss import FakeTTSAdapter


class FakeLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
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
    """When `speak: true` is sent, the WS layer should follow turn_end with
    tts_start, one or more binary PCM frames, and tts_end."""
    with TestClient(app) as client:
        store = MemoryStore(tmp_path / "speak.sqlite")
        import asyncio

        asyncio.get_event_loop().run_until_complete(store.ensure_schema())
        app.state.engine = ConversationEngine(FakeLLM(), store)
        app.state.tts = FakeTTSAdapter([b"\x00\x01\x02\x03", b"\x04\x05"])

        with client.websocket_connect("/ws/conversation") as ws:
            ws.send_json({"type": "user_message", "content": "oi", "speak": True})

            saw_turn_end = False
            saw_tts_start = False
            saw_tts_end = False
            binary_frames = 0
            tts_turn_id: str | None = None

            for _ in range(20):
                msg = ws.receive()
                if "text" in msg and msg["text"] is not None:
                    import json as _json

                    obj = _json.loads(msg["text"])
                    t = obj.get("type")
                    if t == "turn_end":
                        saw_turn_end = True
                        tts_turn_id = obj.get("turn_id")
                    elif t == "tts_start":
                        saw_tts_start = True
                        assert obj.get("turn_id") == tts_turn_id
                        assert obj.get("sample_rate") == 24000
                    elif t == "tts_end":
                        saw_tts_end = True
                        assert obj.get("turn_id") == tts_turn_id
                        break
                elif "bytes" in msg and msg["bytes"] is not None:
                    binary_frames += 1

    assert saw_turn_end and saw_tts_start and saw_tts_end
    assert binary_frames >= 1
