"""067 — Flashcards tool (deck creation + review surfacing)."""

from __future__ import annotations

from typing import Any

from seraphine.flashcards.service import FlashcardsService
from seraphine.tools.base import Tool, ToolResult


class CreateDeckTool(Tool):
    name = "flashcard_create_deck"
    description = (
        "Generate a spaced-repetition deck for a topic the user wants to "
        "learn. Creates flashcards in the DB; they'll surface via "
        "bubbles/openers when due. Use when he says 'quero aprender X', "
        "'me ensina Y', 'cria cards sobre Z'."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "topic": {"type": "string"},
            "count": {"type": "integer", "minimum": 3, "maximum": 20},
        },
        "required": ["topic"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, store: Any, llm: Any) -> None:
        self.store = store
        self.llm = llm

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        topic = str(args.get("topic", "")).strip()
        count = int(args.get("count") or 10)
        cards = await FlashcardsService(self.store, self.llm).create_deck(topic, count)
        if not cards:
            return ToolResult(ok=False, error="deck generation failed")
        return ToolResult(
            ok=True,
            output=f"deck '{topic}' criado: {len(cards)} cards",
            metadata={"topic": topic, "count": len(cards)},
        )


class ListDueTool(Tool):
    name = "flashcard_list_due"
    description = (
        "List flashcards due for review today. Use when the user asks to "
        "'revisar', 'estudar', 'praticar'."
    )
    json_schema = {
        "type": "object",
        "properties": {"limit": {"type": "integer", "maximum": 20}},
    }
    requires_confirmation = False
    category = "memory"

    def __init__(self, store: Any, llm: Any) -> None:
        self.store = store
        self.llm = llm

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        limit = int(args.get("limit") or 10)
        cards = await FlashcardsService(self.store, self.llm).list_due(limit=limit)
        if not cards:
            return ToolResult(ok=True, output="Nenhum card vencido agora.")
        lines = [f"{len(cards)} card(s) pra revisar:"]
        for c in cards[:10]:
            lines.append(f"- [{c['topic']}] {c['front']}")
        return ToolResult(
            ok=True, output="\n".join(lines),
            metadata={"cards": cards},
        )
