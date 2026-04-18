from __future__ import annotations

import json
import logging
import math
import re
import uuid
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
# Episode windowing: group consecutive turns into chunks for richer context.
WINDOW_SIZE = 8
WINDOW_GAP_SECONDS = 600

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


def _build_chroma_where(
    *,
    conversation_id: str | None = None,
    role: str | None = None,
    since: str | None = None,
    until: str | None = None,
) -> dict[str, Any] | None:
    """Build a Chroma ``where`` filter dict from optional recall kwargs.

    Returns None if no filters are active.
    """
    clauses: list[dict[str, Any]] = []
    if conversation_id:
        clauses.append({"conversation_id": conversation_id})
    if role:
        clauses.append({"role": role})
    if since:
        clauses.append({"created_at": {"$gte": since}})
    if until:
        clauses.append({"created_at": {"$lte": until}})
    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


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

_CONTRADICTION_PROMPT = (
    "Given pairs of (existing_fact, new_fact), decide for each pair whether"
    " new_fact CONTRADICTS existing_fact (updates its value). Return STRICT"
    ' JSON: {"contradictions": [{"existing_id": "...", "new_index": N,'
    ' "reason": "..."}]}. If none contradict, return {"contradictions": []}.'
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
    kind: Literal["episode", "fact", "window"]
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
        self._window_buffer: dict[str, list[Turn]] = {}

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
        # --- windowing ---
        conv = turn.conversation_id
        buf = self._window_buffer.setdefault(conv, [])
        # Check gap: if the last turn in the buffer and this turn have
        # a time gap >= WINDOW_GAP_SECONDS, flush before appending.
        if buf:
            try:
                last_dt = datetime.fromisoformat(buf[-1].created_at)
                cur_dt = datetime.fromisoformat(turn.created_at)
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=timezone.utc)
                if cur_dt.tzinfo is None:
                    cur_dt = cur_dt.replace(tzinfo=timezone.utc)
                gap = (cur_dt - last_dt).total_seconds()
                if gap >= WINDOW_GAP_SECONDS:
                    await self._flush_window(conv)
            except (ValueError, TypeError):
                pass
        buf = self._window_buffer.setdefault(conv, [])
        buf.append(turn)
        if len(buf) >= WINDOW_SIZE:
            await self._flush_window(conv)

    async def _flush_window(self, conversation_id: str) -> None:
        """Concatenate buffered turns into an episode window, persist, and embed."""
        buf = self._window_buffer.pop(conversation_id, [])
        if len(buf) < 2:
            # Single-turn windows add no context beyond the individual turn
            # already indexed in chroma. Skip creating a window.
            return
        text = "\n".join(f"[{t.role}] {t.content}" for t in buf)
        win_id = str(uuid.uuid4())
        first = buf[0]
        last = buf[-1]
        now = datetime.now(timezone.utc).isoformat()
        await self.store.add_episode_window(
            id=win_id,
            conversation_id=conversation_id,
            first_turn_id=first.id,
            last_turn_id=last.id,
            turn_count=len(buf),
            text=text,
            started_at=first.created_at,
            ended_at=last.created_at,
            created_at=now,
        )
        if self._collection is None:
            return
        try:
            vec = (await self.embeddings.embed([text]))[0]
        except Exception as e:
            logger.warning("flush_window embed failed: %s", e)
            await self._log_warning("flush_window.embed", e)
            return
        self._collection.add(
            ids=[win_id],
            embeddings=[vec],
            documents=[text],
            metadatas=[
                {
                    "kind": "window",
                    "conversation_id": conversation_id,
                    "first_turn_id": first.id,
                    "last_turn_id": last.id,
                    "created_at": last.created_at,
                }
            ],
        )

    async def recall(
        self,
        query: str,
        *,
        k: int = 5,
        decay_days: float = 30.0,
        conversation_id: str | None = None,
        role: str | None = None,
        since: str | None = None,
        until: str | None = None,
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

        # Build Chroma where-filter from optional kwargs.
        chroma_where = _build_chroma_where(
            conversation_id=conversation_id,
            role=role,
            since=since,
            until=until,
        )
        query_kwargs: dict[str, Any] = {
            "query_embeddings": [qvec],
            "n_results": n_vector,
        }
        if chroma_where:
            query_kwargs["where"] = chroma_where
        try:
            result = self._collection.query(**query_kwargs)
        except Exception:
            # Chroma may fail if metadata fields don't exist on stored docs;
            # fall back to unfiltered query.
            result = self._collection.query(
                query_embeddings=[qvec], n_results=n_vector,
            )
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
            fts_results = await self.store.fts_search_turns(
                query, k=max(k, 20),
                conversation_id=conversation_id,
                role=role,
                since=since,
                until=until,
            )
        except Exception:
            fts_results = []

        # --- fact semantic retrieval (third modality) ---
        # Scan the in-memory fact embedding cache and rank by cosine to the
        # query vector. Facts are curated signal — surfacing them alongside
        # turns and windows gives recall much richer context.
        # Note: facts are global — conversation_id and role filters do NOT
        # apply to them (facts aren't per-conversation). Only since/until
        # filter on fact.created_at, applied after fetching the fact object.
        fact_ranked: list[tuple[str, float]] = []
        for fid, fvec in self._fact_embedding_cache.items():
            cos = _cosine(qvec, fvec)
            fact_ranked.append((fid, cos))
        fact_ranked.sort(key=lambda x: -x[1])
        fact_top = fact_ranked[:10]

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
        # Facts as third RRF list.
        for rank, (fid, _cos) in enumerate(fact_top):
            rrf_scores[fid] = rrf_scores.get(fid, 0.0) + 1.0 / (rrf_k + rank)

        if not rrf_scores:
            return []

        # Populate info entries for fact hits so we can build Memory objects.
        fact_ids_in_rrf = {fid for fid, _ in fact_top if fid in rrf_scores}
        for fid in fact_ids_in_rrf:
            if fid not in info:
                try:
                    fact = await self.store.get_fact(fid)
                    if fact and fact.superseded_by is None:
                        # Apply time filters to facts (since/until on created_at).
                        if since and fact.created_at < since:
                            rrf_scores.pop(fid, None)
                            continue
                        if until and fact.created_at > until:
                            rrf_scores.pop(fid, None)
                            continue
                        info[fid] = {
                            "text": fact.text,
                            "metadata": {
                                "kind": "fact",
                                "source": fact.source,
                                "confidence": fact.confidence,
                                "created_at": fact.created_at,
                            },
                            "dist": None,
                        }
                    else:
                        # Superseded or deleted fact — remove from RRF.
                        rrf_scores.pop(fid, None)
                except Exception:
                    rrf_scores.pop(fid, None)

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

        # --- window / turn dedup ---
        # If a window and one of its constituent turns both appear,
        # prefer the window (richer context) and drop the turn.
        window_turn_ids: dict[str, set[str]] = {}  # window_id -> {turn_ids covered}
        for sid in [r[0] for r in ranked]:
            entry = info.get(sid)
            if not entry:
                continue
            meta = entry.get("metadata") or {}
            if meta.get("kind") == "window":
                first = meta.get("first_turn_id")
                last = meta.get("last_turn_id")
                if first and last:
                    # Collect all turn IDs in the collection that belong to
                    # this window's range. Since we don't have all turn IDs
                    # in the window, approximate by marking the known ones.
                    window_turn_ids[sid] = {first, last}

        # Build the set of turn IDs that are covered by any window in results.
        covered_by_windows: set[str] = set()
        for wid, tids in window_turn_ids.items():
            covered_by_windows.update(tids)

        # --- fact dedup: if two facts have cosine > 0.98, keep higher confidence ---
        fact_entries = [
            (sid, score) for sid, score in ranked
            if (info.get(sid, {}).get("metadata") or {}).get("kind") == "fact"
        ]
        suppressed_facts: set[str] = set()
        for i, (fid_a, _) in enumerate(fact_entries):
            if fid_a in suppressed_facts:
                continue
            vec_a = self._fact_embedding_cache.get(fid_a)
            if vec_a is None:
                continue
            meta_a = info.get(fid_a, {}).get("metadata", {})
            conf_a = meta_a.get("confidence", 0.0)
            for j in range(i + 1, len(fact_entries)):
                fid_b = fact_entries[j][0]
                if fid_b in suppressed_facts:
                    continue
                vec_b = self._fact_embedding_cache.get(fid_b)
                if vec_b is None:
                    continue
                if _cosine(vec_a, vec_b) > 0.98:
                    meta_b = info.get(fid_b, {}).get("metadata", {})
                    conf_b = meta_b.get("confidence", 0.0)
                    suppressed_facts.add(fid_b if conf_a >= conf_b else fid_a)

        out: list[Memory] = []
        for sid, score in ranked:
            if len(out) >= k:
                break
            entry = info.get(sid)
            if not entry:
                continue
            meta = entry.get("metadata") or {}
            kind_str = meta.get("kind", "episode")
            # Skip turn-level results whose ID is covered by a window.
            if kind_str != "window" and kind_str != "fact" and sid in covered_by_windows:
                continue
            # Skip duplicate facts.
            if kind_str == "fact" and sid in suppressed_facts:
                continue
            ca_raw = meta.get("created_at")
            try:
                created_at = (
                    datetime.fromisoformat(ca_raw)
                    if isinstance(ca_raw, str)
                    else datetime.now()
                )
            except ValueError:
                created_at = datetime.now()
            if kind_str == "fact":
                mem_kind: Literal["episode", "fact", "window"] = "fact"
            elif kind_str == "window":
                mem_kind = "window"
            else:
                mem_kind = "episode"
            out.append(
                Memory(
                    id=sid,
                    kind=mem_kind,
                    text=entry["text"],
                    score=score,
                    created_at=created_at,
                    metadata=meta,
                )
            )
            # Bump last_used_at for recalled facts — reinforces relevance
            # and delays decay.
            if kind_str == "fact":
                try:
                    await self.store.bump_fact_used(sid)
                except Exception:  # pragma: no cover
                    pass
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
    ) -> tuple[int, int, list[tuple[Fact, list[float]]]]:
        """Run one LLM extraction pass and dedup+persist the results.

        Mutates ``existing_vecs`` in-place (appends new vectors) so the
        next pass sees facts from this one for dedup.

        Returns (inserted, candidate_count, [(fact, vec), ...] of inserted).
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
            return 0, 0, []

        raw = "".join(accumulated).strip()
        candidates = _parse_facts_json(raw)
        if not candidates:
            return 0, 0, []

        candidates = [
            c for c in candidates if c[1] >= REFLECTION_CONFIDENCE_THRESHOLD
        ]
        if not candidates:
            return 0, len(candidates), []

        try:
            cand_vecs = await self.embeddings.embed([c[0] for c in candidates])
        except Exception as e:
            logger.warning("reflect(%s): embed candidates failed: %s", source, e)
            await self._log_warning(f"reflect.embed_candidates.{source}", e)
            return 0, len(candidates), []

        inserted = 0
        inserted_facts: list[tuple[Fact, list[float]]] = []
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
            inserted_facts.append((fact, vec))
            inserted += 1
        return inserted, len(candidates), inserted_facts

    async def _detect_contradictions(
        self,
        new_facts: list[tuple[Fact, list[float]]],
        existing: list[Fact],
    ) -> None:
        """Check whether any newly inserted fact contradicts an existing one.

        Uses cosine similarity to find candidate pairs (in the "related
        but not paraphrase" band) then asks the LLM to confirm. Confirmed
        contradictions result in the old fact being superseded by the new.

        Protected by try/except — a failure here must not break reflect().
        """
        if self.llm is None:
            return
        try:
            # Build candidate pairs: new_fact vs existing_fact where
            # cosine is in [0.5, REFLECTION_SIM_THRESHOLD).
            pairs: list[tuple[int, str, str, str]] = []  # (new_idx, exist_id, new_text, exist_text)
            for new_idx, (nf, nvec) in enumerate(new_facts):
                for ef in existing:
                    evec = self._fact_embedding_cache.get(ef.id)
                    if evec is None:
                        continue
                    cos = _cosine(nvec, evec)
                    if 0.5 <= cos < REFLECTION_SIM_THRESHOLD:
                        pairs.append((new_idx, ef.id, nf.text, ef.text))

            if not pairs:
                return

            # Build prompt for the LLM.
            pair_lines: list[str] = []
            for i, (new_idx, exist_id, new_text, exist_text) in enumerate(pairs):
                pair_lines.append(
                    f"{i}. existing_id={exist_id}: \"{exist_text}\" vs "
                    f"new_index={new_idx}: \"{new_text}\""
                )
            user_content = "\n".join(pair_lines)
            messages = [
                ChatMessage(role="system", content=_CONTRADICTION_PROMPT),
                ChatMessage(role="user", content=user_content),
            ]
            accumulated: list[str] = []
            async for tok in self.llm.chat(messages, temperature=0.1):
                if tok.text:
                    accumulated.append(tok.text)

            raw = "".join(accumulated).strip()
            parsed = _parse_contradictions_json(raw)
            if not parsed:
                return

            # Map new_index -> inserted Fact for supersede.
            new_by_idx = {i: f for i, (f, _) in enumerate(new_facts)}
            superseded_count = 0
            for item in parsed:
                exist_id = item.get("existing_id")
                new_idx = item.get("new_index")
                if exist_id is None or new_idx is None:
                    continue
                new_fact = new_by_idx.get(new_idx)
                if new_fact is None:
                    continue
                await self.store.supersede_fact(exist_id, new_fact.id)
                # Remove superseded fact from embedding cache.
                self._fact_embedding_cache.pop(exist_id, None)
                superseded_count += 1

            if superseded_count > 0:
                await self.store.add_event(
                    event_type="contradiction_supersede",
                    summary=f"contradiction: {superseded_count} superseded",
                    source="memory",
                    metadata={
                        "pairs": len(pairs),
                        "superseded": superseded_count,
                    },
                )
        except Exception as e:
            logger.warning("contradiction detection failed: %s", e)

    async def reflect(self) -> int:
        """Pull recent turns, ask the LLM to extract durable facts, dedup
        against existing facts via embedding cosine similarity, and persist
        the survivors. Returns the number of new facts inserted.
        Returns 0 (no-op) if no llm is wired or there is too little signal.

        Uses an incremental cursor so that successive calls only process
        turns added since the last successful reflect — avoids re-reading
        the same 97 turns on every 3-turn tick.

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

        # --- incremental cursor: only process turns newer than last reflect ---
        cursor = await self.store.get_reflect_cursor(None)
        if cursor is not None:
            cursor_updated = cursor["updated_at"]
            # Keep only turns created strictly after the cursor timestamp.
            recent = [t for t in recent if t.created_at > cursor_updated]
            if not recent:
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
        all_inserted: list[tuple[Fact, list[float]]] = []

        # Pass 1: user turns
        if len(user_turns) >= 2:
            n, c, facts_vecs = await self._reflect_pass(
                user_turns, _FACTS_PROMPT, "reflection",
                existing, existing_vecs,
            )
            inserted_reflection = n
            candidates_total += c
            all_inserted.extend(facts_vecs)

        # Pass 2: assistant turns
        if assistant_turns:
            n, c, facts_vecs = await self._reflect_pass(
                assistant_turns, _ASSISTANT_INSIGHTS_PROMPT, "observation",
                existing, existing_vecs,
                confidence_cap=0.7,
            )
            inserted_observation = n
            candidates_total += c
            all_inserted.extend(facts_vecs)

        # --- contradiction detection ---
        # Compare newly inserted facts against pre-existing ones. Pairs
        # with cosine in [0.5, REFLECTION_SIM_THRESHOLD) are candidates
        # for semantic contradictions (not paraphrases, not unrelated).
        if all_inserted and existing:
            await self._detect_contradictions(
                all_inserted, existing,
            )

        inserted_total = inserted_reflection + inserted_observation

        # Advance the global reflect cursor to the most recent turn processed,
        # so the next reflect() skips everything up to this point.
        if recent:
            last_turn = recent[-1]  # turns are in chronological order
            try:
                await self.store.set_reflect_cursor(None, last_turn.id)
            except Exception:  # pragma: no cover
                pass

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


def _parse_contradictions_json(raw: str) -> list[dict[str, Any]]:
    """Extract the ``contradictions`` list from an LLM JSON response."""
    if not raw:
        return []
    match = _JSON_OBJ_RE.search(raw)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    items = data.get("contradictions") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if isinstance(item, dict)
        and "existing_id" in item
        and "new_index" in item
    ]
