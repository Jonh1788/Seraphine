from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from seraphine.memory.embeddings import EmbeddingsClient
from seraphine.memory.store import Fact, MemoryStore, Turn

logger = logging.getLogger("seraphine.memory")


class Memory(BaseModel):
    id: str
    kind: Literal["episode", "fact"]
    text: str
    score: float | None = None
    created_at: datetime
    metadata: dict[str, Any] = {}


class MemoryManager:
    def __init__(
        self,
        store: MemoryStore,
        embeddings: EmbeddingsClient,
        chroma_path: Path,
    ) -> None:
        self.store = store
        self.embeddings = embeddings
        self.chroma_path = Path(chroma_path)
        self._collection: Any = None

    async def start(self) -> None:
        if self._collection is not None:
            return
        # Local import so this module is importable without chromadb installed.
        import chromadb  # type: ignore[import-not-found]

        self.chroma_path.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(self.chroma_path))
        self._collection = client.get_or_create_collection("seraphine_episodes")

    def set_collection_for_tests(self, collection: Any) -> None:
        self._collection = collection

    async def remember_episode(self, turn: Turn) -> None:
        if self._collection is None:
            return
        try:
            vec = (await self.embeddings.embed([turn.content]))[0]
        except Exception as e:  # pragma: no cover - best-effort
            logger.warning("embed failed for turn %s: %s", turn.id, e)
            return
        self._collection.add(
            ids=[turn.id],
            embeddings=[vec],
            documents=[turn.content],
            metadatas=[
                {
                    "role": turn.role,
                    "conversation_id": turn.conversation_id,
                    "created_at": turn.created_at,
                }
            ],
        )

    async def recall(self, query: str, *, k: int = 5) -> list[Memory]:
        if self._collection is None:
            return []
        try:
            qvec = (await self.embeddings.embed([query]))[0]
        except Exception as e:
            logger.warning("recall embed failed: %s", e)
            return []
        result = self._collection.query(query_embeddings=[qvec], n_results=k)
        ids = (result.get("ids") or [[]])[0]
        docs = (result.get("documents") or [[]])[0]
        metas = (result.get("metadatas") or [[]])[0]
        dists = (result.get("distances") or [[None] * len(ids)])[0]
        out: list[Memory] = []
        for i, doc in enumerate(docs):
            meta = metas[i] if i < len(metas) and metas[i] else {}
            created_at_raw = meta.get("created_at") if meta else None
            try:
                created_at = (
                    datetime.fromisoformat(created_at_raw)
                    if isinstance(created_at_raw, str)
                    else datetime.now()
                )
            except ValueError:
                created_at = datetime.now()
            out.append(
                Memory(
                    id=ids[i] if i < len(ids) else f"unknown-{i}",
                    kind="episode",
                    text=doc,
                    score=dists[i] if i < len(dists) else None,
                    created_at=created_at,
                    metadata=meta or {},
                )
            )
        return out

    async def learn_fact(
        self,
        text: str,
        *,
        source: str = "explicit",
        confidence: float = 1.0,
    ) -> Fact:
        return await self.store.add_fact(text=text, source=source, confidence=confidence)

    async def forget(self, memory_id: str) -> None:
        existing_fact = await self.store.get_fact(memory_id)
        if existing_fact is not None:
            # Self-supersede so list_facts (which filters WHERE superseded_by IS NULL)
            # excludes it. A real new fact id can also be passed via store.supersede_fact.
            await self.store.supersede_fact(memory_id, memory_id)
            return
        if self._collection is not None:
            self._collection.delete(ids=[memory_id])

    async def reflect(self) -> int:
        # TODO(phase 5): real reflection job using LLM extraction.
        return 0
