"""Chat tools for notes -- create/update/delete/list/search via LLM tool-calling.

Metadata contract: every successful tool returns ``metadata.note`` (dict)
or ``metadata.notes`` (list of dicts) so the frontend can render a
NoteChatBlock. HTML cards are intentionally omitted -- the React block
renders from the JSON payload.
"""

from __future__ import annotations

import logging
from typing import Any

from seraphine.notes.service import NoteService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


def _clip(text: str, limit: int = 120) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "..."


class CreateNoteTool(Tool):
    """Create a new Markdown note."""

    name = "create_note"
    description = (
        "Save a note for the user. Use whenever they say 'anota isso', 'anota "
        "ai', 'salva essa nota', 'cria uma nota', 'guarda essa ideia', or when "
        "they dictate any text they clearly want kept as a standalone note "
        "(meeting notes, ideas, journaling snippets, research quotes). "
        "Notes support full Markdown in the body. Use tags for categorisation "
        "(e.g. 'trabalho', 'pessoal', 'ideias')."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the note.",
            },
            "content": {
                "type": "string",
                "description": (
                    "Markdown body. Supports headings, lists, bold, code "
                    "blocks, links, etc."
                ),
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional list of string tags.",
            },
        },
        "required": ["title"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, note_service: NoteService) -> None:
        self._svc = note_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        if not title:
            return ToolResult(ok=False, error="title is required")

        content = args.get("content")
        if content is None:
            content = ""
        tags = args.get("tags")

        try:
            note = await self._svc.create(
                title=title,
                content=str(content),
                tags=tags if isinstance(tags, list) else None,
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("create_note tool failed")
            return ToolResult(ok=False, error=str(exc))

        note_dict = note.to_dict()
        return ToolResult(
            ok=True,
            output=f"Nota criada: {title}.",
            metadata={"note": note_dict},
        )


class UpdateNoteTool(Tool):
    """Patch an existing note by ID."""

    name = "update_note"
    description = (
        "Update an existing note by its ID. Use when the user asks to change "
        "a note's title, body, or tags. The ID must come from a prior "
        "create/list/search result."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "UUID of the note to update.",
            },
            "title": {
                "type": "string",
                "description": "New title (omit to keep current).",
            },
            "content": {
                "type": "string",
                "description": "New Markdown body (omit to keep current).",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Replacement tag list (omit to keep current).",
            },
        },
        "required": ["id"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, note_service: NoteService) -> None:
        self._svc = note_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        note_id = str(args.get("id") or "").strip()
        if not note_id:
            return ToolResult(ok=False, error="id is required")

        kwargs: dict[str, Any] = {}
        if "title" in args and args["title"] is not None:
            kwargs["title"] = args["title"]
        if "content" in args and args["content"] is not None:
            kwargs["content"] = args["content"]
        if "tags" in args and args["tags"] is not None:
            if not isinstance(args["tags"], list):
                return ToolResult(ok=False, error="tags must be an array")
            kwargs["tags"] = args["tags"]

        if not kwargs:
            return ToolResult(ok=False, error="no fields to update")

        try:
            note = await self._svc.update(note_id, **kwargs)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("update_note tool failed")
            return ToolResult(ok=False, error=str(exc))

        if note is None:
            return ToolResult(ok=False, error=f"note {note_id} not found")

        return ToolResult(
            ok=True,
            output=f"Nota atualizada: {note.title}.",
            metadata={"note": note.to_dict()},
        )


class DeleteNoteTool(Tool):
    """Delete a note by ID -- confirmation required."""

    name = "delete_note"
    description = (
        "Delete a note by its ID. Triggers an approval prompt before "
        "execution -- use only when the user clearly asks to remove a note."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "UUID of the note to delete.",
            },
        },
        "required": ["id"],
    }
    requires_confirmation = True
    category = "other"

    def __init__(self, note_service: NoteService) -> None:
        self._svc = note_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        note_id = str(args.get("id") or "").strip()
        if not note_id:
            return ToolResult(ok=False, error="id is required")

        try:
            ok = await self._svc.delete(note_id)
        except Exception as exc:
            logger.exception("delete_note tool failed")
            return ToolResult(ok=False, error=str(exc))

        if not ok:
            return ToolResult(ok=False, error=f"note {note_id} not found")

        return ToolResult(
            ok=True,
            output=f"Nota {note_id} removida.",
            metadata={"deleted_id": note_id},
        )


class ListNotesTool(Tool):
    """List recent notes (newest first)."""

    name = "list_notes"
    description = (
        "List the user's most recently updated notes. Use when they ask "
        "'quais notas tenho', 'lista minhas notas', 'mostra minhas anotacoes'. "
        "Returns an array of notes in metadata."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "Max number of notes to return (default 20).",
            },
        },
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, note_service: NoteService) -> None:
        self._svc = note_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            limit = int(args.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20

        try:
            notes = await self._svc.list(limit=limit)
        except Exception as exc:
            logger.exception("list_notes tool failed")
            return ToolResult(ok=False, error=str(exc))

        if not notes:
            return ToolResult(
                ok=True,
                output="Voce ainda nao tem nenhuma nota.",
                metadata={"notes": []},
            )

        summary_lines = [
            f"- {n.title}" + (f" ({_clip(n.content, 60)})" if n.content else "")
            for n in notes[:10]
        ]
        text = f"{len(notes)} nota(s):\n" + "\n".join(summary_lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"notes": [n.to_dict() for n in notes]},
        )


class SearchNotesTool(Tool):
    """Full-text-ish search across title, content, and tags."""

    name = "search_notes"
    description = (
        "Search the user's notes by substring in the title, body, or tags. "
        "Case-insensitive. Use when they ask to find a note -- "
        "'acha minhas notas sobre X', 'procura nas anotacoes Y'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Text to look for (substring match).",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "Max number of notes to return (default 20).",
            },
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, note_service: NoteService) -> None:
        self._svc = note_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            return ToolResult(ok=False, error="query is required")
        try:
            limit = int(args.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20

        try:
            notes = await self._svc.search(query, limit=limit)
        except Exception as exc:
            logger.exception("search_notes tool failed")
            return ToolResult(ok=False, error=str(exc))

        if not notes:
            return ToolResult(
                ok=True,
                output=f"Nenhuma nota com '{query}'.",
                metadata={"notes": [], "query": query},
            )

        lines = [
            f"- {n.title}" + (f" ({_clip(n.content, 60)})" if n.content else "")
            for n in notes[:10]
        ]
        text = f"{len(notes)} resultado(s) para '{query}':\n" + "\n".join(lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"notes": [n.to_dict() for n in notes], "query": query},
        )
