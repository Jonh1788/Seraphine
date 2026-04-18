from __future__ import annotations

import json
import logging
import math
import re
from datetime import datetime, timezone
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

_ASSISTANT_INSIGHTS_PROMPT = (
    "Analyze the assistant turns below and extract DURABLE OBSERVATIONS"
    " about the user that the assistant identified or inferred.\n\n"
    "DO extract:\n"
    "- User emotional state patterns the assistant noticed\n"
    "- Behavioral patterns (tone, recurring topics, habits)\n"
    "- Preferences the assistant learned from context\n"
    "- Relationship dynamics the assistant inferred\n\n"
    "DO NOT extract: greetings, tool call summaries, instructions to the user,"
    " transient status, or anything the user said directly.\n\n"
    "For each observation, estimate a confidence score in [0,1]. Return STRICT JSON:\n"
    '{"facts": [{"text": "<observation>", "confidence": 0.85}, ...]}\n'
    "If nothing qualifies, return {\"facts\": []}."
)

# Greeting/ack prefixes that disqualify assistant turns from observation mining.
_ASSISTANT_SKIP_PREFIXES = (
    "ok", "okay", "certo", "entend", "claro", "sure", "got it",
    "understood", "all right", "alright",
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


def _is_signal_assistant_turn(role: str, content: str) -> bool:
    """Heuristic for assistant turns worth mining for user observations."""
    if role != "assistant":
        return False
    text = (content or "").strip()
    if len(text) < 40:
        return False
    lower = text.lower()
    for prefix in _ASSISTANT_SKIP_PREFIXES:
        if lower.startswith(prefix):
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
        *,
        embedding_model: str = "unknown",
    ) -> None:
        self.store = store
        self.embeddings = embeddings
        self.chroma_path = Path(chroma_path)
        self.llm = llm
        # Tag used to namespace cached fact embeddings. If this changes,
        # load_fact_embeddings returns {} and reflect re-embeds from
        # scratch — avoids mixing vectors from incompatible models.
        self.embedding_model = embedding_model
        self._collection: Any = None
        self._fact_embedding_cache: dict[str, list[float]] = {}

    async def start(self) -> None:
        # Hydrate the fact embedding cache from SQLite so the first
        # reflect() after boot doesn't re-embed up to 200 facts.
        try:
            cached = await self.store.load_fact_embeddings(
                model=self.embedding_model,
            )
            self._fact_embedding_cache.update(cached)
            if cached:
                logger.info(
                    "memory: hydrated %d fact embedding(s) from cache (model=%s)",
                    len(cached), self.embedding_model,
                )
        except Exception as e:  # pragma: no cover - best-effort
            logger.warning("memory: fact embedding hydrate failed: %s", e)

        if self._collection is not None:
            return
        # Local import so this module is importable without chromadb installed.
        import chromadb  # type: ignore[import-not-found]

        self.chroma_path.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(self.chroma_path))
        self._collection = client.get_or_create_collection("seraphine_episodes")

    def set_collection_for_tests(self, collection: Any) -> None:
        self._collection = collection

    async def _log_warning(self, stage: str, err: Exception) -> None:
        """Best-effort: record an embed/recall failure on event_timeline.

        Keeps /memory/health honest without flooding logs or retrying
        inside the hot path. Swallows any error from add_event itself.
        """
        try:
            await self.store.add_event(
                event_type="warning",
                summary=f"{stage}: {str(err)[:200]}",
                source="memory",
                metadata={"stage": stage},
            )
        except Exception:  # pragma: no cover - observability must not break flow
            pass

    async def remember_episode(self, turn: Turn) -> None:
        if self._collection is None:
            return
        try:
            vec = (await self.embeddings.embed([turn.content]))[0]
        except Exception as e:  # pragma: no cover - best-effort
            logger.warning("embed failed for turn %s: %s", turn.id, e)
            await self._log_warning("remember_episode.embed", e)
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

    async def recall(
        self, query: str, *, k: int = 5, decay_days: float = 30.0,
    ) -> list[Memory]:
        if self._collection is None:
            return []

        # --- vector retrieval (overshoot for RRF fusion) ---
        try:
            qvec = (await self.embeddings.embed([query]))[0]
        except Exception as e:
            logger.warning("recall embed failed: %s", e)
            await self._log_warning("recall.embed", e)
            return []
        n_vector = max(k, 20)
        result = self._collection.query(query_embeddings=[qvec], n_results=n_vector)
        vec_ids = (result.get("ids") or [[]])[0]
        vec_docs = (result.get("documents") or [[]])[0]
        vec_metas = (result.get("metadatas") or [[]])[0]
        vec_dists = (result.get("distances") or [[None] * len(vec_ids)])[0]

        # Build per-id info map from vector results.
        info: dict[str, dict[str, Any]] = {}
        for i, vid in enumerate(vec_ids):
            meta = vec_metas[i] if i < len(vec_metas) and vec_metas[i] else {}
            info[vid] = {
                "text": vec_docs[i] if i < len(vec_docs) else "",
                "metadata": meta,
                "dist": vec_dists[i] if i < len(vec_dists) else None,
            }

        # --- FTS retrieval ---
        try:
            fts_results = await self.store.fts_search_turns(query, k=max(k, 20))
        except Exception:
            fts_results = []

        # --- RRF fusion ---
        rrf_scores: dict[str, float] = {}
        rrf_k = 60  # standard RRF constant
        for rank, vid in enumerate(vec_ids):
            rrf_scores[vid] = rrf_scores.get(vid, 0.0) + 1.0 / (rrf_k + rank)
        for rank, (tid, _bm25) in enumerate(fts_results):
            rrf_scores[tid] = rrf_scores.get(tid, 0.0) + 1.0 / (rrf_k + rank)
            if tid not in info:
                # FTS-only hit — fetch the turn to populate info.
                try:
                    turn = await self.store.get_turn(tid)
                    if turn:
                        info[tid] = {
                            "text": turn.content,
                            "metadata": {
                                "role": turn.role,
                                "conversation_id": turn.conversation_id,
                                "created_at": turn.created_at,
                            },
                            "dist": None,
                        }
                except Exception:
                    pass

        if not rrf_scores:
            return []

        # If FTS returned nothing, fall through to vector-only (rrf_scores
        # already populated from vector path).

        # Sort by RRF score descending, take top-k.
        sorted_ids = sorted(rrf_scores, key=lambda x: -rrf_scores[x])

        # --- time-weight reranking ---
        now = datetime.now(timezone.utc)
        ranked: list[tuple[str, float]] = []
        for sid in sorted_ids:
            base = rrf_scores[sid]
            meta = info.get(sid, {}).get("metadata", {})
            ca_raw = meta.get("created_at")
            if decay_days > 0 and ca_raw:
                try:
                    ca = datetime.fromisoformat(ca_raw)
                    if ca.tzinfo is None:
                        ca = ca.replace(tzinfo=timezone.utc)
                    age = (now - ca).total_seconds() / 86400
                    base = base * math.exp(-age / decay_days)
                except (ValueError, TypeError):
                    pass
            ranked.append((sid, base))
        ranked.sort(key=lambda x: -x[1])
        top = ranked[:k]

        out: list[Memory] = []
        for sid, score in top:
            entry = info.get(sid)
            if not entry:
                continue
            meta = entry.get("metadata") or {}
            ca_raw = meta.get("created_at")
            try:
                created_at = (
                    datetime.fromisoformat(ca_raw)
                    if isinstance(ca_raw, str)
                    else datetime.now()
                )
            except ValueError:
                created_at = datetime.now()
            out.append(
                Memory(
                    id=sid,
                    kind="episode",
                    text=entry["text"],
                    score=score,
                    created_at=created_at,
                    metadata=meta,
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
            await self.store.save_fact_embedding(
                fact.id, vecs[0], model=self.embedding_model,
            )
        except Exception as e:
            logger.warning("learn_fact: embed for cache failed: %s", e)
            await self._log_warning("learn_fact.embed", e)
        return fact

    async def forget(self, memory_id: str) -> None:
        existing_fact = await self.store.get_fact(memory_id)
        if existing_fact is not None:
            # Self-supersede so list_facts (which filters WHERE superseded_by IS NULL)
            # excludes it. A real new fact id can also be passed via store.supersede_fact.
            await self.store.supersede_fact(memory_id, memory_id)
            self._fact_embedding_cache.pop(memory_id, None)
            try:
                await self.store.delete_fact_embedding(memory_id)
            except Exception:  # pragma: no cover
                pass
            return
        if self._collection is not None:
            self._collection.delete(ids=[memory_id])

    async def _reflect_pass(
        self,
        turns: list[Turn],
        prompt: str,
        source: str,
        existing: list[Fact],
        existing_vecs: list[list[float]],
        *,
        confidence_cap: float | None = None,
    ) -> tuple[int, int]:
        """Run one LLM extraction pass and dedup+persist the results.

        Mutates ``existing_vecs`` in-place (appends new vectors) so the
        next pass sees facts from this one for dedup.

        Returns (inserted, candidate_count).
        """
        assert self.llm is not None
        excerpts = "\n".join(f"- [{t.role}] {t.content}" for t in turns)
        messages = [
            ChatMessage(role="system", content=prompt),
            ChatMessage(role="user", content=excerpts),
        ]
        accumulated: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.2):
                if tok.text:
                    accumulated.append(tok.text)
        except Exception as e:
            logger.warning("reflect(%s): llm chat failed: %s", source, e)
            return 0, 0

        raw = "".join(accumulated).strip()
        candidates = _parse_facts_json(raw)
        if not candidates:
            return 0, 0

        candidates = [
            c for c in candidates if c[1] >= REFLECTION_CONFIDENCE_THRESHOLD
        ]
        if not candidates:
            return 0, len(candidates)

        try:
            cand_vecs = await self.embeddings.embed([c[0] for c in candidates])
        except Exception as e:
            logger.warning("reflect(%s): embed candidates failed: %s", source, e)
            await self._log_warning(f"reflect.embed_candidates.{source}", e)
            return 0, len(candidates)

        inserted = 0
        for (text, confidence), vec in zip(candidates, cand_vecs):
            if confidence_cap is not None:
                confidence = min(confidence, confidence_cap)
            duplicate = False
            for idx, ev in enumerate(existing_vecs):
                if _cosine(vec, ev) >= REFLECTION_SIM_THRESHOLD:
                    duplicate = True
                    if idx < len(existing):
                        try:
                            await self.store.bump_fact_used(existing[idx].id)
                        except Exception:  # pragma: no cover
                            pass
                    break
            if duplicate:
                continue
            fact = await self.store.add_fact(
                text=text, source=source, confidence=confidence,
            )
            self._fact_embedding_cache[fact.id] = vec
            try:
                await self.store.save_fact_embedding(
                    fact.id, vec, model=self.embedding_model,
                )
            except Exception:  # pragma: no cover
                pass
            existing_vecs.append(vec)
            inserted += 1
        return inserted, len(candidates)

    async def reflect(self) -> int:
        """Pull recent turns, ask the LLM to extract durable facts, dedup
        against existing facts via embedding cosine similarity, and persist
        the survivors. Returns the number of new facts inserted.
        Returns 0 (no-op) if no llm is wired or there is too little signal.

        Runs two passes:
          1. User turns  -> source="reflection" (no confidence cap)
          2. Assistant turns -> source="observation" (confidence capped at 0.7)
        Dedup is shared: a fact from pass 2 that duplicates pass 1 is dropped.
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

        # Filter down to signal-bearing turns per role.
        user_turns = [t for t in recent if _is_signal_turn(t.role, t.content)]
        assistant_turns = [
            t for t in recent if _is_signal_assistant_turn(t.role, t.content)
        ]
        if len(user_turns) < 2 and not assistant_turns:
            return 0

        # Build shared dedup baseline from existing facts.
        existing = await self.store.list_facts(limit=200)
        uncached = [f for f in existing if f.id not in self._fact_embedding_cache]
        if uncached:
            try:
                new_vecs = await self.embeddings.embed([f.text for f in uncached])
                for fact, vec in zip(uncached, new_vecs):
                    self._fact_embedding_cache[fact.id] = vec
                    try:
                        await self.store.save_fact_embedding(
                            fact.id, vec, model=self.embedding_model,
                        )
                    except Exception:  # pragma: no cover
                        pass
            except Exception as e:
                logger.warning("reflect: embed uncached facts failed: %s", e)
                await self._log_warning("reflect.embed_uncached", e)

        existing_vecs: list[list[float]] = [
            self._fact_embedding_cache[f.id]
            for f in existing
            if f.id in self._fact_embedding_cache
        ]

        inserted_reflection = 0
        inserted_observation = 0
        candidates_total = 0

        # Pass 1: user turns
        if len(user_turns) >= 2:
            n, c = await self._reflect_pass(
                user_turns, _FACTS_PROMPT, "reflection",
                existing, existing_vecs,
            )
            inserted_reflection = n
            candidates_total += c

        # Pass 2: assistant turns
        if assistant_turns:
            n, c = await self._reflect_pass(
                assistant_turns, _ASSISTANT_INSIGHTS_PROMPT, "observation",
                existing, existing_vecs,
                confidence_cap=0.7,
            )
            inserted_observation = n
            candidates_total += c

        inserted_total = inserted_reflection + inserted_observation
        try:
            await self.store.add_event(
                event_type="reflect_success",
                summary=f"reflect: +{inserted_total} fact(s)",
                source="memory",
                metadata={
                    "inserted": inserted_total,
                    "inserted_reflection": inserted_reflection,
                    "inserted_observation": inserted_observation,
                    "candidates": candidates_total,
                },
            )
        except Exception:  # pragma: no cover
            pass
        return inserted_total

    async def decay_facts(self) -> int:
        """Exponentially decay facts by age since last use/creation.

        Facts whose adjusted confidence drops below 0.3 are self-superseded
        (soft-deleted) so they stop appearing in active lists but remain
        auditable.  Returns count of superseded facts.
        """
        facts = await self.store.list_facts_for_decay()
        now = datetime.now(timezone.utc)
        superseded = 0
        for f in facts:
            # Use last_used_at if available, else fall back to created_at.
            ref = f.last_used_at or f.created_at
            try:
                ref_dt = datetime.fromisoformat(ref)
            except (ValueError, TypeError):
                continue
            # Make timezone-aware if naive.
            if ref_dt.tzinfo is None:
                ref_dt = ref_dt.replace(tzinfo=timezone.utc)
            age_days = (now - ref_dt).total_seconds() / 86400
            adjusted = f.confidence * math.exp(-age_days / 90)
            if adjusted < 0.3:
                await self.store.supersede_fact(f.id, f.id)
                self._fact_embedding_cache.pop(f.id, None)
                try:
                    await self.store.add_event(
                        event_type="decay_superseded",
                        summary=f"decay: fact {f.id[:8]}… (adj={adjusted:.3f})",
                        source="memory",
                        metadata={
                            "fact_id": f.id,
                            "age_days": round(age_days, 1),
                            "adjusted_confidence": round(adjusted, 4),
                        },
                    )
                except Exception:  # pragma: no cover
                    pass
                superseded += 1
        return superseded


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
