"""HTTP surface for speech-to-text.

Mounted under ``/chat`` so the frontend's existing chat API helpers
share the same prefix — no new CORS / proxy rules needed.

Multipart parsing reuses the in-tree helpers from ``aura.chat.routes``
so we don't pull ``python-multipart`` as a dep just for one endpoint.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from mod_tasks.routes import get_current_user_id

from aura.chat.routes import _extract_boundary, _parse_multipart
from aura.stt.service import STTService

router = APIRouter(prefix="/chat", tags=["chat"])
logger = logging.getLogger(__name__)

# 25 MB — well above ~2 MB typical for a 120s opus blob, leaves room
# for fallback codecs that aren't as compact.
_MAX_AUDIO_BYTES = 25 * 1024 * 1024


def _service_or_503(request: Request) -> STTService:
    svc: Optional[STTService] = getattr(request.app.state, "stt_service", None)
    if svc is None:
        raise HTTPException(
            status_code=503, detail="stt service não configurado",
        )
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


@router.post("/transcribe")
async def transcribe(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    _require_user(user_id)
    svc = _service_or_503(request)

    ctype = request.headers.get("content-type", "")
    if "multipart/form-data" not in ctype.lower():
        raise HTTPException(
            status_code=415, detail="esperado multipart/form-data",
        )
    boundary = _extract_boundary(ctype)
    if not boundary:
        raise HTTPException(
            status_code=400, detail="boundary multipart ausente",
        )

    # Fast-path rejection via Content-Length; allow ~1MB slack for
    # multipart framing overhead.
    limit = _MAX_AUDIO_BYTES + 1024 * 1024
    cl_hdr = request.headers.get("content-length")
    if cl_hdr is not None:
        try:
            if int(cl_hdr) > limit:
                raise HTTPException(
                    status_code=413, detail="áudio muito grande",
                )
        except ValueError:
            pass

    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(status_code=413, detail="áudio muito grande")

    parts = _parse_multipart(raw, boundary)
    audio_part = parts.get("audio")
    if audio_part is None:
        raise HTTPException(status_code=422, detail="campo 'audio' ausente")

    data: bytes = audio_part["data"]
    if not data:
        raise HTTPException(status_code=400, detail="áudio vazio")
    if len(data) > _MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="áudio muito grande")

    try:
        text = await svc.transcribe(data, language="pt")
    except Exception:
        logger.exception("transcription failed")
        raise HTTPException(
            status_code=500, detail="falha ao transcrever áudio",
        )

    return {"text": text}
