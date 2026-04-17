"""027-B — Document reader.

Unified reader for PDF, HTML, and plain text. When the user says
"explica esse PDF <path>" or paste a URL, this tool extracts the text
so the LLM can summarize conversationally.

Uses pdfplumber for PDFs (already in the dependency tree) and reuses
web_fetch/httpx for HTTP(S) URLs. Intentionally caps the output so a
giant PDF doesn't blow the context window.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx
import pdfplumber
import truststore

from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger("seraphine.tools.document")

_MAX_CHARS = 30_000
_MAX_PAGES = 60
_FETCH_TIMEOUT = 20.0


def _sniff_format(source: str, content: bytes | None = None) -> str:
    lower = source.lower()
    if content is not None and content.startswith(b"%PDF"):
        return "pdf"
    if lower.endswith(".pdf"):
        return "pdf"
    if lower.endswith((".html", ".htm")) or lower.startswith(("http://", "https://")):
        return "html"
    if lower.endswith((".txt", ".md", ".markdown")):
        return "text"
    return "unknown"


def _strip_html(html: str) -> str:
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer"]):
            tag.decompose()
        text = soup.get_text("\n")
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    # Collapse whitespace.
    text = re.sub(r"[\t ]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_pdf(pdf_bytes: bytes) -> tuple[str, int]:
    import io
    text_parts: list[str] = []
    page_count = 0
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for i, page in enumerate(pdf.pages):
                if i >= _MAX_PAGES:
                    break
                page_count += 1
                try:
                    t = page.extract_text() or ""
                except Exception:
                    t = ""
                text_parts.append(t)
    except Exception as e:
        logger.warning("pdf extract failed: %s", e)
    return "\n\n".join(text_parts), page_count


class DocumentReadTool(Tool):
    name = "document_read"
    description = (
        "Read text from a PDF, HTML page, or plain-text file. Accepts a "
        "local path or an HTTP(S) URL. Returns the extracted text capped "
        "at 30k chars plus metadata (format, pages, truncated). Use "
        "when the user asks to summarize/explain a document they linked "
        "or referenced locally."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "Local file path OR http(s) URL.",
            },
        },
        "required": ["source"],
    }
    requires_confirmation = False
    category = "filesystem"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        source = str(args.get("source", "")).strip()
        if not source:
            return ToolResult(ok=False, error="missing 'source'")

        try:
            content, fmt = await self._fetch(source)
        except Exception as e:
            return ToolResult(ok=False, error=f"fetch failed: {e}")

        if fmt == "pdf":
            text, page_count = _extract_pdf(content)
        elif fmt == "html":
            try:
                html = content.decode("utf-8", errors="replace")
            except Exception:
                html = str(content)
            text = _strip_html(html)
            page_count = 0
        elif fmt == "text":
            text = content.decode("utf-8", errors="replace")
            page_count = 0
        else:
            return ToolResult(
                ok=False, error=f"unsupported format for source: {source}",
            )

        if not text.strip():
            return ToolResult(
                ok=False, error="no extractable text found",
                metadata={"format": fmt, "page_count": page_count},
            )

        truncated = len(text) > _MAX_CHARS
        if truncated:
            text = text[:_MAX_CHARS] + "\n\n[…truncado após 30k chars]"

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "format": fmt,
                "page_count": page_count,
                "truncated": truncated,
                "original_source": source,
            },
        )

    async def _fetch(self, source: str) -> tuple[bytes, str]:
        if source.startswith(("http://", "https://")):
            ssl_ctx = truststore.SSLContext(__import__("ssl").PROTOCOL_TLS_CLIENT)
            async with httpx.AsyncClient(verify=ssl_ctx, follow_redirects=True,
                                           timeout=_FETCH_TIMEOUT) as client:
                resp = await client.get(source, headers={
                    "User-Agent": "Mozilla/5.0 (Seraphine DocumentReader)",
                })
                resp.raise_for_status()
                content = resp.content
            ctype = resp.headers.get("content-type", "").lower()
            if "pdf" in ctype:
                return content, "pdf"
            return content, _sniff_format(source, content)

        # Local path — resolve relative to ~ / absolute.
        path = Path(os.path.expanduser(source))
        if not path.is_file():
            raise FileNotFoundError(str(path))
        data = path.read_bytes()
        return data, _sniff_format(str(path), data)
