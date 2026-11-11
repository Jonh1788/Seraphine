from __future__ import annotations

import base64
import json
from typing import Any, AsyncIterator

import httpx

from llm_adapters.types import ChatMessage, LLMUnavailableError, Token


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

    async def warmup(self, system_prompt: str = "") -> None:
        """Warmup that populates the prefix cache with the real Seraphine
        system prompt. This makes the FIRST user request nearly as fast
        as subsequent ones (both hit the cache for the system prefix)."""
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": "oi"})
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "max_tokens": 1,
        }
        try:
            resp = await self._client.post("/v1/chat/completions", json=body, timeout=120.0)
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
            # Thinking mode at 5bit is prone to self-talk loops
            # ("Wait, I'll call X. Actually, I'll call X..."). Tighten
            # sampling and bump rep penalty per-request to break loops
            # before they exhaust the thinking budget. These override
            # vMLX defaults only for this single request.
            body["top_p"] = 0.9
            body["top_k"] = 40
            body["repetition_penalty"] = 1.15
        done_seen = False
        in_thinking = False
        try:
            async with self._client.stream("POST", "/v1/chat/completions", json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        # Close thinking tag if still open
                        if in_thinking:
                            yield Token(text="</think>", done=False)
                            in_thinking = False
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
                    reasoning = delta.get("reasoning_content", "") or ""
                    finish = choices[0].get("finish_reason")

                    # Wrap reasoning_content in <think> tags so the
                    # frontend can display it in a collapsible block.
                    if reasoning:
                        if not in_thinking:
                            in_thinking = True
                            yield Token(text="<think>", done=False)
                        yield Token(text=reasoning, done=False)
                        continue
                    if in_thinking and text:
                        # Thinking ended, regular content starting
                        in_thinking = False
                        yield Token(text="</think>", done=False)
                    tool_calls_delta = delta.get("tool_calls")
                    if tool_calls_delta:
                        # Standard OpenAI tool call format
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


def _parse_gemma_tool_call(buf: str) -> list[dict[str, Any]] | None:
    """Parse Gemma 4's native tool call format:
        <|tool_call>call:NAMESPACE:FUNCTION{ARG_KEY: VALUE, ...}<tool_call|>

    Examples:
        <|tool_call>call:google:web_search{queries: ["clima sao paulo"]}<tool_call|>
        <|tool_call>call:web_search{query: "test"}<tool_call|>

    Returns a list of OpenAI-style tool call dicts, or None if parsing fails.
    """
    import re

    # Extract content between markers
    m = re.search(r"<\|tool_call>(.*?)<tool_call\|>", buf, re.DOTALL)
    if not m:
        return None
    inner = m.group(1).strip()

    # Strip "call:" prefix and optional namespace (e.g. "google:")
    if inner.startswith("call:"):
        inner = inner[5:]
    # Remove namespace prefix if present (e.g. "google:web_search" -> "web_search")
    name_match = re.match(r"(?:[a-zA-Z_][a-zA-Z0-9_]*:)*([a-zA-Z_][a-zA-Z0-9_]*)\s*\{", inner)
    if not name_match:
        return None
    name = name_match.group(1)
    args_str = inner[name_match.end() - 1:]  # include the opening {

    # Find matching closing brace
    depth = 0
    end_idx = -1
    for i, ch in enumerate(args_str):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end_idx = i
                break
    if end_idx == -1:
        return None
    args_body = args_str[1:end_idx]  # strip outer {}

    # Parse the args — Gemma uses Python-ish syntax (key: value with single
    # or unquoted keys, sometimes lists with brackets). We try JSON first,
    # then a tolerant parse.
    args_dict: dict[str, Any] = {}
    try:
        # Try as JSON object
        args_dict = json.loads("{" + args_body + "}")
    except json.JSONDecodeError:
        # Tolerant parse: convert keys to quoted strings
        # "queries: [\"foo\"]" -> "\"queries\": [\"foo\"]"
        try:
            fixed = re.sub(r'(\w+)\s*:', r'"\1":', args_body)
            args_dict = json.loads("{" + fixed + "}")
        except json.JSONDecodeError:
            # Last resort: extract first string value as the only argument
            str_match = re.search(r'"([^"]+)"', args_body)
            if str_match:
                # Guess the param name based on common conventions
                key_match = re.match(r'(\w+)', args_body)
                key = key_match.group(1) if key_match else "query"
                args_dict = {key: str_match.group(1)}
            else:
                return None

    # Some Gemma tools use plural names ("queries", "urls"). Normalize
    # to singular if the value is a 1-element list.
    _PLURAL_MAP = {
        "queries": "query",
        "urls": "url",
        "ids": "id",
        "names": "name",
        "paths": "path",
    }
    normalized: dict[str, Any] = {}
    for k, v in args_dict.items():
        if isinstance(v, list) and len(v) == 1:
            singular = _PLURAL_MAP.get(k, k[:-1] if k.endswith("s") and not k.endswith("ss") else k)
            normalized[singular] = v[0]
        else:
            normalized[k] = v

    return [{
        "function": {
            "name": name,
            "arguments": json.dumps(normalized),
        }
    }]


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout: float = 120.0,
        num_batch: int = 2048,
        num_ctx: int | None = None,
        keep_alive: str | int = -1,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.num_batch = num_batch
        self.num_ctx = num_ctx
        self.keep_alive = keep_alive
        self._client: httpx.AsyncClient = httpx.AsyncClient(
            base_url=self.base_url, timeout=timeout
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def warmup(self, system_prompt: str = "") -> None:
        """Prime the model on the server: one dummy request at startup so
        the first real user message doesn't pay the cold-load cost
        (~4.5 s for gemma4:e4b on Apple Silicon). Also primes the prefix
        cache for the default system prompt. Errors are swallowed because
        the backend should start even if Ollama is momentarily down."""
        body = {
            "model": self.model,
            "messages": (
                ([{"role": "system", "content": system_prompt}] if system_prompt else [])
                + [{"role": "user", "content": "."}]
            ),
            "stream": False,
            "think": False,
            "keep_alive": self.keep_alive,
            "options": {"num_predict": 1, "num_batch": self.num_batch},
        }
        if self.num_ctx is not None:
            body["options"]["num_ctx"] = self.num_ctx
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
        if self.num_ctx is not None:
            body["options"]["num_ctx"] = self.num_ctx
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
