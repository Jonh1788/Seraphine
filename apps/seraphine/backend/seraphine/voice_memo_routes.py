"""031 — Voice memo HTTP routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from seraphine.tools.voice_memo import VoiceMemoService

logger = logging.getLogger("seraphine.voice_memo_routes")

router = APIRouter(prefix="/voice_memos", tags=["voice_memo"])


async def _maybe_journal_from_diary(
    request: Request,
    transcript: str,
    cls: dict[str, Any],
    memo_id: str | None,
) -> None:
    """If classified as diary, also create a journal entry."""
    if cls.get("type") != "diary":
        return
    journal_service = getattr(request.app.state, "journal_service", None)
    if journal_service is None:
        return
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo

        today = datetime.now(ZoneInfo("America/Sao_Paulo")).date().isoformat()

        # Attach today's mood if available
        mood_label: str | None = None
        mood_valence: float | None = None
        mood_service = getattr(request.app.state, "mood_service", None)
        if mood_service is not None:
            try:
                today_mood = await mood_service.get_today()
                current = today_mood.get("current")
                if current:
                    mood_label = current.get("label")
                    mood_valence = current.get("valence")
            except Exception:
                pass

        await journal_service.create_entry(
            date=today,
            type="voice_memo",
            title=cls.get("title", transcript[:60]),
            content=cls.get("detail") or transcript,
            mood_label=mood_label,
            mood_valence=mood_valence,
            source="voice",
            source_id=memo_id,
        )
    except Exception as e:
        logger.warning("journal from voice diary failed: %s", e)


class VoiceMemoIn(BaseModel):
    transcript: str = Field(..., min_length=3, max_length=4000)


@router.post("")
async def create_memo(payload: VoiceMemoIn, request: Request) -> dict[str, Any]:
    """Classify and archive a voice-memo transcript."""
    llm = getattr(request.app.state, "llm", None)
    store = request.app.state.store
    task_service = getattr(request.app.state, "task_service", None)
    note_service = getattr(request.app.state, "note_service", None)
    svc = VoiceMemoService(store, llm, task_service, note_service)

    cls = await svc.classify(payload.transcript)
    if cls is None:
        raise HTTPException(status_code=502, detail="classification failed")
    result = await svc.archive(payload.transcript, cls)
    await _maybe_journal_from_diary(
        request, payload.transcript, cls, result.get("memo_id"),
    )
    return {"memo": result, "classification": cls}


@router.post("/audio")
async def create_memo_from_audio(
    request: Request,
    audio: UploadFile = File(...),
) -> dict[str, Any]:
    """Transcribe an audio blob (WAV or MP3) and archive the memo."""
    stt = getattr(request.app.state, "stt", None)
    if stt is None:
        raise HTTPException(status_code=503, detail="stt not configured")

    raw = await audio.read()
    if not raw or len(raw) < 1024:
        raise HTTPException(status_code=400, detail="audio too short")
    try:
        # STT.transcribe returns text; PCM-bytes expected. For WAV uploads
        # we accept either, most implementations handle both.
        transcript = await stt.transcribe(raw, sample_rate=16000)
    except Exception as e:
        logger.warning("voice memo transcription failed: %s", e)
        raise HTTPException(status_code=502, detail=f"transcription failed: {e}")

    if not transcript or not transcript.strip():
        raise HTTPException(status_code=422, detail="empty transcription")

    llm = getattr(request.app.state, "llm", None)
    store = request.app.state.store
    task_service = getattr(request.app.state, "task_service", None)
    note_service = getattr(request.app.state, "note_service", None)
    svc = VoiceMemoService(store, llm, task_service, note_service)
    cls = await svc.classify(transcript)
    if cls is None:
        raise HTTPException(status_code=502, detail="classification failed")
    memo = await svc.archive(transcript, cls)
    await _maybe_journal_from_diary(
        request, transcript, cls, memo.get("memo_id"),
    )
    return {"transcript": transcript, "memo": memo, "classification": cls}


@router.get("")
async def list_memos(request: Request, limit: int = 50) -> dict[str, Any]:
    store = request.app.state.store
    import asyncio as _aio

    def _work() -> list[dict[str, Any]]:
        with store._connect() as conn:
            rows = conn.execute(
                "SELECT id, transcript, classification, archived_to,"
                " archived_id, created_at, reverted_at FROM voice_memos"
                " ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": r[0], "transcript": r[1],
                "classification": r[2], "archived_to": r[3],
                "archived_id": r[4], "created_at": r[5],
                "reverted_at": r[6],
            }
            for r in rows
        ]

    memos = await _aio.to_thread(_work)
    return {"memos": memos}
