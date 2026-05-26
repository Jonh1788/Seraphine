"""REST API for the memory panel (Fase 6).

Exposes CRUD over facts stored in SQLite. Episodes (ChromaDB) are
read-only for now — they're surfaced via the recall endpoint.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from seraphine.memory.profile import UserProfile

logger = logging.getLogger("seraphine.memory.routes")

router = APIRouter(prefix="/memory", tags=["memory"])

# ---------------------------------------------------------------------------
# 086 — ephemeral action state (module-level dict, no DB table needed)
# ---------------------------------------------------------------------------

ActionName = Literal[
    "rebuild_embeddings", "purge_orphans", "force_reflection", "compact"
]

_ACTION_NAMES: list[ActionName] = [
    "rebuild_embeddings", "purge_orphans", "force_reflection", "compact",
]


class _ActionState:
    __slots__ = ("state", "last_run", "last_error", "progress")

    def __init__(self) -> None:
        self.state: Literal["idle", "running"] = "idle"
        self.last_run: str | None = None
        self.last_error: str | None = None
        self.progress: dict[str, int] | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "state": self.state,
            "last_run": self.last_run,
            "last_error": self.last_error,
        }
        if self.progress is not None:
            d["progress"] = self.progress
        return d


_action_states: dict[ActionName, _ActionState] = {
    name: _ActionState() for name in _ACTION_NAMES
}


class FactCreate(BaseModel):
    text: str = Field(..., min_length=1)
    source: str = "explicit"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class FactUpdate(BaseModel):
    text: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class RecallQuery(BaseModel):
    query: str = Field(..., min_length=1)
    k: int = Field(default=5, ge=1, le=50)
    decay_days: float = Field(default=30.0, ge=0.0)
    conversation_id: str | None = None
    role: str | None = None
    since: str | None = None
    until: str | None = None


@router.get("/facts")
async def list_facts(
    request: Request,
    limit: int = 50,
    include_superseded: bool = False,
) -> list[dict[str, Any]]:
    store = request.app.state.store
    facts = await store.list_facts(limit=limit, include_superseded=include_superseded)
    return [f.model_dump() for f in facts]


@router.get("/facts/{fact_id}")
async def get_fact(request: Request, fact_id: str) -> dict[str, Any]:
    store = request.app.state.store
    fact = await store.get_fact(fact_id)
    if fact is None:
        raise HTTPException(status_code=404, detail="Fact not found")
    return fact.model_dump()


@router.post("/facts", status_code=201)
async def create_fact(request: Request, body: FactCreate) -> dict[str, Any]:
    memory = request.app.state.memory
    fact = await memory.learn_fact(
        body.text, source=body.source, confidence=body.confidence
    )
    return fact.model_dump()


@router.patch("/facts/{fact_id}")
async def update_fact(
    request: Request, fact_id: str, body: FactUpdate
) -> dict[str, Any]:
    store = request.app.state.store
    if body.text is None and body.confidence is None:
        raise HTTPException(status_code=400, detail="Nothing to update")
    fact = await store.update_fact(fact_id, text=body.text, confidence=body.confidence)
    if fact is None:
        raise HTTPException(status_code=404, detail="Fact not found")
    return fact.model_dump()


@router.delete("/facts/{fact_id}", status_code=204)
async def delete_fact(request: Request, fact_id: str) -> None:
    store = request.app.state.store
    deleted = await store.delete_fact(fact_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Fact not found")


class ImportPayload(BaseModel):
    version: int = 1
    exported_at: str = ""
    facts: list[dict[str, Any]] = []
    narratives: list[dict[str, Any]] = []
    people: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    open_loops: list[dict[str, Any]] = []
    episode_windows: list[dict[str, Any]] = []


@router.get("/export")
async def export_memory(request: Request) -> dict[str, Any]:
    """Export full memory backup: facts, narratives, people, decisions,
    open_loops, and episode_windows."""
    store = request.app.state.store
    facts = await store.list_facts(limit=10_000, include_superseded=False)
    narratives = await store.list_narratives(limit=10_000)
    people = await store.list_people(limit=10_000)
    decisions = await store.list_all_decisions(limit=10_000)
    loops = await store.list_open_loops(only_open=False, limit=10_000)
    windows = await store.list_windows(limit=10_000)
    return {
        "version": 2,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "facts": [f.model_dump() for f in facts],
        "narratives": narratives,
        "people": people,
        "decisions": decisions,
        "open_loops": loops,
        "episode_windows": windows,
    }


@router.post("/import")
async def import_memory(request: Request, body: ImportPayload) -> dict[str, Any]:
    """Import memory from a previously exported JSON payload, skipping duplicates."""
    store = request.app.state.store
    imported: dict[str, int] = {}
    skipped: dict[str, int] = {}

    # --- facts (dedup by text) ---
    existing_facts = await store.list_facts(limit=10_000, include_superseded=False)
    existing_texts: set[str] = {f.text for f in existing_facts}
    imp, skip = 0, 0
    for item in body.facts:
        text = item.get("text", "").strip()
        if not text or text in existing_texts:
            skip += 1
            continue
        source = item.get("source", "explicit")
        confidence = item.get("confidence", 1.0)
        await store.add_fact(text, source=source, confidence=confidence)
        existing_texts.add(text)
        imp += 1
    imported["facts"] = imp
    skipped["facts"] = skip

    # --- narratives ---
    imp, skip = 0, 0
    for item in body.narratives:
        ok = await store.insert_narrative_raw(
            id=item["id"],
            conversation_id=item.get("conversation_id", ""),
            text=item.get("text", ""),
            turn_count=item.get("turn_count", 0),
            started_at=item.get("started_at", ""),
            ended_at=item.get("ended_at", ""),
            created_at=item.get("created_at", ""),
        )
        if ok:
            imp += 1
        else:
            skip += 1
    imported["narratives"] = imp
    skipped["narratives"] = skip

    # --- people ---
    imp, skip = 0, 0
    for item in body.people:
        tags = item.get("tags")
        if isinstance(tags, list):
            tags = json.dumps(tags, ensure_ascii=False)
        ok = await store.insert_person_raw(
            id=item["id"],
            name=item.get("name", ""),
            relation=item.get("relation"),
            first_seen_at=item.get("first_seen_at", ""),
            last_mentioned_at=item.get("last_mentioned_at", ""),
            mention_count=item.get("mention_count", 1),
            tags=tags,
        )
        if ok:
            imp += 1
        else:
            skip += 1
    imported["people"] = imp
    skipped["people"] = skip

    # --- decisions ---
    imp, skip = 0, 0
    for item in body.decisions:
        ok = await store.insert_decision_raw(
            id=item["id"],
            subject=item.get("subject", ""),
            choice=item.get("choice", ""),
            alternatives=item.get("alternatives"),
            created_at=item.get("created_at", ""),
            followed_up_at=item.get("followed_up_at"),
            outcome=item.get("outcome"),
        )
        if ok:
            imp += 1
        else:
            skip += 1
    imported["decisions"] = imp
    skipped["decisions"] = skip

    # --- open_loops ---
    imp, skip = 0, 0
    for item in body.open_loops:
        ok = await store.insert_open_loop_raw(
            id=item["id"],
            text=item.get("text", ""),
            owner=item.get("owner", "user"),
            created_at=item.get("created_at", ""),
            resolved_at=item.get("resolved_at"),
            resolution=item.get("resolution"),
            injection_count=item.get("injection_count", 0),
        )
        if ok:
            imp += 1
        else:
            skip += 1
    imported["open_loops"] = imp
    skipped["open_loops"] = skip

    # --- episode_windows ---
    imp, skip = 0, 0
    for item in body.episode_windows:
        ok = await store.insert_window_raw(
            id=item["id"],
            conversation_id=item.get("conversation_id", ""),
            first_turn_id=item.get("first_turn_id", ""),
            last_turn_id=item.get("last_turn_id", ""),
            turn_count=item.get("turn_count", 0),
            text=item.get("text", ""),
            started_at=item.get("started_at", ""),
            ended_at=item.get("ended_at", ""),
            created_at=item.get("created_at", ""),
        )
        if ok:
            imp += 1
        else:
            skip += 1
    imported["episode_windows"] = imp
    skipped["episode_windows"] = skip

    return {"imported": imported, "skipped": skipped}


@router.post("/decay")
async def decay_facts(request: Request) -> dict[str, int]:
    """Run the decay sweep: self-supersede facts whose adjusted confidence
    dropped below 0.3 due to age without revalidation."""
    memory = request.app.state.memory
    n = await memory.decay_facts()
    return {"superseded": n}


class PrunePayload(BaseModel):
    days: int = Field(default=90, ge=1)


@router.post("/prune")
async def prune_events(request: Request, body: PrunePayload) -> dict[str, int]:
    """Delete events older than ``days`` from the event timeline."""
    store = request.app.state.store
    deleted = await store.prune_events_older_than(body.days)
    return {"deleted": deleted}


@router.post("/recall")
async def recall(request: Request, body: RecallQuery) -> list[dict[str, Any]]:
    memory = request.app.state.memory
    memories = await memory.recall(
        body.query,
        k=body.k,
        decay_days=body.decay_days,
        conversation_id=body.conversation_id,
        role=body.role,
        since=body.since,
        until=body.until,
    )
    return [m.model_dump() for m in memories]


@router.get("/health")
async def memory_health(request: Request) -> dict[str, Any]:
    """Return end-to-end semantic-memory health.

    Signals that catch the kind of silent-degradation bug where the
    backend stayed ``healthy`` while every embed call failed:
      - ``ollama`` — reachable + model loaded + latency
      - ``chroma`` — reachable + episode count
      - ``facts`` — active/superseded/total counts
      - ``last_reflect_at`` — timestamp of the last successful reflect
      - ``warnings_24h`` — count of embed/recall failures in the last day
      - ``orphan_count`` — ChromaDB embeddings with no matching fact in SQLite
      - ``low_confidence_count`` — active facts with confidence < 0.3
      - ``stale_count`` — active facts not accessed in 90+ days
    """
    store = request.app.state.store
    memory = request.app.state.memory
    embeddings = request.app.state.embeddings

    # Ollama probe — duck-typed so FakeEmbeddings works in tests.
    if hasattr(embeddings, "health"):
        ollama = await embeddings.health()
    else:
        ollama = {"reachable": None, "model_loaded": None, "latency_ms": None}

    # Chroma: count() is the native API; collection may be None if start failed.
    collection = getattr(memory, "_collection", None)
    chroma: dict[str, Any] = {"reachable": False, "count": None}
    if collection is not None:
        try:
            chroma = {"reachable": True, "count": int(collection.count())}
        except Exception as e:
            chroma = {"reachable": False, "count": None, "error": str(e)[:200]}

    facts = await store.count_facts()

    last_reflect = await store.get_latest_event(
        source="memory", event_type="reflect_success",
    )
    last_reflect_at = last_reflect["created_at"] if last_reflect else None
    last_reflect_inserted = (
        last_reflect.get("metadata", {}).get("inserted") if last_reflect else None
    )

    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    warnings_24h = await store.count_events_since(
        source="memory", event_type="warning", since=since,
    )

    # --- 086: expanded diagnostics ---
    orphan_count = await _count_orphans(memory, store)
    low_confidence_count = await _count_low_confidence(store)
    stale_count = await _count_stale(store)

    overall_ok = bool(ollama.get("reachable")) and chroma.get("reachable") is True
    return {
        "ok": overall_ok,
        "ollama": ollama,
        "chroma": chroma,
        "facts": facts,
        "last_reflect_at": last_reflect_at,
        "last_reflect_inserted": last_reflect_inserted,
        "warnings_24h": warnings_24h,
        "orphan_count": orphan_count,
        "low_confidence_count": low_confidence_count,
        "stale_count": stale_count,
    }


# ---------------------------------------------------------------------------
# 086 — helper queries for expanded health
# ---------------------------------------------------------------------------

async def _count_orphans(memory: Any, store: Any) -> int:
    """Count ChromaDB IDs that have no corresponding active fact in SQLite."""
    collection = getattr(memory, "_collection", None)
    if collection is None:
        return 0
    try:
        chroma_result = await asyncio.to_thread(
            lambda: collection.get(include=[])
        )
        chroma_ids = set(chroma_result.get("ids", []))
    except Exception:
        return 0
    if not chroma_ids:
        return 0
    # Get all fact IDs from SQLite (active + superseded — any fact row).
    def _fact_ids() -> set[str]:
        with store._connect() as conn:
            rows = conn.execute("SELECT id FROM facts").fetchall()
        return {r[0] for r in rows}
    fact_ids = await asyncio.to_thread(_fact_ids)
    # Also count turn IDs and window IDs as valid (they live in chroma too).
    def _turn_ids() -> set[str]:
        with store._connect() as conn:
            rows = conn.execute("SELECT id FROM turns").fetchall()
        return {r[0] for r in rows}
    def _window_ids() -> set[str]:
        with store._connect() as conn:
            try:
                rows = conn.execute("SELECT id FROM episode_windows").fetchall()
            except Exception:
                return set()
        return {r[0] for r in rows}
    turn_ids, window_ids = await asyncio.gather(
        asyncio.to_thread(_turn_ids),
        asyncio.to_thread(_window_ids),
    )
    known_ids = fact_ids | turn_ids | window_ids
    return len(chroma_ids - known_ids)


async def _count_low_confidence(store: Any) -> int:
    """Count active facts with confidence < 0.3."""
    def _work() -> int:
        with store._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM facts"
                " WHERE superseded_by IS NULL AND confidence < 0.3",
            ).fetchone()
        return int(row[0]) if row else 0
    return await asyncio.to_thread(_work)


async def _count_stale(store: Any) -> int:
    """Count active facts not accessed (last_used_at or created_at) in 90+ days."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    def _work() -> int:
        with store._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM facts"
                " WHERE superseded_by IS NULL"
                "   AND COALESCE(last_used_at, created_at) < ?",
                (cutoff,),
            ).fetchone()
        return int(row[0]) if row else 0
    return await asyncio.to_thread(_work)


