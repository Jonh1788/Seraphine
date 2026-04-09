from __future__ import annotations

import base64
import json
from typing import Any, AsyncIterator

import httpx

from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token


class OllamaClient:
    def __init__(self, base_url: str, model: str, *, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self._client: httpx.AsyncClient = httpx.AsyncClient(
            base_url=self.base_url, timeout=timeout
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        audio: bytes | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[Token]:
        dumped: list[dict[str, Any]] = [m.model_dump() for m in messages]
        if audio is not None and dumped:
            # TODO(phase 2): verify Ollama field name for gemma4 audio input
            # (capabilities advertise 'audio' but exact payload key may differ).
            b64 = base64.b64encode(audio).decode("ascii")
            for i in range(len(dumped) - 1, -1, -1):
                if dumped[i].get("role") == "user":
                    dumped[i]["audio"] = [b64]
                    break
        body = {
            "model": model or self.model,
            "messages": dumped,
            "stream": True,
            "options": {"temperature": temperature},
        }
        if tools is not None:
            body["tools"] = tools
        done_seen = False
        try:
            async with self._client.stream("POST", "/api/chat", json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    text = ""
                    tool_calls: list[dict[str, Any]] | None = None
                    msg = chunk.get("message")
                    if isinstance(msg, dict):
                        text = msg.get("content", "") or ""
                        tc = msg.get("tool_calls")
                        if isinstance(tc, list) and tc:
                            tool_calls = tc
                    done = bool(chunk.get("done", False))
                    if tool_calls is not None:
                        done_seen = True
                        yield Token(text="", done=True, tool_calls=tool_calls)
                        break
                    if done:
                        done_seen = True
                    yield Token(text=text, done=done)
                    if done:
                        break
        except httpx.ConnectError as e:
            raise LLMUnavailableError(str(e)) from e
        except httpx.HTTPError as e:
            raise LLMUnavailableError(str(e)) from e

        if not done_seen:
            yield Token(text="", done=True)
