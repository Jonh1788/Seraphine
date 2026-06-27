"""Ephemeral staging store for user-uploaded attachments (image/PDF).

Bytes are written under <data_dir>/attachments/<id> with a sibling
<id>.meta.json. A daily housekeeping job (see main.py) reclaims files
past their TTL. Mirrors the cv_triage staging convention.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from seraphine.config import settings

ACCEPTED_MIMES: set[str] = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def kind_for_mime(mime: str) -> str:
    return "pdf" if mime == "application/pdf" else "image"


def validation_error(mime: str, size: int) -> tuple[int, str] | None:
    """Return ``(status, detail)`` if invalid, else ``None``."""
    if mime not in ACCEPTED_MIMES:
        return (415, "unsupported media type")
    cap = MAX_PDF_BYTES if mime == "application/pdf" else MAX_IMAGE_BYTES
    if size > cap:
        return (413, "file too large")
    return None


def attachments_dir() -> Path:
    base = os.environ.get("SERAPHINE_DATA_DIR")
    root = Path(base) if base else Path(settings.sqlite_path).parent
    d = root / "attachments"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_attachment(data: bytes, *, filename: str, mime: str) -> dict[str, Any]:
    att_id = uuid.uuid4().hex
    d = attachments_dir()
    (d / att_id).write_bytes(data)
    meta = {
        "id": att_id,
        "kind": kind_for_mime(mime),
        "mime": mime,
        "filename": filename,
        "size": len(data),
    }
    (d / f"{att_id}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


def _safe_id(att_id: str) -> bool:
    # uuid4().hex is 32 lowercase hex chars; keep this strict to block traversal.
    return bool(att_id) and att_id.isalnum() and len(att_id) <= 64


def load_attachment(att_id: str) -> tuple[bytes, dict[str, Any]] | None:
    if not _safe_id(att_id):
        return None
    d = attachments_dir()
    f = d / att_id
    m = d / f"{att_id}.meta.json"
    if not f.is_file() or not m.is_file():
        return None
    try:
        data = f.read_bytes()
        meta = json.loads(m.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data, meta


def cleanup(*, ttl_hours: int = 24) -> int:
    """Delete staged files older than the TTL (by mtime). Returns count removed."""
    d = attachments_dir()
    cutoff = time.time() - ttl_hours * 3600
    removed = 0
    for p in d.glob("*"):
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except Exception:
            pass
    return removed
