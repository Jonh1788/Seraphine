from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator

from fastapi.testclient import TestClient

from seraphine.conversation.engine import ConversationEngine
from seraphine.llm.types import ChatMessage, Token
from seraphine.main import app
from seraphine.memory.store import MemoryStore


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
