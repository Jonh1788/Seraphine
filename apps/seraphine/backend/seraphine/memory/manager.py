from __future__ import annotations

import json
import logging
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Protocol

from pydantic import BaseModel

from llm_adapters.types import ChatMessage, Token
from seraphine.memory.embeddings import EmbeddingsClient
from seraphine.memory.store import Fact, MemoryStore, Turn

logger = logging.getLogger("seraphine.memory")

REFLECTION_SIM_THRESHOLD = 0.92
REFLECTION_MIN_TURNS = 5
REFLECTION_TURN_WINDOW = 100
# Facts with extraction confidence below this threshold are skipped.
REFLECTION_CONFIDENCE_THRESHOLD = 0.7
# Minimum character length for a turn to be considered signal-bearing.
_MIN_TURN_CHARS = 12

# Greetings / acks that the LLM should never try to extract facts from.
# Matched as full-message substrings after lowercasing + stripping punctuation.
_SKIP_SHORT_PHRASES = {
    "ok", "okay", "sim", "nao", "não", "yes", "no",
    "valeu", "obrigado", "obrigada", "tmj", "blz",
    "bom dia", "boa tarde", "boa noite",
    "oi", "olá", "ola", "hey", "hi", "hello", "eai", "eae",
    "kkk", "rs", "rsrs", "haha", "hehe",
    "show", "top", "massa", "legal", "beleza",
}
_PUNCT_STRIP = ".,!?;:()[]{}\"'`"


class _LLMLike(Protocol):
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = ...,
        temperature: float = ...,
    ) -> AsyncIterator[Token]: ...


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


_FACTS_PROMPT = (
    "Extract ONLY information worth remembering long-term about the user from"
    " the conversation excerpts below.\n\n"
    "DO extract:\n"
    "- User preferences (language, style, tools they like)\n"
    "- Personal info (name, location, job, relationships)\n"
    "- Important decisions made\n"
    "- Recurring patterns (always asks X at Y time)\n"
    "- Financial habits (regular expenses, income sources)\n"
    "- Contact relationships (who is Jefferson, who is Pedro)\n\n"
    "DO NOT extract: greetings, acknowledgments, tool outputs, temporary state,"
    " one-off questions, or anything transient.\n\n"
    "For each fact, estimate a confidence score in [0,1] reflecting how"
    " durable and well-supported it is. Return STRICT JSON:\n"
    '{"facts": [{"text": "<fact>", "confidence": 0.85}, ...]}\n'
    "If nothing qualifies, return {\"facts\": []}."
)


