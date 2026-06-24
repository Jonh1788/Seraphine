from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx

OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def _or_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://app.minha-aura.com",
        "X-Title": "Seraphine Deepsearch",
    }


def _parse_json_object(raw: str) -> dict:
    """Best-effort parse of a JSON object out of an LLM completion.

    Tries a strict parse of the whole string first, then a balanced-brace scan
    from the first ``{``. Never raises — returns ``{}`` on any failure.
    """
    if not raw:
        return {}
    text = raw.strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except (json.JSONDecodeError, ValueError):
        pass
    start = text.find("{")
    if start == -1:
        return {}
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start : i + 1])
                except (json.JSONDecodeError, ValueError):
                    return {}
                return obj if isinstance(obj, dict) else {}
    return {}


class OpenRouterClient:
    def __init__(self, api_key: str, *, timeout: float = 120.0) -> None:
        self.api_key = api_key
        self.timeout = timeout

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        response_format: dict | None = None,
    ) -> str:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format is not None:
            body["response_format"] = response_format
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json=body,
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"] or ""

    async def stream(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "stream": True,
                },
            ) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        # Partial / non-JSON frame — skip, keep the stream alive.
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        # Usage-only / empty-choices chunk — nothing to yield.
                        continue
                    try:
                        delta = choices[0].get("delta") or {}
                    except (IndexError, KeyError, AttributeError):
                        continue
                    content = delta.get("content")
                    if content:
                        yield content

    async def list_models(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{OPENROUTER_BASE}/models", headers=_or_headers(self.api_key))
            r.raise_for_status()
            return [
                {"id": m["id"], "name": m.get("name", m["id"])}
                for m in r.json().get("data", [])
            ]


def _stringify_content(content: Any) -> str:
    """Coerce a ``ChatMessage.content`` into a plain string for OpenRouter.

    OpenRouter's chat endpoint accepts string content (or a typed block list,
    but we keep it simple). When the engine hands us a vision-style block list
    (``[{"type":"text","text":..}, {"type":"image_url",..}]``), concatenate the
    text blocks and drop the rest — images are not forwarded on the OpenRouter
    chat path for v1.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return str(content or "")


class OpenRouterChatClient:
    """OpenRouter chat client matching the engine's ``llm.chat`` contract.

    Streams an OpenAI-compatible chat completion and yields ``Token`` objects
    exactly like the cliproxy ``AnthropicClient.chat`` the engine normally uses:
    text deltas stream as ``Token(text=...)`` and any tool calls are emitted as a
    single terminal ``Token(done=True, tool_calls=[...])`` in OpenAI function
    shape (directly consumable by the engine's ``_parse_tool_call``).
    """

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 180.0,
        telemetry: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.api_key = api_key
        self.timeout = timeout
        # Optional per-call usage sink (default None → no-op). Same opt-in
        # contract as AnthropicClient.
        self._telemetry = telemetry

    def _emit_usage(self, model: str, usage: dict[str, Any]) -> None:
        """Forward OpenRouter usage to the optional sink. Never raises."""
        if self._telemetry is None:
            return
        try:
            self._telemetry(
                {
                    "backend": "openrouter",
                    "model": model,
                    "input_tokens": int(usage.get("prompt_tokens") or 0),
                    "output_tokens": int(usage.get("completion_tokens") or 0),
                }
            )
        except Exception:
            pass

    async def chat(
        self,
        messages: list[Any],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        audio: Any = None,
        tools: list[dict] | None = None,
        think: bool = False,
    ) -> AsyncIterator[Any]:
        # Imported lazily so this module stays importable without the package.
        from llm_adapters.types import Token

        # ``audio`` and ``think`` are intentionally ignored for v1 — we don't
        # forward reasoning/audio params; keep the request minimal and portable.
        oai_messages = [
            {"role": m.role, "content": _stringify_content(m.content)}
            for m in messages
        ]
        body: dict[str, Any] = {
            "model": model or "openai/gpt-4o-mini",
            "messages": oai_messages,
            "temperature": temperature,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        # Ask OpenRouter to append a final usage frame to the stream so we can
        # record token counts. Only requested when a telemetry sink is present
        # — otherwise the request stays byte-for-byte identical to before.
        if self._telemetry is not None:
            body["usage"] = {"include": True}

        # index -> accumulated tool call ({"id","name","arguments"}).
        acc: dict[int, dict[str, str]] = {}
        usage: dict[str, Any] = {}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json=body,
            ) as r:
                if r.status_code != 200:
                    raw = (await r.aread()).decode("utf-8", "replace")
                    raise RuntimeError(
                        f"OpenRouter chat failed: {r.status_code} {raw[:500]}"
                    )
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data:"):
                        # SSE comments (": ...") / blank keepalive lines.
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    # Usage may ride on its own (usually empty-choices) frame.
                    if obj.get("usage"):
                        usage = obj["usage"]
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    try:
                        delta = choices[0].get("delta") or {}
                    except (IndexError, KeyError, AttributeError):
                        continue
                    content = delta.get("content")
                    if content:
                        yield Token(text=content)
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index", 0)
                        slot = acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                        if fn.get("arguments"):
                            slot["arguments"] += fn["arguments"]

        self._emit_usage(model or "openai/gpt-4o-mini", usage)

        if acc:
            tool_calls = [
                {
                    "id": slot["id"] or f"call_{idx}",
                    "type": "function",
                    "function": {
                        "name": slot["name"],
                        "arguments": slot["arguments"] or "{}",
                    },
                }
                for idx, slot in sorted(acc.items())
            ]
            yield Token(text="", done=True, tool_calls=tool_calls)
        else:
            yield Token(text="", done=True)


CLIPROXY_DEFAULT = "cliproxy:claude-haiku-4-5-20251001"


@dataclass
class RoleLLM:
    provider: str  # "cliproxy" | "openrouter"
    model: str
    _app_llm: Any = None  # AnthropicClient when cliproxy
    _or: Any = None  # OpenRouterClient when openrouter

    async def complete(
        self, messages: list[dict[str, str]], *, max_tokens: int = 4096
    ) -> str:
        if self.provider == "openrouter":
            return await self._or.complete(messages, model=self.model, max_tokens=max_tokens)
        # cliproxy: collapse to a single chat() pass, accumulate tokens
        from llm_adapters.types import ChatMessage

        chat_msgs = [ChatMessage(role=m["role"], content=m["content"]) for m in messages]
        out = []
        async for tok in self._app_llm.chat(chat_msgs, model=self.model):
            if tok.text:
                out.append(tok.text)
        return "".join(out)

    async def complete_json(self, *, system: str, user: str, tool: dict) -> dict:
        if self.provider == "openrouter":
            # Ask for raw JSON in the prompt (+ request the json_object response
            # format), then parse defensively — never raise on a malformed reply.
            try:
                raw = await self._or.complete(
                    [
                        {
                            "role": "system",
                            "content": system + "\nResponda SOMENTE com JSON válido.",
                        },
                        {"role": "user", "content": user},
                    ],
                    model=self.model,
                    max_tokens=1024,
                    response_format={"type": "json_object"},
                )
            except Exception:
                return {}
            return _parse_json_object(raw)
        return await self._app_llm.tool_call_json(
            system=system, user=user, tool=tool, model=self.model
        )

    async def stream(
        self, messages: list[dict[str, str]], *, max_tokens: int = 8192
    ) -> AsyncIterator[str]:
        if self.provider == "openrouter":
            async for chunk in self._or.stream(
                messages, model=self.model, max_tokens=max_tokens
            ):
                yield chunk
            return
        from llm_adapters.types import ChatMessage

        chat_msgs = [ChatMessage(role=m["role"], content=m["content"]) for m in messages]
        async for tok in self._app_llm.chat(chat_msgs, model=self.model):
            if tok.text:
                yield tok.text


def resolve_role_model(spec: str, *, app_llm: Any, openrouter_key: str) -> RoleLLM:
    provider, _, model = spec.partition(":")
    if provider == "openrouter":
        if not openrouter_key:
            # fall back to cliproxy default — never hard-fail a run on a missing key
            cp_model = CLIPROXY_DEFAULT.split(":", 1)[1]
            return RoleLLM(provider="cliproxy", model=cp_model, _app_llm=app_llm)
        return RoleLLM(
            provider="openrouter", model=model, _or=OpenRouterClient(openrouter_key)
        )
    return RoleLLM(provider="cliproxy", model=model, _app_llm=app_llm)
