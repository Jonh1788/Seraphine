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
        "'me ensina Y', 'cria cards sobre Z'. "
        "IMPORTANT: after the tool succeeds, DO NOT list the card "
        "questions in chat. Review happens in the dedicated Flashcards "
        "tab (card-shaped icon in the sidebar) which has flip + SM-2 "
        "rating buttons. Just invite the user to open it."
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
            output=(
                f"Deck '{topic}' criado com {len(cards)} cards. "
                f"Abra a aba Flashcards (sidebar, ícone de cartão) pra "
                f"revisar — a review tem flip, rating SM-2 (Again/Hard/"
                f"Good/Easy) e agenda o próximo intervalo automaticamente. "
                f"NÃO liste as perguntas no chat, só convide ele a abrir."
            ),
            metadata={"topic": topic, "count": len(cards), "open_view": "flashcards"},
        )


class ListDueTool(Tool):
    name = "flashcard_list_due"
    description = (
        "Check how many flashcards are due for review today. Use when "
        "the user asks to 'revisar', 'estudar', 'praticar'. "
        "IMPORTANT: do NOT list cards in chat. Review is done in the "
        "Flashcards tab; this tool just reports the count and should "
        "nudge the user to open the tab."
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
            return ToolResult(
                ok=True,
                output="Nenhum card vencido agora.",
                metadata={"count": 0},
            )
        topics = sorted({c["topic"] for c in cards})
        return ToolResult(
            ok=True,
            output=(
                f"{len(cards)} card(s) vencido(s) pra revisar "
                f"(tópicos: {', '.join(topics[:5])}). "
                f"Diga ao usuário pra abrir a aba Flashcards pra revisar. "
                f"NÃO liste as perguntas aqui — a review é na UI dedicada."
            ),
            metadata={"count": len(cards), "topics": topics, "open_view": "flashcards"},
        )
