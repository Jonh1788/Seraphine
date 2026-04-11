"""Anthropic Messages API client.

This adapter mirrors the shape of :class:`OpenAICompatClient` so it can be
plugged into the same callers (``ConversationEngine``, ``AudioEngine``,
``MemoryManager``) without any changes. In particular:

* ``chat()`` yields :class:`Token` objects, terminated by
  ``Token(text="", done=True)`` — same contract as the existing clients.
* Tool calls arrive as ``Token(text="", done=True, tool_calls=[...])``
  where each entry matches the OpenAI-style
  ``{"function": {"name", "arguments": json.dumps(...)}}`` shape the rest
  of the codebase consumes.
* When ``think=True`` the Anthropic ``thinking`` content blocks are wrapped
  in ``<think>...</think>`` delimiters, identical to what
  ``OpenAICompatClient.chat()`` emits from ``reasoning_content``.

httpx is used directly on purpose — we don't depend on the ``anthropic``
SDK, staying consistent with the other clients in this module.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

import httpx

from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token

logger = logging.getLogger("seraphine.anthropic")


_ANTHROPIC_VERSION = "2023-06-01"


def _convert_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Convert OpenAI-shaped tools to Anthropic's ``{name, description, input_schema}``.

    The registry emits ``{"type": "function", "function": {...}}`` — strip the
    outer wrapper and rename ``parameters`` to ``input_schema``. Any already
    Anthropic-shaped entry is passed through unchanged so callers can mix.
    """
    if tools is None:
        return None
    out: list[dict[str, Any]] = []
    for t in tools:
        if "function" in t:
            fn = t["function"]
            out.append(
                {
                    "name": fn.get("name", ""),
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {}) or {"type": "object", "properties": {}},
                }
            )
        elif "name" in t and "input_schema" in t:
            out.append(t)
        else:
            # Best-effort passthrough for unknown shapes
            out.append(t)
    return out


def _convert_content_part(part: dict[str, Any]) -> dict[str, Any]:
    """Convert a single OpenAI-style content part into an Anthropic content block.

    Supported inputs:
      * ``{"type": "text", "text": "..."}`` — passthrough.
      * ``{"type": "image_url", "image_url": {"url": "..."}}`` — converted
        to either a ``{"type": "image", "source": {"type": "base64", ...}}``
        block (for ``data:`` URLs) or a ``{"type": "image", "source":
        {"type": "url", "url": "..."}}`` block.
      * Already-Anthropic ``{"type": "image", "source": {...}}`` — passthrough.
    Unknown parts fall back to a text block with the string repr so nothing
    is silently dropped.
    """
    ptype = part.get("type")
    if ptype == "text":
        return {"type": "text", "text": part.get("text", "")}
    if ptype == "image":
        return part
    if ptype == "image_url":
        url_obj = part.get("image_url") or {}
        url = url_obj.get("url", "") if isinstance(url_obj, dict) else str(url_obj)
        if isinstance(url, str) and url.startswith("data:"):
            # data:image/png;base64,AAAA...
            try:
                header, data = url.split(",", 1)
                # header = "data:image/png;base64"
                media_type = header.split(":", 1)[1].split(";", 1)[0] or "image/png"
            except ValueError:
                media_type = "image/png"
                data = ""
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": data,
                },
            }
        return {
            "type": "image",
            "source": {"type": "url", "url": url},
        }
    return {"type": "text", "text": json.dumps(part)}


