"""REST API for the memory panel (Fase 6).

Exposes CRUD over facts stored in SQLite. Episodes (ChromaDB) are
read-only for now — they're surfaced via the recall endpoint.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from seraphine.memory.profile import UserProfile

router = APIRouter(prefix="/memory", tags=["memory"])


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

    overall_ok = bool(ollama.get("reachable")) and chroma.get("reachable") is True
    return {
        "ok": overall_ok,
        "ollama": ollama,
        "chroma": chroma,
        "facts": facts,
        "last_reflect_at": last_reflect_at,
        "last_reflect_inserted": last_reflect_inserted,
        "warnings_24h": warnings_24h,
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
