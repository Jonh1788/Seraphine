"""A shared engine reference so all Seraphine services follow the selection."""
from __future__ import annotations

import asyncio
from typing import Any

from llm_adapters.types import LLMUnavailableError
from seraphine.llm.factory import build_engine


class SelectableEngine:
    def __init__(self, settings: Any, *, telemetry=None):
        self.settings = settings
        self.telemetry = telemetry
        self._engine, self.info = build_engine(settings, telemetry=telemetry)
        self._retired: list[Any] = []
        self._lock = asyncio.Lock()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._engine, name)

    async def chat(self, *args, **kwargs):
        # A switch cannot change an in-flight response or close its transport.
        engine = self._engine
        async for token in engine.chat(*args, **kwargs):
            yield token

    @property
    def selection(self) -> str:
        backend = self.settings.llm_backend
        return "claude" if backend in ("anthropic", "claude_max") else backend

    async def select(self, selection: str, store: Any, *, persist: bool = True) -> None:
        if selection not in ("ollama", "claude", "codex"):
            raise ValueError("Cérebro desconhecido.")
        async with self._lock:
            if selection == self.selection:
                if persist:
                    await store.set_kv("llm_backend", selection)
                    await store.delete_kv("chat_model")
                return
            backend = "anthropic" if selection == "claude" else selection
            if selection == "claude" and not self.settings.anthropic_api_key:
                raise LLMUnavailableError("Configure a conexão com o Claude antes de selecioná-lo.")
            config = self.settings.model_copy(update={"llm_backend": backend})
            candidate, info = build_engine(config, telemetry=self.telemetry)
            try:
                if selection == "codex":
                    await candidate.check_available()
                if persist:
                    await store.set_kv("llm_backend", selection)
                    # An explicit brain selection supersedes an older model override.
                    await store.delete_kv("chat_model")
            except BaseException:
                await candidate.aclose()
                raise
            self._retired.append(self._engine)
            self._engine = candidate
            self.info = info
            self.settings.llm_backend = backend

    async def aclose(self) -> None:
        for engine in [self._engine, *self._retired]:
            await engine.aclose()
