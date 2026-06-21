"""JournalService -- persist, query, and semantically search journal entries.

Single-tenant: no user_id scoping.  Entries originate from the proactive
scheduler (day_review / weekly_reflection), voice memos classified as
diary, or manual user input.  ChromaDB provides semantic search.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.journal.types import JournalEntry

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()

_ENTRY_COLS = (
    "id, date, type, title, content, mood_label, mood_valence,"
    " source, tags, source_id, created_at, updated_at, reflection"
)

# System prompt for the per-entry Seraphine reflection. Kept short on
# purpose: we want a single warm PT-BR reflective sentence, never a list.
_REFLECTION_PROMPT = (
    "Voce e a Seraphine, uma assistente pessoal calorosa e atenta."
    " Leia a entrada de diario do usuario e devolva UMA unica frase curta"
    " em portugues do Brasil (no maximo 200 caracteres) que reflita sobre"
    " o que ele escreveu: acolha, valorize ou ofereca uma perspectiva gentil."
    " Fale diretamente com o usuario na segunda pessoa. Nao use listas,"
    " nao repita o texto e nao use aspas. Responda apenas com a frase."
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialize_tags(tags: list[str] | None) -> str:
    if not tags:
        return "[]"
    cleaned = [str(t).strip() for t in tags if t and str(t).strip()]
    return json.dumps(cleaned, ensure_ascii=False)


class JournalService:
    def __init__(
        self,
        store: Store,
        *,
        chroma_path: Path | str | None = None,
        embeddings: Any = None,
        llm: Any = None,
    ) -> None:
        self._store = store
        self._embeddings = embeddings
        self._chroma_path = Path(chroma_path) if chroma_path else None
        self._collection: Any = None
        self._llm = llm

    async def start(self) -> None:
        """Initialize ChromaDB collection for semantic search."""
        if self._chroma_path is None or self._embeddings is None:
            return
        try:
            import chromadb  # type: ignore[import-not-found]

            self._chroma_path.mkdir(parents=True, exist_ok=True)
            client = chromadb.PersistentClient(path=str(self._chroma_path))
            self._collection = client.get_or_create_collection("journal_entries")
            logger.info("journal: ChromaDB collection ready")
        except Exception as e:
            logger.warning("journal: ChromaDB init failed (search disabled): %s", e)

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    async def create_entry(
        self,
        *,
        date: str,
        type: str,
        title: str,
        content: str,
        mood_label: str | None = None,
        mood_valence: float | None = None,
        tags: list[str] | None = None,
        source: str = "user",
        source_id: str | None = None,
        reflection: str | None = None,
    ) -> JournalEntry:
        """Insert a new journal entry.  Embeds in ChromaDB for search."""
        eid = str(uuid.uuid4())
        ts = _now_iso()
        tags_json = _serialize_tags(tags)

        def _work() -> JournalEntry:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO journal_entries ({_ENTRY_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        eid, date, type, title, content,
                        mood_label, mood_valence,
                        source, tags_json, source_id,
                        ts, ts, reflection,
                    ),
                )
                row = conn.execute(
                    f"SELECT {_ENTRY_COLS} FROM journal_entries WHERE id = ?",
                    (eid,),
                ).fetchone()
            return JournalEntry.from_row(row)

        entry = await asyncio.to_thread(_work)

        # Best-effort embedding
        await self._embed(eid, content)

        return entry

    async def generate_reflection(self, content: str) -> str | None:
        """Generate a short PT-BR Seraphine reflection on an entry's content.

        Best-effort and non-blocking on failure: returns ``None`` when no LLM
        is configured, the content is empty, or the call errors out.
        """
        if self._llm is None:
            return None
        text = (content or "").strip()
        if not text:
            return None

        try:
            from llm_adapters.types import ChatMessage
        except Exception:  # pragma: no cover - import guard
            return None

        messages = [
            ChatMessage(role="system", content=_REFLECTION_PROMPT),
            ChatMessage(role="user", content=text[:4000]),
        ]
        accumulated: list[str] = []
        try:
            async for tok in self._llm.chat(messages, temperature=0.6):
                piece = getattr(tok, "text", None)
                if piece:
                    accumulated.append(piece)
        except Exception as e:
            logger.warning("journal: reflection generation failed: %s", e)
            return None

        reflection = "".join(accumulated).strip().strip('"').strip()
        if not reflection:
            return None
        # Keep it to a single concise sentence/line.
        reflection = reflection.splitlines()[0].strip()
        return reflection[:400] or None

    async def set_reflection(self, entry_id: str, reflection: str | None) -> None:
        """Persist the reflection column for an existing entry (best-effort)."""

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "UPDATE journal_entries SET reflection = ? WHERE id = ?",
                    (reflection, entry_id),
                )

        try:
            await asyncio.to_thread(_work)
        except Exception as e:
            logger.warning("journal: persisting reflection failed: %s", e)

    async def exists(self, *, date: str, type: str) -> bool:
        """Check if an auto-generated entry for date+type already exists.

        Used for idempotent pipeline hooks.
        """

        def _work() -> bool:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT 1 FROM journal_entries"
                    " WHERE date = ? AND type = ? AND source != 'user'"
                    " LIMIT 1",
                    (date, type),
                ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)

    async def update_entry(
        self,
        entry_id: str,
        *,
        title: str | None = None,
        content: str | None = None,
        tags: list[str] | None = None,
    ) -> JournalEntry | None:
        """Patch a manual entry.  Returns None if not found."""
        sets: list[str] = []
        params: list[Any] = []

        if title is not None:
            clean = str(title).strip()
            if not clean:
                raise ValueError("title cannot be empty")
            sets.append("title = ?")
            params.append(clean)

        if content is not None:
            sets.append("content = ?")
            params.append(str(content))

        if tags is not None:
            sets.append("tags = ?")
            params.append(_serialize_tags(tags))

        if not sets:
            return await self.get_entry(entry_id)

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.append(entry_id)

        def _work() -> JournalEntry | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE journal_entries SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_ENTRY_COLS} FROM journal_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
            return JournalEntry.from_row(row) if row else None

        entry = await asyncio.to_thread(_work)

        # Re-embed if content changed
        if entry and content is not None:
            await self._embed(entry_id, content)

        return entry

    async def delete_entry(self, entry_id: str) -> bool:
        """Delete a journal entry.  Returns True if deleted."""

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM journal_entries WHERE id = ?",
                    (entry_id,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)

        if affected > 0 and self._collection is not None:
            try:
                self._collection.delete(ids=[entry_id])
            except Exception:
                pass

        return affected > 0

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    async def get_entry(self, entry_id: str) -> JournalEntry | None:
        def _work() -> JournalEntry | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_ENTRY_COLS} FROM journal_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
            return JournalEntry.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def get_entries(
        self,
        *,
        month: int | None = None,
        year: int | None = None,
        type: str | None = None,
        q: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[JournalEntry]:
        lim = max(1, min(int(limit), 500))
        off = max(0, int(offset))

        def _work() -> list[JournalEntry]:
            clauses: list[str] = []
            params: list[Any] = []

            if year is not None and month is not None:
                prefix = f"{year:04d}-{month:02d}"
                clauses.append("date LIKE ?")
                params.append(f"{prefix}%")
            elif year is not None:
                clauses.append("date LIKE ?")
                params.append(f"{year:04d}%")

            if type is not None:
                clauses.append("type = ?")
                params.append(type)

            if q:
                like = f"%{q}%"
                clauses.append(
                    "(LOWER(title) LIKE LOWER(?)"
                    " OR LOWER(content) LIKE LOWER(?)"
                    " OR LOWER(tags) LIKE LOWER(?))"
                )
                params.extend([like, like, like])

            where = ""
            if clauses:
                where = "WHERE " + " AND ".join(clauses)

            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_ENTRY_COLS} FROM journal_entries"
                    f" {where}"
                    " ORDER BY date DESC, created_at DESC"
                    " LIMIT ? OFFSET ?",
                    (*params, lim, off),
                ).fetchall()
            return [JournalEntry.from_row(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_stats(self) -> dict[str, int]:
        """Aggregate writing stats over the existing ``date`` column.

        Read-only: scans the distinct YYYY-MM-DD entry dates and computes the
        current consecutive-day streak (anchored to today/yesterday SP), the
        all-time longest streak, total entries, and distinct days logged.
        No schema change -- pure GROUP BY / scan over existing rows.
        """

        def _work() -> dict[str, int]:
            with self._store._connect() as conn:
                total_row = conn.execute(
                    "SELECT COUNT(*) FROM journal_entries",
                ).fetchone()
                date_rows = conn.execute(
                    "SELECT DISTINCT substr(date, 1, 10) AS d"
                    " FROM journal_entries"
                    " WHERE date IS NOT NULL AND date != ''"
                    " ORDER BY d ASC",
                ).fetchall()

            total_entries = int(total_row[0]) if total_row else 0

            days: list[date] = []
            for row in date_rows:
                raw = row[0]
                if not raw:
                    continue
                try:
                    days.append(date.fromisoformat(str(raw)[:10]))
                except (ValueError, TypeError):
                    continue

            days_logged = len(days)
            if not days:
                return {
                    "current_streak": 0,
                    "longest_streak": 0,
                    "total_entries": total_entries,
                    "days_logged": 0,
                }

            # Longest run of consecutive calendar days.
            longest = 1
            run = 1
            for prev, cur in zip(days, days[1:]):
                if (cur - prev).days == 1:
                    run += 1
                else:
                    run = 1
                if run > longest:
                    longest = run

            # Current streak: walk back from today (or yesterday) SP.
            day_set = set(days)
            today = _today_sp()
            cursor = today
            if today not in day_set:
                cursor = today - timedelta(days=1)
            current = 0
            while cursor in day_set:
                current += 1
                cursor -= timedelta(days=1)

            return {
                "current_streak": current,
                "longest_streak": longest,
                "total_entries": total_entries,
                "days_logged": days_logged,
            }

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Semantic search
    # ------------------------------------------------------------------

    async def search(self, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
        """Semantic search via ChromaDB embeddings.

        Returns list of dicts with ``id``, ``content`` (snippet), ``score``.
        Falls back to SQL LIKE if ChromaDB is unavailable.
        """
        if not query or not query.strip():
            return []

        if self._collection is None or self._embeddings is None:
            # Fallback: SQL text search
            entries = await self.get_entries(q=query, limit=limit)
            return [e.to_dict() for e in entries]

        try:
            vec = (await self._embeddings.embed([query]))[0]
        except Exception as e:
            logger.warning("journal search embed failed: %s", e)
            entries = await self.get_entries(q=query, limit=limit)
            return [e.to_dict() for e in entries]

        try:
            result = self._collection.query(
                query_embeddings=[vec],
                n_results=min(limit, 50),
            )
        except Exception as e:
            logger.warning("journal search chroma query failed: %s", e)
            entries = await self.get_entries(q=query, limit=limit)
            return [e.to_dict() for e in entries]

        ids = result.get("ids", [[]])[0]
        distances = result.get("distances", [[]])[0]
        if not ids:
            return []

        # Fetch full entries from SQLite
        out: list[dict[str, Any]] = []
        for doc_id, dist in zip(ids, distances):
            entry = await self.get_entry(doc_id)
            if entry is not None:
                d = entry.to_dict()
                d["score"] = round(1.0 - dist, 4) if dist is not None else None
                out.append(d)

        return out

    # ------------------------------------------------------------------
    # ChromaDB embedding helper
    # ------------------------------------------------------------------

    async def _embed(self, entry_id: str, content: str) -> None:
        """Best-effort: embed content into ChromaDB collection."""
        if self._collection is None or self._embeddings is None:
            return
        if not content or not content.strip():
            return
        try:
            vec = (await self._embeddings.embed([content]))[0]
            self._collection.upsert(
                ids=[entry_id],
                embeddings=[vec],
                documents=[content[:2000]],
                metadatas=[{"entry_id": entry_id}],
            )
        except Exception as e:
            logger.warning("journal embed failed for %s: %s", entry_id, e)
