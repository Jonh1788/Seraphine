from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx

OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def _or_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://app.minha-aura.com",
        "X-Title": "Seraphine Deepsearch",
    }


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
    ) -> str:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
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
                    if not data or data == "[DONE]" or not data.startswith("{"):
                        continue
                    delta = json.loads(data)["choices"][0].get("delta", {})
                    if delta.get("content"):
                        yield delta["content"]

    async def list_models(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{OPENROUTER_BASE}/models", headers=_or_headers(self.api_key))
            r.raise_for_status()
            return [
                {"id": m["id"], "name": m.get("name", m["id"])}
                for m in r.json().get("data", [])
            ]


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
            # ask for raw JSON in the prompt; parse defensively
            import json
            import re

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
            )
            m = re.search(r"\{.*\}", raw, re.S)
            return json.loads(m.group(0)) if m else {}
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