def _convert_messages(
    messages: list[ChatMessage],
) -> tuple[str, list[dict[str, Any]]]:
    """Split system messages out and convert the rest into Anthropic's shape.

    * Multiple system messages are concatenated with a blank line between them
      (Anthropic only accepts one top-level ``system`` field).
    * ``role="tool"`` messages are mapped to Anthropic's user-turn
      ``tool_result`` content blocks — they only appear after an assistant
      tool_use so we emit them as the next user turn.
    """
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    tool_use_counter = 0
    for msg in messages:
        content = msg.content
        if msg.role == "system":
            if isinstance(content, str):
                system_parts.append(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        system_parts.append(part.get("text", ""))
            continue
        if msg.role == "tool":
            # Anthropic requires that a tool_result block appears in a
            # user turn that IMMEDIATELY follows an assistant turn
            # containing a matching tool_use block. Our engine stores the
            # tool output as a `role="tool"` ChatMessage without the prior
            # assistant-side tool_use info, so we reconstruct both sides
            # from the stored JSON payload (see engine.run() line ~411).
            tool_name = "unknown_tool"
            tool_args: dict[str, Any] = {}
            tool_output: str = ""
            try:
                body = (
                    json.loads(content) if isinstance(content, str) else content
                )
                if isinstance(body, dict):
                    tool_name = str(body.get("tool") or "unknown_tool")
                    maybe_args = body.get("args")
                    if isinstance(maybe_args, dict):
                        tool_args = maybe_args
                    tool_output = json.dumps(
                        body.get("output")
                        if body.get("output") is not None
                        else body
                    )
                else:
                    tool_output = json.dumps(body)
            except (json.JSONDecodeError, TypeError):
                tool_output = content if isinstance(content, str) else str(content)

            tool_use_id = f"toolu_synth_{tool_use_counter:04d}"
            tool_use_counter += 1

            # Synthetic assistant turn carrying the tool_use block.
            # `input` MUST be the real args that were originally passed —
            # otherwise Claude sees an empty-input call in history, thinks
            # "I didn't give it args, I should retry properly", and loops
            # the same tool call again (up to MAX_TOOL_ITERATIONS). The
            # engine stores the args in the role='tool' payload under
            # "args" specifically for this round-trip.
            out.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": tool_use_id,
                            "name": tool_name,
                            "input": tool_args,
                        }
                    ],
                }
            )
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": tool_output,
                        }
                    ],
                }
            )
            continue
        # user / assistant
        if isinstance(content, str):
            out.append({"role": msg.role, "content": content})
        elif isinstance(content, list):
            blocks = [_convert_content_part(p) for p in content if isinstance(p, dict)]
            out.append({"role": msg.role, "content": blocks})
        else:
            out.append({"role": msg.role, "content": str(content)})
    system = "\n\n".join(s for s in system_parts if s)
    return system, out


