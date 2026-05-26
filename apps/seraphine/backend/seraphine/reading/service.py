"""ReadingService -- save URLs, auto-summarize via LLM, embed in ChromaDB.

Single-tenant: no user_id scoping. Processing pipeline runs async via
``asyncio.create_task`` so the save endpoint returns immediately.
"""

from __future__ import annotations

import asyncio
import json
import logging
import ssl
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Protocol
from urllib.parse import urlparse

import httpx
import truststore
from bs4 import BeautifulSoup

from core_db import Store
from llm_adapters.types import ChatMessage, Token

from seraphine.reading.models import ReadingItem

logger = logging.getLogger(__name__)

_ITEM_COLS = (
    "id, url, title, domain, summary, content_text, "
    "tags, status, saved_at, read_at, archived_at, error_msg"
)

_VALID_STATUSES = {"processing", "unread", "reading", "read", "archived", "error"}

# Content extraction limits
_MAX_CONTENT_BYTES = 2 * 1024 * 1024  # 2 MB fetch limit
_MAX_CONTENT_TEXT = 50 * 1024  # 50 KB stored text limit
_FETCH_TIMEOUT = 20.0
_USER_AGENT = "SeraphineBot/0.1 (+local-assistant)"
_NOISE_TAGS = ("script", "style", "noscript", "template", "svg", "nav", "footer", "aside")

_SUMMARY_PROMPT = (
    "Resuma este artigo em 3-5 frases em portugues. "
    "Sugira um titulo curto e ate 5 tags relevantes. "
    'Responda em JSON puro (sem markdown): {"title": "...", "summary": "...", "tags": ["..."]}'
)


class _LLMLike(Protocol):
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = ...,
        temperature: float = ...,
    ) -> AsyncIterator[Token]: ...