# ---------------------------------------------------------------------------
# 086 — WS broadcast helper
# ---------------------------------------------------------------------------

async def _broadcast_ws(request: Request, payload: dict[str, Any]) -> None:
    """Send a JSON payload to all connected WebSocket clients."""
    ws_clients: set = getattr(request.app.state, "ws_clients", set())
    for ws in list(ws_clients):
        try:
            await ws.send_json(payload)
        except Exception:
            ws_clients.discard(ws)


# ---------------------------------------------------------------------------
# 086 — corrective action endpoints
# ---------------------------------------------------------------------------

@router.post("/actions/rebuild-embeddings")
async def action_rebuild_embeddings(request: Request) -> dict[str, Any]:
    """Re-embed all active facts in ChromaDB. Long-running — returns
    immediately and emits ``memory_rebuild_progress`` WS events."""
    state = _action_states["rebuild_embeddings"]
    if state.state == "running":
        return {"status": "already_running"}
    state.state = "running"
    state.last_error = None
    state.progress = {"done": 0, "total": 0}

    async def _worker() -> None:
        store = request.app.state.store
        memory = request.app.state.memory
        embeddings = request.app.state.embeddings
        try:
            all_facts = await store.list_facts(
                limit=10_000, include_superseded=False,
            )
            total = len(all_facts)
            state.progress = {"done": 0, "total": total}
            await _broadcast_ws(request, {
                "type": "memory_rebuild_progress",
                "payload": {"done": 0, "total": total},
            })
            for i, fact in enumerate(all_facts):
                try:
                    vecs = await embeddings.embed([fact.text])
                    vec = vecs[0]
                    memory._fact_embedding_cache[fact.id] = vec
                    await store.save_fact_embedding(
                        fact.id, vec, model=memory.embedding_model,
                    )
                except Exception as e:
                    logger.warning(
                        "rebuild-embeddings: embed failed for %s: %s",
                        fact.id[:8], e,
                    )
                done = i + 1
                state.progress = {"done": done, "total": total}
                # Emit WS progress every 5 facts or on the last one.
                if done % 5 == 0 or done == total:
                    await _broadcast_ws(request, {
                        "type": "memory_rebuild_progress",
                        "payload": {"done": done, "total": total},
                    })
            state.last_run = datetime.now(timezone.utc).isoformat()
            state.last_error = None
            await store.add_event(
                event_type="action_rebuild_embeddings",
                summary=f"rebuild-embeddings: {total} facts re-embedded",
                source="memory",
                metadata={"total": total},
            )
        except Exception as e:
            state.last_error = str(e)[:200]
            logger.exception("rebuild-embeddings worker failed")
        finally:
            state.state = "idle"
            state.progress = None

    asyncio.create_task(_worker())
    return {"status": "started"}