def _is_signal_turn(role: str, content: str) -> bool:
    """Filter heuristics: decide whether a turn is worth sending to the LLM.

    Skips tool-role messages, very short/greeting messages, and the
    assistant's own replies (we only mine the user side for facts).
    """
    if role != "user":
        return False
    text = (content or "").strip()
    if len(text) < _MIN_TURN_CHARS:
        return False
    normalized = text.lower().strip(_PUNCT_STRIP).strip()
    if normalized in _SKIP_SHORT_PHRASES:
        return False
    # Collapse internal whitespace for multi-word greetings like "bom dia!!"
    collapsed = " ".join(normalized.split())
    if collapsed in _SKIP_SHORT_PHRASES:
        return False
    return True


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
        llm: _LLMLike | None = None,
    ) -> None:
        self.store = store
        self.embeddings = embeddings
        self.chroma_path = Path(chroma_path)
        self.llm = llm
        self._collection: Any = None
        self._fact_embedding_cache: dict[str, list[float]] = {}

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
        fact = await self.store.add_fact(text=text, source=source, confidence=confidence)
        try:
            vecs = await self.embeddings.embed([text])
            self._fact_embedding_cache[fact.id] = vecs[0]
        except Exception as e:
            logger.warning("learn_fact: embed for cache failed: %s", e)
        return fact

    async def forget(self, memory_id: str) -> None:
        existing_fact = await self.store.get_fact(memory_id)
        if existing_fact is not None:
            # Self-supersede so list_facts (which filters WHERE superseded_by IS NULL)
            # excludes it. A real new fact id can also be passed via store.supersede_fact.
            await self.store.supersede_fact(memory_id, memory_id)
            self._fact_embedding_cache.pop(memory_id, None)
            return
        if self._collection is not None:
            self._collection.delete(ids=[memory_id])

    async def reflect(self) -> int:
        """Pull recent turns, ask the LLM to extract durable facts, dedup
        against existing facts via embedding cosine similarity, and persist
        the survivors. Returns the number of new facts inserted.
        Returns 0 (no-op) if no llm is wired or there is too little signal.
        """
        if self.llm is None:
            return 0
        try:
            recent = await self.store.get_recent_turns(limit=REFLECTION_TURN_WINDOW)
        except Exception as e:
            logger.warning("reflect: get_recent_turns failed: %s", e)
            return 0
        if len(recent) < REFLECTION_MIN_TURNS:
            return 0

        # Filter down to signal-bearing user turns before spending tokens.
        signal_turns = [t for t in recent if _is_signal_turn(t.role, t.content)]
        if len(signal_turns) < 2:
            return 0

        excerpts = "\n".join(f"- [{t.role}] {t.content}" for t in signal_turns)
        messages = [
            ChatMessage(role="system", content=_FACTS_PROMPT),
            ChatMessage(role="user", content=excerpts),
        ]
        accumulated: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.2):
                if tok.text:
                    accumulated.append(tok.text)
        except Exception as e:
            logger.warning("reflect: llm chat failed: %s", e)
            return 0

        raw = "".join(accumulated).strip()
        candidates = _parse_facts_json(raw)
        if not candidates:
            return 0

        # Apply confidence threshold — drop low-signal extractions early.
        candidates = [
            c for c in candidates if c[1] >= REFLECTION_CONFIDENCE_THRESHOLD
        ]
        if not candidates:
            return 0

        # Dedup against existing non-superseded facts using cached embeddings.
        existing = await self.store.list_facts(limit=200)

        # Only embed facts not already in cache.
        uncached = [f for f in existing if f.id not in self._fact_embedding_cache]
        if uncached:
            try:
                new_vecs = await self.embeddings.embed([f.text for f in uncached])
                for fact, vec in zip(uncached, new_vecs):
                    self._fact_embedding_cache[fact.id] = vec
            except Exception as e:
                logger.warning("reflect: embed uncached facts failed: %s", e)

        existing_vecs = [
            self._fact_embedding_cache[f.id]
            for f in existing
            if f.id in self._fact_embedding_cache
        ]

        try:
            cand_vecs = await self.embeddings.embed([c[0] for c in candidates])
        except Exception as e:
            logger.warning("reflect: embed candidates failed: %s", e)
            return 0

        inserted = 0
        for (text, confidence), vec in zip(candidates, cand_vecs):
            duplicate = False
            for ev in existing_vecs:
                if _cosine(vec, ev) >= REFLECTION_SIM_THRESHOLD:
                    duplicate = True
                    break
            if duplicate:
                continue
            fact = await self.store.add_fact(
                text=text, source="reflection", confidence=confidence,
            )
            self._fact_embedding_cache[fact.id] = vec
            existing_vecs.append(vec)
            inserted += 1
        return inserted


_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_facts_json(raw: str) -> list[tuple[str, float]]:
    """Tolerant extractor: pulls the first JSON object from ``raw`` and
    returns its ``facts`` array as ``[(text, confidence), ...]``.

    Accepts both the legacy string shape (``["fact", ...]``, defaulting
    to confidence 0.7) and the richer object shape
    (``[{"text": "...", "confidence": 0.85}, ...]``). Malformed entries
    are dropped silently.
    """
    if not raw:
        return []
    match = _JSON_OBJ_RE.search(raw)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    facts = data.get("facts") if isinstance(data, dict) else None
    if not isinstance(facts, list):
        return []
    out: list[tuple[str, float]] = []
    for f in facts:
        if isinstance(f, str):
            s = f.strip()
            if s:
                out.append((s, 0.7))
            continue
        if isinstance(f, dict):
            text = f.get("text")
            if not isinstance(text, str):
                continue
            s = text.strip()
            if not s:
                continue
            raw_conf = f.get("confidence", 0.7)
            try:
                conf = float(raw_conf)
            except (TypeError, ValueError):
                conf = 0.7
            conf = max(0.0, min(1.0, conf))
            out.append((s, conf))
    return out
