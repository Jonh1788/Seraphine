from __future__ import annotations

import json
from typing import AsyncIterator

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
    ) -> AsyncIterator[Token]:
        body = {
            "model": model or self.model,
            "messages": [m.model_dump() for m in messages],
            "stream": True,
            "options": {"temperature": temperature},
        }
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
                    msg = chunk.get("message")
                    if isinstance(msg, dict):
                        text = msg.get("content", "") or ""
                    done = bool(chunk.get("done", False))
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
