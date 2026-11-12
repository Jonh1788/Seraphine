"""Chat runtime: conversation only (no files, no commands).

One streamed OpenAI-compatible ``POST {base_url}/chat/completions`` against
the provider chosen for the agent (OpenRouter, DeepSeek, Kimi, xAI, Gemini,
Groq, Ollama, LM Studio, owner-defined extras...). The repo's
``llm_adapters.OpenAICompatClient`` was not reused: it hardcodes ``/v1``, has no
API-key header and does not report token usage.

The API key is read from the backend environment by variable NAME
(``providers.read_env``) and travels only in the ``Authorization`` header: it is
never put in argv, events, errors or logs. The transcript of every session is
persisted (``agent_chat_transcripts``) so ``resume`` survives a restart.

``ollama`` is the legacy name of this runtime (stored rows / API).

Park instead of fail (phase 1b): HTTP 429 and 5xx, an error chunk with such a code
or "overloaded" / rate-limit wording, and transport failures (timeouts, connection
errors, a dropped stream) are outages; a missing key or HTTP 401/403 is ``auth``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx

from seraphine.agents.engines.base import (
    SESSION_NOT_FOUND, EngineContext, EngineResult, OnEvent, clip,
)
from seraphine.agents.engines.classify import (
    AUTH, OUTAGE, Failure, chat_outage_text, outage_from_status,
)
from seraphine.agents.providers import read_env, redact

#: Transport failures that mean "the provider could not be reached / dropped us".
_OUTAGE_EXCEPTIONS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
from seraphine.agents.transcripts import MemoryTranscripts


class ChatEngine:
    name = "chat"
    can_act = False
    #: The transcript is saved only when a turn completes, so a turn cut by a
    #: restart has nothing to resume.
    resumable_after_restart = False
    #: A finished run's transcript is kept (SQLite), so a later run can resume it.
    resumable_across_runs = True

    def __init__(self, transcripts: Any = None, timeout_s: float = 600.0) -> None:
        self.transcripts = transcripts if transcripts is not None else MemoryTranscripts()
        self.timeout_s = timeout_s

    def available(self) -> tuple[bool, str]:
        # Per-provider readiness (key present / local server up) is checked by
        # the service through the provider registry.
        return True, "somente conversa: sem acesso a arquivos nem a comandos"

    async def run(
        self, ctx: EngineContext, on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        session = uuid.uuid4().hex
        await on_event("_session", {"session_ref": session})
        messages = [{"role": "user", "content": ctx.prompt}]
        return await self._chat(session, messages, ctx, on_event, cancel)

    async def resume(
        self, ctx: EngineContext, session_ref: str, message: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        history = await self.transcripts.load(session_ref)
        if history is None:
            return EngineResult(error="a conversa anterior não foi encontrada; inicie uma nova execução",
                                error_code=SESSION_NOT_FOUND)
        messages = [*history, {"role": "user", "content": message}]
        return await self._chat(session_ref, messages, ctx, on_event, cancel)

    async def _chat(
        self, session: str, messages: list[dict[str, str]], ctx: EngineContext,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        provider = ctx.provider
        if provider is None or not getattr(provider, "base_url", None):
            return EngineResult(session_ref=session, error="o provedor não tem endereço para conversar")
        model = ctx.model or getattr(provider, "default_model", None)
        if not model:
            return EngineResult(
                session_ref=session,
                error=f"informe o modelo para {provider.label} (não há modelo padrão)")
        key = read_env(provider.env_key) if provider.env_key else ""
        if provider.kind == "api_key" and not key:
            return EngineResult(
                session_ref=session, error_code="provider_unavailable", wait_kind=AUTH,
                error=f"falta a chave {provider.env_key} no .env do backend")
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        url = f"{provider.base_url.rstrip('/')}/chat/completions"
        body: dict[str, Any] = {
            "model": model, "messages": messages, "stream": True,
            "stream_options": {"include_usage": True},
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout_s, connect=10.0)) as client:
                outcome = await self._stream(client, url, headers, body, cancel)
                if outcome.get("retry_without_usage"):
                    body.pop("stream_options", None)
                    outcome = await self._stream(client, url, headers, body, cancel)
        except httpx.HTTPError as exc:
            return EngineResult(
                session_ref=session,
                error=redact(f"falha ao falar com {provider.label}: {exc}", key),
                wait_kind=OUTAGE if isinstance(exc, _OUTAGE_EXCEPTIONS) else None)

        if outcome.get("error"):
            wait: Failure | None = outcome.get("wait")
            return EngineResult(
                session_ref=session, error=redact(outcome["error"], key),
                error_code=outcome.get("code"), wait_kind=wait.kind if wait else None)
        result = EngineResult(
            session_ref=session, tokens_in=outcome["tokens_in"], tokens_out=outcome["tokens_out"],
            last_input_tokens=outcome["tokens_in"] or None)
        text = "".join(outcome["chunks"]).strip()
        if cancel.is_set():
            result.final_message = text
            return result
        if not text:
            result.error = f"{provider.label} terminou sem enviar uma resposta"
            return result
        result.final_message = text
        result.exit_code = 0
        await on_event("message", {"text": clip(text, 4000)})
        await self.transcripts.save(
            session, provider.id, [*messages, {"role": "assistant", "content": text}])
        return result

    async def _stream(
        self, client: httpx.AsyncClient, url: str, headers: dict[str, str],
        body: dict[str, Any], cancel: asyncio.Event,
    ) -> dict[str, Any]:
        chunks: list[str] = []
        tokens_in = tokens_out = 0
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code != 200:
                text = (await resp.aread()).decode("utf-8", "replace")
                if resp.status_code in (400, 422) and "stream_options" in body and (
                        "stream_options" in text or "include_usage" in text):
                    return {"retry_without_usage": True}
                if resp.status_code in (401, 403):
                    return {"error": f"o provedor recusou a chave (HTTP {resp.status_code})",
                            "code": "engine_auth"}
                return {"error": f"o provedor respondeu {resp.status_code}: {text[:300]}",
                        "wait": outage_from_status(resp.status_code)}
            async for line in resp.aiter_lines():
                if cancel.is_set():
                    break
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue
                if not isinstance(chunk, dict):
                    continue
                if chunk.get("error"):
                    err = chunk["error"]
                    msg = err.get("message") if isinstance(err, dict) else str(err)
                    code = err.get("code") if isinstance(err, dict) else None
                    wait = (outage_from_status(int(code)) if str(code).isdigit() else None) \
                        or chat_outage_text(str(msg))
                    return {"error": f"o provedor devolveu um erro: {str(msg)[:300]}", "wait": wait}
                usage = chunk.get("usage")
                if isinstance(usage, dict):
                    tokens_in = int(usage.get("prompt_tokens") or tokens_in)
                    tokens_out = int(usage.get("completion_tokens") or tokens_out)
                for choice in chunk.get("choices") or []:
                    piece = (choice.get("delta") or {}).get("content")
                    if isinstance(piece, str) and piece:
                        chunks.append(piece)
        return {"chunks": chunks, "tokens_in": tokens_in, "tokens_out": tokens_out}