@router.post("/actions/purge-orphans")
async def action_purge_orphans(request: Request) -> dict[str, Any]:
    """Delete ChromaDB embeddings that have no matching row in SQLite."""
    state = _action_states["purge_orphans"]
    if state.state == "running":
        return {"status": "already_running"}
    state.state = "running"
    state.last_error = None
    try:
        store = request.app.state.store
        memory = request.app.state.memory
        collection = getattr(memory, "_collection", None)
        if collection is None:
            state.state = "idle"
            return {"status": "started", "purged": 0, "detail": "no collection"}

        chroma_result = await asyncio.to_thread(
            lambda: collection.get(include=[])
        )
        chroma_ids = set(chroma_result.get("ids", []))
        if not chroma_ids:
            state.last_run = datetime.now(timezone.utc).isoformat()
            state.state = "idle"
            return {"status": "started", "purged": 0}

        # Gather all known IDs from SQLite.
        def _all_known_ids() -> set[str]:
            with store._connect() as conn:
                fact_rows = conn.execute("SELECT id FROM facts").fetchall()
                turn_rows = conn.execute("SELECT id FROM turns").fetchall()
                try:
                    win_rows = conn.execute(
                        "SELECT id FROM episode_windows"
                    ).fetchall()
                except Exception:
                    win_rows = []
            ids: set[str] = set()
            for r in fact_rows:
                ids.add(r[0])
            for r in turn_rows:
                ids.add(r[0])
            for r in win_rows:
                ids.add(r[0])
            return ids

        known_ids = await asyncio.to_thread(_all_known_ids)
        orphan_ids = list(chroma_ids - known_ids)
        if orphan_ids:
            # ChromaDB delete() accepts a list of IDs.
            await asyncio.to_thread(
                lambda: collection.delete(ids=orphan_ids)
            )
        state.last_run = datetime.now(timezone.utc).isoformat()
        state.last_error = None
        await store.add_event(
            event_type="action_purge_orphans",
            summary=f"purge-orphans: {len(orphan_ids)} removed",
            source="memory",
            metadata={"purged": len(orphan_ids)},
        )
        return {"status": "started", "purged": len(orphan_ids)}
    except Exception as e:
        state.last_error = str(e)[:200]
        logger.exception("purge-orphans failed")
        raise HTTPException(status_code=500, detail=str(e)[:200])
    finally:
        state.state = "idle"