class _EmbeddingsLike(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_tags(tags: Any) -> list[str]:
    if not tags:
        return []
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except (json.JSONDecodeError, TypeError):
            return [tags.strip()] if tags.strip() else []
    if not isinstance(tags, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for t in tags:
        if t is None:
            continue
        s = str(t).strip().lower()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _serialize_tags(tags: Any) -> str:
    return json.dumps(_normalize_tags(tags), ensure_ascii=False)


def _extract_domain(url: str) -> str:
    """Extract display-friendly domain from URL."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        # Strip www. prefix
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def _extract_title_and_text(body: bytes, content_type: str) -> tuple[str, str]:
    """Parse HTML and return (title, text). For non-HTML, decode as UTF-8."""
    ct = (content_type or "").lower()
    if "html" in ct or "xhtml" in ct or body[:256].lstrip().lower().startswith(b"<!doctype html"):
        try:
            soup = BeautifulSoup(body, "html.parser")
        except Exception:
            return "", body.decode("utf-8", errors="replace")

        title = ""
        if soup.title and soup.title.string:
            title = soup.title.string.strip()

        for tag in soup(_NOISE_TAGS):
            tag.decompose()

        root = soup.body or soup
        text = root.get_text(separator="\n", strip=True)
        lines = [line.strip() for line in text.splitlines()]
        compact = "\n".join(line for line in lines if line)
        return title, compact

    try:
        return "", body.decode("utf-8")
    except UnicodeDecodeError:
        return "", body.decode("utf-8", errors="replace")


class ReadingService:
    def __init__(
        self,
        store: Store,
        llm: _LLMLike,
        embeddings: _EmbeddingsLike,
        chroma_path: Path,
    ) -> None:
        self._store = store
        self._llm = llm
        self._embeddings = embeddings
        self._chroma_path = Path(chroma_path)
        self._collection: Any = None

    async def start(self) -> None:
        """Initialize ChromaDB collection."""
        if self._collection is not None:
            return
        import chromadb  # type: ignore[import-not-found]

        self._chroma_path.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(self._chroma_path))
        self._collection = client.get_or_create_collection("reading_items")

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def save_item(
        self,
        url: str,
        tags: list[str] | None = None,
    ) -> ReadingItem:
        """Save a URL to the reading list. Returns immediately with
        status=processing. Kicks off async processing pipeline."""
        url = (url or "").strip()
        if not url:
            raise ValueError("url is required")

        item_id = str(uuid.uuid4())
        ts = _now_iso()
        domain = _extract_domain(url)
        tags_json = _serialize_tags(tags)

        def _work() -> ReadingItem:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO reading_items"
                    f" (id, url, title, domain, summary, content_text, tags, status, saved_at)"
                    f" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (item_id, url, "", domain, "", None, tags_json, "processing", ts),
                )
                row = conn.execute(
                    f"SELECT {_ITEM_COLS} FROM reading_items WHERE id = ?",
                    (item_id,),
                ).fetchone()
            return ReadingItem.from_row(row)

        item = await asyncio.to_thread(_work)

        # Fire-and-forget processing
        asyncio.create_task(self._process_item(item_id, url, tags))

        return item

    async def _process_item(
        self,
        item_id: str,
        url: str,
        initial_tags: list[str] | None = None,
    ) -> None:
        """Async processing pipeline: fetch -> LLM summarize -> embed."""
        try:
            # 1. Fetch content
            html_title, content_text = await self._fetch_content(url)
            if not content_text or not content_text.strip():
                await self._mark_error(item_id, "failed to extract content from URL")
                return

            # Truncate to 50KB
            if len(content_text) > _MAX_CONTENT_TEXT:
                content_text = content_text[:_MAX_CONTENT_TEXT]

            # 2. LLM summary
            title, summary, llm_tags = await self._llm_summarize(content_text)
            if not title and html_title:
                title = html_title

            # Merge initial tags with LLM-suggested tags
            merged_tags = _normalize_tags(initial_tags) + [
                t for t in _normalize_tags(llm_tags)
                if t not in _normalize_tags(initial_tags)
            ]

            # 3. Update item in DB
            def _update() -> None:
                with self._store._connect() as conn:
                    conn.execute(
                        "UPDATE reading_items SET "
                        "  title = ?, summary = ?, content_text = ?, "
                        "  tags = ?, status = ? "
                        "WHERE id = ?",
                        (
                            title or "",
                            summary or "",
                            content_text,
                            json.dumps(merged_tags, ensure_ascii=False),
                            "unread",
                            item_id,
                        ),
                    )

            await asyncio.to_thread(_update)

            # 4. Embed in ChromaDB
            embed_text = f"{title}\n{summary}\n{content_text[:4096]}"
            await self._embed(item_id, embed_text)

            logger.info("reading: processed item %s (%s)", item_id, title[:60] if title else url)

        except Exception as e:
            logger.exception("reading: processing failed for %s", item_id)
            await self._mark_error(item_id, str(e)[:500])

    async def _fetch_content(self, url: str) -> tuple[str, str]:
        """Fetch URL and extract title + text content."""
        headers = {
            "User-Agent": _USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        }
        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        async with httpx.AsyncClient(
            timeout=_FETCH_TIMEOUT,
            follow_redirects=True,
            max_redirects=5,
            headers=headers,
            verify=ssl_ctx,
        ) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                body = bytearray()
                async for chunk in resp.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_CONTENT_BYTES:
                        break
                content_type = resp.headers.get("content-type", "")

        return _extract_title_and_text(bytes(body), content_type)

    async def _llm_summarize(self, content: str) -> tuple[str, str, list[str]]:
        """Use LLM to generate title, summary, and tags from content.
        Returns (title, summary, tags). Best-effort: returns empty on failure."""
        # Send first 8KB to LLM to keep context reasonable
        excerpt = content[:8192]
        messages = [
            ChatMessage(role="system", content=_SUMMARY_PROMPT),
            ChatMessage(role="user", content=excerpt),
        ]

        accumulated: list[str] = []
        try:
            async for tok in self._llm.chat(messages, temperature=0.3):
                if tok.text:
                    accumulated.append(tok.text)
        except Exception as e:
            logger.warning("reading: LLM summary failed: %s", e)
            return "", "", []

        raw = "".join(accumulated).strip()
        # Try to parse JSON from the response
        try:
            # Strip markdown code fences if present
            if raw.startswith("```"):
                lines = raw.split("\n")
                raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
                raw = raw.strip()
            data = json.loads(raw)
            title = str(data.get("title", "")).strip()
            summary = str(data.get("summary", "")).strip()
            tags = data.get("tags", [])
            if not isinstance(tags, list):
                tags = []
            return title, summary, [str(t) for t in tags if t]
        except (json.JSONDecodeError, TypeError, AttributeError):
            logger.warning("reading: failed to parse LLM JSON: %s", raw[:200])
            return "", raw[:500] if raw else "", []

    async def _embed(self, item_id: str, text: str) -> None:
        """Embed content in ChromaDB collection."""
        if self._collection is None:
            return
        try:
            vec = (await self._embeddings.embed([text]))[0]
            self._collection.add(
                ids=[item_id],
                embeddings=[vec],
                documents=[text],
                metadatas=[{"item_id": item_id}],
            )
        except Exception as e:
            logger.warning("reading: embed failed for %s: %s", item_id, e)

    async def _mark_error(self, item_id: str, error_msg: str) -> None:
        """Mark an item as error in the DB."""
        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "UPDATE reading_items SET status = ?, error_msg = ? WHERE id = ?",
                    ("error", error_msg, item_id),
                )

        await asyncio.to_thread(_work)

    async def list_items(
        self,
        *,
        status: str | None = None,
        tag: str | None = None,
        q: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ReadingItem]:
        """List reading items with optional filters."""
        lim = max(1, min(int(limit), 500))
        off = max(0, int(offset))

        def _work() -> list[ReadingItem]:
            clauses: list[str] = []
            params: list[Any] = []

            if status and status in _VALID_STATUSES:
                clauses.append("status = ?")
                params.append(status)

            if tag:
                # JSON array contains tag
                clauses.append("LOWER(tags) LIKE LOWER(?)")
                params.append(f'%"{tag.strip().lower()}"%')

            if q:
                like = f"%{q.strip()}%"
                clauses.append(
                    "(LOWER(title) LIKE LOWER(?) "
                    "OR LOWER(summary) LIKE LOWER(?) "
                    "OR LOWER(tags) LIKE LOWER(?))"
                )
                params.extend([like, like, like])

            where = ""
            if clauses:
                where = " WHERE " + " AND ".join(clauses)

            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_ITEM_COLS} FROM reading_items"
                    f"{where}"
                    " ORDER BY saved_at DESC"
                    " LIMIT ? OFFSET ?",
                    params + [lim, off],
                ).fetchall()
            return [ReadingItem.from_row(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_item(self, item_id: str) -> ReadingItem | None:
        """Get a single reading item by ID."""
        def _work() -> ReadingItem | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_ITEM_COLS} FROM reading_items WHERE id = ?",
                    (item_id,),
                ).fetchone()
            return ReadingItem.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def update_item(
        self,
        item_id: str,
        *,
        status: str | None = None,
        tags: list[str] | None = None,
    ) -> ReadingItem | None:
        """Update status and/or tags of a reading item."""
        sets: list[str] = []
        params: list[Any] = []

        if status is not None:
            if status not in _VALID_STATUSES:
                raise ValueError(f"invalid status: {status}")
            sets.append("status = ?")
            params.append(status)
            if status == "read":
                sets.append("read_at = ?")
                params.append(_now_iso())
            elif status == "archived":
                sets.append("archived_at = ?")
                params.append(_now_iso())

        if tags is not None:
            sets.append("tags = ?")
            params.append(_serialize_tags(tags))

        if not sets:
            return await self.get_item(item_id)

        params.append(item_id)

        def _work() -> ReadingItem | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE reading_items SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_ITEM_COLS} FROM reading_items WHERE id = ?",
                    (item_id,),
                ).fetchone()
            return ReadingItem.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete_item(self, item_id: str) -> bool:
        """Delete item from SQLite and ChromaDB."""
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM reading_items WHERE id = ?",
                    (item_id,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        if affected == 0:
            return False

        # Also remove from ChromaDB
        if self._collection is not None:
            try:
                self._collection.delete(ids=[item_id])
            except Exception as e:
                logger.warning("reading: chromadb delete failed for %s: %s", item_id, e)

        return True

    async def search(self, query: str, *, limit: int = 10) -> list[ReadingItem]:
        """Semantic search via ChromaDB embeddings."""
        q = (query or "").strip()
        if not q:
            return await self.list_items(limit=limit)

        if self._collection is None:
            # Fallback to text search
            return await self.list_items(q=q, limit=limit)

        try:
            vec = (await self._embeddings.embed([q]))[0]
        except Exception as e:
            logger.warning("reading: embed query failed: %s", e)
            return await self.list_items(q=q, limit=limit)

        lim = max(1, min(int(limit), 100))
        try:
            result = self._collection.query(
                query_embeddings=[vec],
                n_results=lim,
            )
        except Exception as e:
            logger.warning("reading: chromadb query failed: %s", e)
            return await self.list_items(q=q, limit=limit)

        ids = result.get("ids", [[]])[0]
        if not ids:
            return []

        # Fetch full items from SQLite in the order returned by ChromaDB
        def _work() -> list[ReadingItem]:
            placeholders = ", ".join("?" for _ in ids)
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_ITEM_COLS} FROM reading_items"
                    f" WHERE id IN ({placeholders})",
                    ids,
                ).fetchall()
            # Preserve ChromaDB relevance order
            by_id = {str(r[0]): r for r in rows}
            return [ReadingItem.from_row(by_id[i]) for i in ids if i in by_id]

        return await asyncio.to_thread(_work)
