"""Persist user-uploaded images (data URLs from chat attachments) into
the same `~/.seraphine/images/{id}.{ext}` storage that generated images
use, so they're servable via the existing `/images/{id}` route.

Reuses the `generated_images` table — schema already has all the
columns we need. We mark provider="user_upload" and cost_usd=0 so
budget accounting and audit queries can distinguish them.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("seraphine.images.uploads")

# data:image/png;base64,AAAA...
_DATA_URL_RE = re.compile(
    r"^data:(?P<mime>image/[a-z0-9+.\-]+);base64,(?P<b64>.+)$",
    re.IGNORECASE | re.DOTALL,
)

# Conservative size cap for user uploads — Anthropic accepts up to 5 MB
# per image, but base64-encoded payloads above this cause big WS frames
# and slow conversation history.
_MAX_DECODED_BYTES = 8 * 1024 * 1024  # 8 MB raw


def _ext_for(mime: str) -> str:
    mime = mime.lower()
    if mime in ("image/jpeg", "image/jpg"):
        return "jpg"
    if mime == "image/png":
        return "png"
    if mime == "image/webp":
        return "webp"
    if mime == "image/gif":
        return "gif"
    # Fallback — strip "image/"
    return mime.split("/", 1)[1].split("+", 1)[0] or "bin"


async def save_user_upload(
    store: Any,
    settings: Any,
    data_url: str,
    *,
    note: str = "user-uploaded reference",
) -> dict[str, Any] | None:
    """Decode `data_url`, write to disk, register a row in
    `generated_images` so the existing /images/{id} route can serve it.
    Returns {id, public_url, local_path} or None if input wasn't a
    valid image data URL.
    """
    if not isinstance(data_url, str):
        return None
    m = _DATA_URL_RE.match(data_url.strip())
    if not m:
        return None
    mime = m.group("mime").lower()
    b64 = m.group("b64")
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception as e:
        logger.warning("user upload: invalid base64 (%s)", e)
        return None
    if not raw:
        return None
    if len(raw) > _MAX_DECODED_BYTES:
        logger.warning(
            "user upload rejected: %d bytes exceeds %d cap",
            len(raw), _MAX_DECODED_BYTES,
        )
        return None

    img_id = str(uuid.uuid4())
    storage_dir = Path(os.path.expanduser(
        getattr(settings, "image_storage_dir", "~/.seraphine/images"),
    ))
    storage_dir.mkdir(parents=True, exist_ok=True)
    ext = _ext_for(mime)
    local_path = storage_dir / f"{img_id}.{ext}"

    def _write_and_register() -> None:
        local_path.write_bytes(raw)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO generated_images"
                " (id, prompt, model, provider, url, local_path, cost_usd, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    img_id,
                    note,
                    "(none)",
                    "user_upload",
                    None,
                    str(local_path),
                    0.0,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    await asyncio.to_thread(_write_and_register)

    public_url = f"https://sera.jonhdev.io/images/{img_id}"
    return {
        "id": img_id,
        "public_url": public_url,
        "local_path": str(local_path),
        "mime": mime,
        "size_bytes": len(raw),
    }
