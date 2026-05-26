"""Chat tools for journal -- create entries and semantic search via LLM tool-calling."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from seraphine.journal.service import JournalService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")


class CreateJournalEntryTool(Tool):
    """Create a new journal entry."""

    name = "create_journal_entry"
    description = (
        "Cria uma entrada no diario do usuario. Use quando ele disser "
        "'escreve no meu diario', 'quero registrar no journal', 'anota isso "
        "no diario', 'reflexao do dia', ou quando compartilhar pensamentos "
        "que merecem ser registrados."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the journal entry.",
            },
            "content": {
                "type": "string",
                "description": "The journal entry content / body text.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional tags to categorize the entry.",
            },
        },
        "required": ["title", "content"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, journal_service: JournalService) -> None:
        self._svc = journal_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        if not title:
            return ToolResult(ok=False, error="title is required")

        content = str(args.get("content") or "").strip()
        if not content:
            return ToolResult(ok=False, error="content is required")

        tags = args.get("tags")
        if tags is not None and not isinstance(tags, list):
            return ToolResult(ok=False, error="tags must be an array")

        today_sp = datetime.now(_SP_TZ).date().isoformat()

        try:
            entry = await self._svc.create_entry(
                date=today_sp,
                type="manual",
                title=title,
                content=content,
                tags=tags,
                source="user",
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("create_journal_entry tool failed")
            return ToolResult(ok=False, error=str(exc))

        return ToolResult(
            ok=True,
            output=f"Entrada criada no diario: \"{title}\".",
            metadata={"entry": entry.to_dict()},
        )


class SearchJournalTool(Tool):
    """Semantic search across the user's journal."""

    name = "search_journal"
    description = (
        "Busca no diario por texto semantico. Use quando o usuario "
        "perguntar 'o que escrevi sobre X', 'procura no diario sobre Y', "
        "'tem algo no journal sobre Z', 'quando registrei sobre...'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural language search query.",
            },
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, journal_service: JournalService) -> None:
        self._svc = journal_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            return ToolResult(ok=False, error="query is required")

        try:
            results = await self._svc.search(query, limit=10)
        except Exception as exc:
            logger.exception("search_journal tool failed")
            return ToolResult(ok=False, error=str(exc))

        if not results:
            return ToolResult(
                ok=True,
                output=f"Nenhuma entrada encontrada para '{query}'.",
                metadata={"entries": [], "query": query},
            )

        lines: list[str] = []
        for r in results[:10]:
            title = r.get("title") or "(sem titulo)"
            date_str = r.get("date") or ""
            snippet = (r.get("content") or "")[:80].rstrip()
            if len(r.get("content") or "") > 80:
                snippet += "..."
            lines.append(f"- [{date_str}] {title}: {snippet}")

        text = f"{len(results)} resultado(s) para '{query}':\n" + "\n".join(lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"entries": results, "query": query},
        )
