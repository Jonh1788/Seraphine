from __future__ import annotations

import json
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
