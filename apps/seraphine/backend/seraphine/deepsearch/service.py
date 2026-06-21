"""DeepSearchService -- orchestrates Deep Research runs (engine + persistence).

Constructed in the app lifespan with ``(store, llm, tools, settings)``:
  - ``store``    -- the shared ``MemoryStore`` (core_db ``Store``); queried via
                    the sync ``store._connect()`` context manager inside a
                    ``def _work()`` dispatched through ``asyncio.to_thread`` —
                    the same pattern mood/journal/insights services use.
  - ``llm``      -- the cliproxy ``AnthropicClient`` (``app.state.llm``).
  - ``tools``    -- the live ``ToolRegistry``; the engine pulls the web tools
                    (``web_search`` / ``web_fetch`` / ``search_news``) via
                    ``tools.get(name)``.
  - ``settings`` -- the app ``settings`` object.

Milestone 1 implements only ``get_config``; later milestones add
``start_run`` / ``subscribe`` / ``list_runs`` / ``set_config`` / etc.
"""

from __future__ import annotations

import asyncio
from typing import Any


class DeepSearchService:
    def __init__(self, store: Any, llm: Any, tools: Any, settings: Any) -> None:
        self.store = store
        self.llm = llm
        self.tools = tools
        self.settings = settings

    async def get_config(self) -> dict[str, Any]:
        """Return the per-role model config (single row, id=1).

        The OpenRouter key is never returned — only whether one is set.
        """

        def _work() -> tuple[str, str, str]:
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT fanout_model, synth_model, openrouter_key"
                    " FROM deepsearch_config WHERE id = 1"
                ).fetchone()
            if row is None:
                # Defensive: the migrator seeds id=1, but never assume.
                return (
                    "cliproxy:claude-haiku-4-5-20251001",
                    "cliproxy:claude-opus-4-8",
                    "",
                )
            return (row[0], row[1], row[2])

        fanout_model, synth_model, openrouter_key = await asyncio.to_thread(_work)
        return {
            "fanout_model": fanout_model,
            "synth_model": synth_model,
            "openrouter_key_set": bool(openrouter_key),
        }
