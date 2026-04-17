"""055 — Sticky-note creation tool.

LLM calls this when the user asks for a post-it reminder on the
desktop. Actual rendering happens on the Mac via frontend listener
(`desktop_notes_updated` event).
"""

from __future__ import annotations

from typing import Any

from seraphine.tools.base import Tool, ToolResult


class StickyNoteTool(Tool):
    name = "sticky_note_create"
    description = (
        "Create a floating sticky note on the user's desktop. Use "
        "when he says 'cria um post-it', 'deixa um lembrete na tela', "
        "or when you want to park a reminder visually without "
        "opening chat. Color can be 'yellow' (default), 'pink', "
        "'blue', or 'green'."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "text": {"type": "string", "maxLength": 400},
            "color": {"type": "string", "enum": ["yellow", "pink", "blue", "green"]},
        },
        "required": ["text"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        text = str(args.get("text", "")).strip()
        if not text:
            return ToolResult(ok=False, error="missing text")
        color = str(args.get("color") or "yellow")
        try:
            note = await self.store.create_desktop_note(text=text, color=color)
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
        return ToolResult(
            ok=True,
            output=f"post-it criado: {text[:60]}",
            metadata={"note_id": note["id"]},
        )