class AnthropicClient:
    """Anthropic Messages API client that mirrors the OpenAICompatClient contract."""

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        base_url: str = "https://api.anthropic.com",
        timeout: float = 120.0,
        max_tokens: int = 4096,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_tokens = max_tokens
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers={
                "x-api-key": api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def warmup(self, system_prompt: str = "") -> None:
        """Warmup the connection and prime Anthropic's prompt cache for the
        system prefix. Errors are swallowed — startup must not hinge on this."""
        body: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "oi"}],
            "stream": False,
        }
        if system_prompt:
            body["system"] = system_prompt
        try:
            resp = await self._client.post("/v1/messages", json=body, timeout=120.0)
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
        if audio is not None:
            # The STT path transcribes before the LLM call, so this is a
            # safety net for direct callers.
            raise LLMUnavailableError(
                "Anthropic adapter does not support audio input — transcribe first with whisper"
            )

        system, anth_messages = _convert_messages(messages)
        body: dict[str, Any] = {
            "model": model or self.model,
            "max_tokens": self.max_tokens,
            "messages": anth_messages,
            "stream": True,
            "temperature": temperature,
        }
        # Prompt caching: mark the system prompt and the tools block with
        # cache_control so Anthropic discounts repeat reads by ~90%. Cache
        # lives ~5 minutes per breakpoint; a steady stream of turns within
        # a conversation stays hot. System must be a list of blocks for
        # cache_control to attach to it. Cache on the last tool applies
        # to the entire tools array including everything before it.
        if system:
            body["system"] = [
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ]
        converted_tools = _convert_tools(tools)
        if converted_tools:
            tools_with_cache = [dict(t) for t in converted_tools]
            tools_with_cache[-1]["cache_control"] = {"type": "ephemeral"}
            body["tools"] = tools_with_cache
        if think:
            body["thinking"] = {"type": "enabled", "budget_tokens": 4000}
            # Anthropic rejects non-1.0 temperature when extended thinking is on.
            body["temperature"] = 1.0

        done_seen = False
        in_thinking = False
        # Accumulator for the currently open content block (indexed by block index)
        block_types: dict[int, str] = {}
        tool_use_state: dict[int, dict[str, Any]] = {}

        # 429 retry: Anthropic Tier 1 has tight TPM limits (30K input /
        # 8K output). A single tool-heavy turn can hit them. We open the
        # stream, and if status is 429, close it, wait `retry-after`
        # seconds, and try again. Max 2 retries. On success, we use the
        # already-open response for the rest of the streaming loop.
        # Connection / HTTP errors here propagate out as LLMUnavailable.
        attempt = 0
        max_attempts = 3
        resp = None
        resp_cm = None
        try:
            while True:
                resp_cm = self._client.stream("POST", "/v1/messages", json=body)
                resp = await resp_cm.__aenter__()
                if resp.status_code != 429:
                    break
                retry_after = resp.headers.get("retry-after")
                await resp_cm.__aexit__(None, None, None)
                attempt += 1
                if attempt >= max_attempts:
                    raise LLMUnavailableError(
                        "Anthropic rate-limited (429) after retries. "
                        "Tier 1 limits are 30K input / 8K output tokens "
                        "per minute — consider waiting ~60s or upgrading tier."
                    )
                try:
                    wait_s = float(retry_after) if retry_after else 2.0
                except ValueError:
                    wait_s = 2.0
                wait_s = min(max(wait_s, 0.5), 30.0)
                logger.info(
                    "Anthropic 429 — retrying in %.1fs (attempt %d/%d)",
                    wait_s,
                    attempt,
                    max_attempts,
                )
                await asyncio.sleep(wait_s)
        except httpx.ConnectError as e:
            raise LLMUnavailableError(str(e)) from e
        except httpx.HTTPError as e:
            raise LLMUnavailableError(str(e)) from e

        try:
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                await resp_cm.__aexit__(None, None, None)
                raise LLMUnavailableError(
                    f"Anthropic HTTP {e.response.status_code}"
                ) from e
            try:
                current_event: str | None = None
                async for line in resp.aiter_lines():
                    if not line:
                        current_event = None
                        continue
                    if line.startswith("event: "):
                        current_event = line[7:].strip()
                        continue
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if not data_str:
                        continue
                    try:
                        evt = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    etype = evt.get("type") or current_event
                    if etype == "content_block_start":
                        idx = evt.get("index", 0)
                        block = evt.get("content_block", {}) or {}
                        btype = block.get("type", "")
                        block_types[idx] = btype
                        if btype == "thinking":
                            if not in_thinking:
                                in_thinking = True
                                yield Token(text="<think>", done=False)
                        elif btype == "tool_use":
                            tool_use_state[idx] = {
                                "name": block.get("name", ""),
                                "input_json": "",
                            }
                        elif btype == "text" and in_thinking:
                            in_thinking = False
                            yield Token(text="</think>", done=False)
                    elif etype == "content_block_delta":
                        idx = evt.get("index", 0)
                        delta = evt.get("delta", {}) or {}
                        dtype = delta.get("type", "")
                        if dtype == "text_delta":
                            if in_thinking:
                                # Defensive: shouldn't happen (text_delta only
                                # appears inside text blocks), but close the
                                # thinking tag just in case.
                                in_thinking = False
                                yield Token(text="</think>", done=False)
                            text = delta.get("text", "") or ""
                            if text:
                                yield Token(text=text, done=False)
                        elif dtype == "thinking_delta":
                            if not in_thinking:
                                in_thinking = True
                                yield Token(text="<think>", done=False)
                            thought = delta.get("thinking", "") or ""
                            if thought:
                                yield Token(text=thought, done=False)
                        elif dtype == "input_json_delta":
                            partial = delta.get("partial_json", "") or ""
                            state = tool_use_state.get(idx)
                            if state is not None:
                                state["input_json"] += partial
                        # signature_delta (for thinking signatures) is ignored
                    elif etype == "content_block_stop":
                        idx = evt.get("index", 0)
                        btype = block_types.get(idx, "")
                        if btype == "thinking" and in_thinking:
                            in_thinking = False
                            yield Token(text="</think>", done=False)
                        # tool_use blocks are emitted at message_delta /
                        # message_stop time below, once we know the turn is
                        # actually ending on tool_use.
                    elif etype == "message_delta":
                        delta = evt.get("delta", {}) or {}
                        stop_reason = delta.get("stop_reason")
                        if stop_reason == "tool_use" and tool_use_state:
                            tc_list: list[dict[str, Any]] = []
                            for state in tool_use_state.values():
                                try:
                                    parsed = (
                                        json.loads(state["input_json"])
                                        if state["input_json"]
                                        else {}
                                    )
                                except json.JSONDecodeError:
                                    parsed = {}
                                tc_list.append(
                                    {
                                        "function": {
                                            "name": state["name"],
                                            "arguments": json.dumps(parsed),
                                        }
                                    }
                                )
                            if in_thinking:
                                yield Token(text="</think>", done=False)
                                in_thinking = False
                            done_seen = True
                            yield Token(text="", done=True, tool_calls=tc_list)
                            return
                    elif etype == "message_stop":
                        if in_thinking:
                            yield Token(text="</think>", done=False)
                            in_thinking = False
                        done_seen = True
                        yield Token(text="", done=True)
                        return
                    elif etype == "error":
                        err = evt.get("error", {}) or {}
                        raise LLMUnavailableError(
                            err.get("message", "anthropic stream error")
                        )
            finally:
                # Always release the streaming response (esp. on early
                # return via message_stop / stop_reason=tool_use).
                await resp_cm.__aexit__(None, None, None)
        except httpx.ConnectError as e:
            raise LLMUnavailableError(str(e)) from e
        except httpx.HTTPError as e:
            raise LLMUnavailableError(str(e)) from e

        if not done_seen:
            yield Token(text="", done=True)