@router.post("/actions/force-reflection")
async def action_force_reflection(request: Request) -> dict[str, Any]:
    """Trigger an immediate reflect() cycle."""
    state = _action_states["force_reflection"]
    if state.state == "running":
        return {"status": "already_running"}
    state.state = "running"
    state.last_error = None
    try:
        memory = request.app.state.memory
        inserted = await memory.reflect()
        state.last_run = datetime.now(timezone.utc).isoformat()
        state.last_error = None
        return {"status": "started", "inserted": inserted}
    except Exception as e:
        state.last_error = str(e)[:200]
        logger.exception("force-reflection failed")
        raise HTTPException(status_code=500, detail=str(e)[:200])
    finally:
        state.state = "idle"


@router.post("/actions/compact")
async def action_compact(request: Request) -> dict[str, Any]:
    """Delete facts with confidence < 0.3 and archive facts untouched
    for 90+ days. Long-running — returns immediately."""
    state = _action_states["compact"]
    if state.state == "running":
        return {"status": "already_running"}
    state.state = "running"
    state.last_error = None

    async def _worker() -> None:
        store = request.app.state.store
        memory = request.app.state.memory
        try:
            cutoff_90d = (
                datetime.now(timezone.utc) - timedelta(days=90)
            ).isoformat()
            all_facts = await store.list_facts(
                limit=10_000, include_superseded=False,
            )
            deleted_low = 0
            archived_stale = 0
            for fact in all_facts:
                if fact.confidence < 0.3:
                    await store.supersede_fact(fact.id, fact.id)
                    memory._fact_embedding_cache.pop(fact.id, None)
                    try:
                        await store.delete_fact_embedding(fact.id)
                    except Exception:
                        pass
                    deleted_low += 1
                    continue
                ref = fact.last_used_at or fact.created_at
                if ref < cutoff_90d:
                    await store.supersede_fact(fact.id, fact.id)
                    memory._fact_embedding_cache.pop(fact.id, None)
                    try:
                        await store.delete_fact_embedding(fact.id)
                    except Exception:
                        pass
                    archived_stale += 1
            state.last_run = datetime.now(timezone.utc).isoformat()
            state.last_error = None
            await store.add_event(
                event_type="action_compact",
                summary=(
                    f"compact: {deleted_low} low-confidence deleted, "
                    f"{archived_stale} stale archived"
                ),
                source="memory",
                metadata={
                    "deleted_low": deleted_low,
                    "archived_stale": archived_stale,
                },
            )
            await _broadcast_ws(request, {
                "type": "memory_compact_done",
                "payload": {
                    "deleted_low": deleted_low,
                    "archived_stale": archived_stale,
                },
            })
        except Exception as e:
            state.last_error = str(e)[:200]
            logger.exception("compact worker failed")
        finally:
            state.state = "idle"

    asyncio.create_task(_worker())
    return {"status": "started"}


