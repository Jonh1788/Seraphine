"""REST API for conversation history persistence.

Provides endpoints for fetching turns of a conversation and listing
recent conversations with a preview of the first message.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("/recent")
async def recent_conversations(
    request: Request,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Return the most recent conversations with first-message preview."""
    store = request.app.state.store
    return await store.get_recent_conversations(limit=limit)


@router.get("/{conversation_id}/turns")
async def get_conversation_turns(
    request: Request,
    conversation_id: str,
) -> list[dict[str, Any]]:
    """Return all turns for a given conversation, ordered by created_at ASC."""
    store = request.app.state.store
    turns = await store.get_turns(conversation_id)
    if not turns:
        # Could be empty conversation or non-existent — return empty list
        # (the frontend handles empty gracefully)
        return []
    return [t.model_dump() for t in turns]
