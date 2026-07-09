"""Export sources into the immutable raw/ layer of the wiki."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any

from mod_vision import extract_pdf_text

from seraphine.wiki import files

logger = logging.getLogger("seraphine.wiki.capture")

_MAX_PDF_CHARS = 30_000


def deepsearch_ref(run: dict[str, Any]) -> str | None:
    """Compute the raw/ ref for a deepsearch run WITHOUT writing. None if empty report."""
    report = (run.get("report") or "").strip()
    if not report:
        return None
    created = (run.get("created_at") or "")[:10] or "0000-00-00"
    slug = files.slugify(run.get("query") or run.get("id") or "pesquisa")
    return f"research/{created}-{slug}.md"


def export_deepsearch_run(run: dict[str, Any]) -> str | None:
    """Write a done deepsearch report into raw/research/. Idempotent. Returns the ref."""
    ref = deepsearch_ref(run)
    if ref is None:
        return None
    path = files.wiki_root() / "raw" / ref
    if path.exists():
        return ref
    header = f"# Pesquisa: {run.get('query', '')}\n\n_id: {run.get('id', '')} · {run.get('created_at', '')}_\n\n"
    path.write_text(header + (run.get("report") or "").strip() + "\n", encoding="utf-8")
    return ref


def chat_qa_ref(question: str, answer: str) -> str:
    """Deterministic raw/ ref for a chat Q&A. Same Q&A → same ref (dedup)."""
    h = hashlib.sha256(((question or "") + "\n" + (answer or "")).encode("utf-8")).hexdigest()[:8]
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"chat/{date}-{h}.md"


def export_chat_qa(question: str, answer: str) -> str:
    """Write a chat Q&A into raw/chat/. Idempotent. Returns the ref."""
    ref = chat_qa_ref(question, answer)
    path = files.wiki_root() / "raw" / ref
    if path.exists():
        return ref
    body = (
        "# Q&A do chat\n\n"
        f"**Pergunta:** {(question or '').strip()}\n\n"
        f"**Resposta:**\n\n{(answer or '').strip()}\n"
    )
    path.write_text(body, encoding="utf-8")
    return ref


async def capture_attachment(att_id: str, data: bytes, meta: dict[str, Any]) -> str | None:
    """Persist an attachment's extracted text into raw/attachments/. Idempotent."""
    if not files.is_safe_slug(str(att_id)):
        return None
    ref = f"attachments/{att_id}.md"
    path = files.wiki_root() / "raw" / ref
    if path.exists():
        return ref
    name = meta.get("filename", "")
    kind = meta.get("kind")
    try:
        if kind == "pdf":
            text = (await asyncio.to_thread(extract_pdf_text, data) or "")[:_MAX_PDF_CHARS]
            if not text.strip():
                text = "[PDF sem texto extraível]"
            body = f"# Anexo: {name}\n\n{text}\n"
        else:
            body = f"# Anexo (imagem): {name}\n\n_mime: {meta.get('mime', '')}_\n"
        path.write_text(body, encoding="utf-8")
    except Exception:
        logger.exception("capture_attachment failed for %s", att_id)
        return None
    return ref