@router.get("/actions/status")
async def action_status() -> dict[str, Any]:
    """Return the current state of every corrective action."""
    return {
        "actions": {name: st.to_dict() for name, st in _action_states.items()}
    }


@router.get("/timeline")
async def get_timeline(
    request: Request,
    limit: int = Query(default=20, ge=1, le=500),
    source: str | None = Query(default=None),
) -> dict[str, Any]:
    """Return recent events from the timeline, optionally filtered by source."""
    store = request.app.state.store
    events = await store.get_recent_events(limit=limit, source=source or None)
    return {"events": events}


@router.get("/profile")
async def get_profile(request: Request) -> dict[str, Any]:
    """Return the cached semantic profile. The rebuild runs in background
    (see ConversationEngine._auto_rebuild_profile)."""
    store = request.app.state.store
    profile = await UserProfile(store).get_cached()
    return {"profile": profile}


# Whitelist of memory tables exposed via the browser UI. Any SQL that
# interpolates a table name (no SQLite parameter binding for identifiers)
# MUST validate against this set to prevent SQL injection if the source
# of `table` ever becomes user-controlled.
_BROWSER_TABLES: frozenset[str] = frozenset({
    "facts", "conversation_narratives", "decisions", "people",
    "person_mentions", "open_loops", "discoveries",
    "finance_nudges", "anticipation_rules", "voice_memos",
})


