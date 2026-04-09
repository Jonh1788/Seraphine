from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from seraphine.conversation.audio_engine import AudioEngine
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
        audio: bytes | None = None,
    ) -> AsyncIterator[Token]:
        yield Token(text="hi", done=False)
        yield Token(text="", done=True)


def test_ws_audio_round_trip(tmp_path: Path) -> None:
    with TestClient(app) as client:
        store = MemoryStore(tmp_path / "ws_audio.sqlite")
        asyncio.get_event_loop().run_until_complete(store.ensure_schema())
        client.app.state.audio_engine = AudioEngine(
            FakeLLM(), FakeTTSAdapter([b"\x00\x01"]), store
        )

        with client.websocket_connect("/ws/conversation") as ws:
            ws.send_json({"type": "audio_start", "sample_rate": 16000})
            ws.send_bytes(b"\x00" * 320)
            ws.send_json({"type": "audio_end"})

            binary_frames: list[bytes] = []
            json_frames: list[dict] = []
            while True:
                msg = ws.receive()
                if "bytes" in msg and msg["bytes"] is not None:
                    binary_frames.append(msg["bytes"])
                elif "text" in msg and msg["text"] is not None:
                    import json as _json

                    parsed = _json.loads(msg["text"])
                    json_frames.append(parsed)
                    if parsed.get("type") == "tts_end":
                        break

    assert len(binary_frames) >= 1
    assert any(f.get("type") == "tts_end" for f in json_frames)
