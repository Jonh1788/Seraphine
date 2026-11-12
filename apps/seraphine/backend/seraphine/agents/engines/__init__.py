"""Agent runtimes registry."""

from __future__ import annotations

from typing import Any

from seraphine.agents.engines.base import Engine
from seraphine.agents.engines.chat import ChatEngine
from seraphine.agents.engines.claude_code import ClaudeCodeEngine
from seraphine.agents.engines.codex import CodexEngine
from seraphine.agents.providers import build_catalog, child_env
from seraphine.agents.transcripts import MemoryTranscripts, SqliteTranscripts


def get_engines(settings: Any, store: Any = None) -> dict[str, Engine]:
    """Build the production runtimes from the app settings.

    ``store`` (the memory store) persists chat transcripts; without it they
    live in memory only.
    """
    catalog = build_catalog(settings)

    def env() -> dict[str, str]:  # children never see other providers' API keys
        return child_env(catalog)

    engines: list[Engine] = [
        CodexEngine(
            executable=getattr(settings, "codex_executable", "codex") or "codex",
            windows_sandbox=getattr(settings, "agents_codex_windows_sandbox", "unelevated") or "unelevated",
            env_factory=env,
        ),
        ClaudeCodeEngine(
            executable=getattr(settings, "agents_claude_path", "") or "", env_factory=env),
        ChatEngine(SqliteTranscripts(store) if store is not None else MemoryTranscripts()),
    ]
    return {e.name: e for e in engines}