@router.get("/browser")
async def memory_browser_overview(request: Request) -> dict[str, Any]:
    """038 — Summary of every memory table for the browser UI."""
    store = request.app.state.store
    import asyncio as _aio

    def _counts() -> dict[str, int]:
        with store._connect() as conn:
            counts: dict[str, int] = {}
            for t in _BROWSER_TABLES:
                # Defensive: only ever interpolate identifiers from the
                # allowlist, never raw input.
                if t not in _BROWSER_TABLES:
                    continue
                try:
                    row = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()
                    counts[t] = int(row[0]) if row else 0
                except Exception:
                    counts[t] = 0
            return counts

    return {"counts": await _aio.to_thread(_counts)}


@router.get("/browser/{table}")
async def memory_browser_table(
    table: str, request: Request, limit: int = 50, offset: int = 0,
) -> dict[str, Any]:
    store = request.app.state.store
    if table not in _BROWSER_TABLES:
        raise HTTPException(status_code=404, detail="unknown table")

    import asyncio as _aio

    def _rows() -> list[dict[str, Any]]:
        with store._connect() as conn:
            cols = [c[1] for c in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            rows = conn.execute(
                f"SELECT * FROM {table} ORDER BY created_at DESC NULLS LAST "
                f"LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    try:
        data = await _aio.to_thread(_rows)
    except Exception as e:
        # Some tables may not have `created_at` column — fallback.
        def _simple() -> list[dict[str, Any]]:
            with store._connect() as conn:
                cols = [c[1] for c in conn.execute(f"PRAGMA table_info({table})").fetchall()]
                rows = conn.execute(
                    f"SELECT * FROM {table} LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
            return [dict(zip(cols, r)) for r in rows]
        data = await _aio.to_thread(_simple)

    return {"table": table, "rows": data, "limit": limit, "offset": offset}


@router.delete("/browser/{table}/{row_id}")
async def memory_browser_delete(
    table: str, row_id: str, request: Request,
) -> dict[str, Any]:
    store = request.app.state.store
    allowed = {
        "facts", "conversation_narratives", "decisions", "people",
        "person_mentions", "open_loops", "discoveries",
        "finance_nudges", "anticipation_rules", "voice_memos",
    }
    if table not in allowed:
        raise HTTPException(status_code=404, detail="unknown table")

    import asyncio as _aio

    def _delete() -> int:
        with store._connect() as conn:
            cur = conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
            return cur.rowcount or 0

    deleted = await _aio.to_thread(_delete)
    if deleted == 0:
        raise HTTPException(status_code=404, detail="row not found")
    await store.add_event(
        event_type="memory_forget",
        summary=f"Forgot {table}/{row_id}",
        source="user",
        metadata={"table": table, "id": row_id},
    )
    return {"deleted": deleted}


@router.post("/profile/rebuild")
async def rebuild_profile(request: Request) -> dict[str, Any]:
    """Force an LLM-powered rebuild of the profile. Synchronous —
    the frontend can poll /profile after this returns."""
    store = request.app.state.store
    llm = getattr(request.app.state, "llm", None)
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not configured")
    result = await UserProfile(store, llm).rebuild()
    if result is None:
        raise HTTPException(status_code=502, detail="rebuild failed")
    return {"profile": result}


@router.get("/notifications")
async def get_notifications(request: Request, limit: int = 50) -> list[dict[str, Any]]:
    store = request.app.state.store
    return await store.get_unread_notifications(limit=limit)


class MarkReadPayload(BaseModel):
    ids: list[str]


@router.post("/notifications/read")
async def mark_read(request: Request, body: MarkReadPayload) -> dict[str, str]:
    store = request.app.state.store
    await store.mark_notifications_read(body.ids)
    return {"status": "ok"}
