"""Upload + preview endpoints for staged attachments (image/PDF)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from seraphine.attachments import store

router = APIRouter(prefix="/attachments", tags=["attachments"])


@router.post("")
async def upload_attachment(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    mime = file.content_type or ""
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    verr = store.validation_error(mime, len(data))
    if verr is not None:
        raise HTTPException(status_code=verr[0], detail=verr[1])
    return store.save_attachment(data, filename=file.filename or "anexo", mime=mime)


@router.get("/{att_id}")
async def get_attachment(att_id: str) -> Any:
    loaded = store.load_attachment(att_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="not found")
    _data, meta = loaded
    path = store.attachments_dir() / att_id
    return FileResponse(str(path), media_type=meta["mime"], filename=meta["filename"])
