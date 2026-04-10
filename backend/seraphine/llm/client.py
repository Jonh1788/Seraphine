from __future__ import annotations

import base64
import json
from typing import Any, AsyncIterator

import httpx

from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token


class OpenAICompatClient:
    """Client for OpenAI-compatible APIs (vMLX, LM Studio, etc).
    Uses /v1/chat/completions with SSE streaming."""

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def warmup(self) -> None:
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": "."}],
            "stream": False,
            "max_tokens": 1,
        }
        try:
            resp = await self._client.post("/v1/chat/completions", json=body, timeout=60.0)
            resp.raise_for_status()
        except (httpx.HTTPError, httpx.ConnectError):
            pass

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        audio: bytes | None = None,
        tools: list[dict[str, Any]] | None = None,
        think: bool = False,
    ) -> AsyncIterator[Token]:
        dumped = [m.model_dump() for m in messages]
        body: dict[str, Any] = {
            "model": model or self.model,
            "messages": dumped,
            "stream": True,
            "temperature": temperature,
        }
        if tools is not None:
            body["tools"] = tools
        # vMLX reasoning parser support
        if think:
            body["enable_thinking"] = True
        done_seen = False
        try:
            async with self._client.stream("POST", "/v1/chat/completions", json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        done_seen = True
                        yield Token(text="", done=True)
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    text = delta.get("content", "") or ""
                    finish = choices[0].get("finish_reason")
                    tool_calls_delta = delta.get("tool_calls")
                    if tool_calls_delta:
                        # Accumulate tool call data
                        tc_list = []
                        for tc in tool_calls_delta:
                            fn = tc.get("function", {})
                            tc_list.append({
                                "function": {
                                    "name": fn.get("name", ""),
                                    "arguments": fn.get("arguments", "{}"),
                                }
                            })
                        if tc_list:
                            done_seen = True
                            yield Token(text="", done=True, tool_calls=tc_list)
                            break
                    done = finish is not None
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


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout: float = 120.0,
        num_batch: int = 2048,
        keep_alive: str | int = -1,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.num_batch = num_batch
        self.keep_alive = keep_alive
        self._client: httpx.AsyncClient = httpx.AsyncClient(
            base_url=self.base_url, timeout=timeout
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def warmup(self) -> None:
        """Prime the model on the server: one dummy request at startup so
        the first real user message doesn't pay the cold-load cost
        (~4.5 s for gemma4:e4b on Apple Silicon). Also primes the prefix
        cache for the default system prompt. Errors are swallowed because
        the backend should start even if Ollama is momentarily down."""
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": "."}],
            "stream": False,
            "keep_alive": self.keep_alive,
            "options": {"num_predict": 1, "num_batch": self.num_batch},
        }
        try:
            resp = await self._client.post("/api/chat", json=body, timeout=60.0)
            resp.raise_for_status()
        except (httpx.HTTPError, httpx.ConnectError):
            pass

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        audio: bytes | None = None,
        tools: list[dict[str, Any]] | None = None,
        think: bool = False,
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
        body: dict[str, Any] = {
            "model": model or self.model,
            "messages": dumped,
            "stream": True,
            "keep_alive": self.keep_alive,
            # gemma4 has `thinking` capability — if the model decides to
            # enter reasoning mode, it will emit N tokens of hidden thought
            # BEFORE the first visible content token. For an interactive
            # voice agent that's a latency killer (we saw a 4.2 s outlier
            # in benchmarking). Disable by default; callers that want
            # reasoning for complex tasks can flip this per-request later.
            "think": think,
            "options": {
                "temperature": temperature,
                "num_batch": self.num_batch,
            },
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
