"""Chat tools for reading list -- save URLs, semantic search via LLM tool-calling.

Metadata contract: successful tool returns ``metadata.item`` (dict) or
``metadata.items`` (list of dicts) so the frontend can render a
ReadingChatBlock.
"""

from __future__ import annotations

import logging
from typing import Any

from seraphine.reading.service import ReadingService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


class SaveReadingItemTool(Tool):
    """Save a URL to the user's reading list."""

    name = "save_reading_item"
    description = (
        "Save an article, blog post, or any web page to the user's reading "
        "list. The system will automatically fetch the content, generate a "
        "summary, and make it searchable. Use when the user says 'salva esse "
        "artigo', 'guarda esse link', 'adiciona na reading list', or shares "
        "a URL they want to save for later. Returns immediately -- processing "
        "happens in the background."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Fully-qualified http(s) URL to save.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional tags to categorize the item.",
            },
        },
        "required": ["url"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, reading_service: ReadingService) -> None:
        self._svc = reading_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        url = str(args.get("url") or "").strip()
        if not url:
            return ToolResult(ok=False, error="url is required")

        tags = args.get("tags")
        if tags is not None and not isinstance(tags, list):
            return ToolResult(ok=False, error="tags must be an array")

        try:
            item = await self._svc.save_item(url=url, tags=tags)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("save_reading_item tool failed")
            return ToolResult(ok=False, error=str(exc))

        return ToolResult(
            ok=True,
            output=(
                f"Artigo salvo na reading list. "
                f"Processando conteudo em background..."
            ),
            metadata={"item": item.to_dict()},
        )


class SearchReadingListTool(Tool):
    """Semantic search across the user's saved reading items."""

    name = "search_reading_list"
    description = (
        "Search the user's reading list using semantic similarity. Use when "
        "they ask 'o que eu salvei sobre X', 'procura nos meus artigos sobre Y', "
        "'tem algo na reading list sobre Z'. Returns the most relevant saved "
        "items with their summaries."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural language search query.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50,
                "description": "Max number of results to return (default 10).",
            },
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, reading_service: ReadingService) -> None:
        self._svc = reading_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            return ToolResult(ok=False, error="query is required")

        try:
            limit = int(args.get("limit") or 10)
        except (TypeError, ValueError):
            limit = 10

        try:
            items = await self._svc.search(query, limit=limit)
        except Exception as exc:
            logger.exception("search_reading_list tool failed")
            return ToolResult(ok=False, error=str(exc))

        if not items:
            return ToolResult(
                ok=True,
                output=f"Nenhum artigo encontrado para '{query}'.",
                metadata={"items": [], "query": query},
            )

        summary_lines = []
        for i in items[:10]:
            line = f"- {i.title or i.url}"
            if i.summary:
                short = i.summary[:80].rstrip()
                if len(i.summary) > 80:
                    short += "..."
                line += f" ({short})"
            summary_lines.append(line)

        text = f"{len(items)} resultado(s) para '{query}':\n" + "\n".join(summary_lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"items": [i.to_dict() for i in items], "query": query},
        )
