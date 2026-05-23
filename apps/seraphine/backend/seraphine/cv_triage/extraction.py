"""Extraction cascade: pdfplumber → Tesseract (PT-BR) → Claude Vision.

Each PDF goes through up to three extractors. The first that produces text
deemed usable (see :func:`is_usable` in :mod:`.quality`) wins; otherwise we
fall through. If all three fail (or vision is unavailable), returns
``ExtractionResult(text="", source=TextSource.NONE)`` — the caller decides
what to do (typically mark the result as ``FAILED`` and skip ranking).

Sync vs async: this module is intentionally synchronous. The Anthropic
adapter is async (``httpx.AsyncClient``), but the only async call lives
inside ``_vision_extract`` and is bridged with ``asyncio.run`` so the
cascade composes cleanly with the worker (Task 11), which is expected to
drive PDFs through a thread pool. Callers that already sit inside an
event loop should invoke this via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .models import TextSource
from .quality import is_usable

logger = logging.getLogger(__name__)


@dataclass
class ExtractionResult:
    text: str
    source: TextSource


_OCR_TIMEOUT_SEC = 30
_OCR_DPI = 250
_VISION_MAX_PAGES = 2
_VISION_DPI = 200


def extract_with_fallback(
    pdf_path: Path, *, vision_client: Optional[Any]
) -> ExtractionResult:
    """Run the three-stage cascade and return the first usable result.

    ``vision_client`` is expected to expose ``async transcribe_image_pages``
    (see :class:`llm_adapters.anthropic.AnthropicClient`). Pass ``None`` to
    disable the vision stage entirely — useful when no API key is configured.
    """
    # 1) pdfplumber — fast path for text-based PDFs.
    try:
        text = _pdfplumber_extract(pdf_path)
    except Exception as e:  # noqa: BLE001 — any extractor crash falls through
        logger.warning("pdfplumber failed for %s: %s", pdf_path.name, e)
        text = ""
    if is_usable(text):
        return ExtractionResult(text, TextSource.PDFPLUMBER)

    # 2) Tesseract — scanned PDFs in PT-BR.
    try:
        text = _tesseract_extract(pdf_path)
    except Exception as e:  # noqa: BLE001
        logger.warning("tesseract failed for %s: %s", pdf_path.name, e)
        text = ""
    if is_usable(text):
        return ExtractionResult(text, TextSource.TESSERACT)

    # 3) Claude Vision — last resort, only if a client was provided.
    if vision_client is not None:
        try:
            text = _vision_extract(pdf_path, vision_client)
        except Exception as e:  # noqa: BLE001
            logger.warning("vision failed for %s: %s", pdf_path.name, e)
            text = ""
        if is_usable(text):
            return ExtractionResult(text, TextSource.VISION)

    return ExtractionResult("", TextSource.NONE)


def _pdfplumber_extract(pdf_path: Path) -> str:
    """Extract text from a (presumably text-based) PDF using pdfplumber."""
    import pdfplumber

    chunks: list[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ""
            if t:
                chunks.append(t)
    return "\n".join(chunks)


def _tesseract_extract(pdf_path: Path) -> str:
    """Rasterise pages with poppler/pdf2image and OCR them via Tesseract (PT-BR).

    ``pytesseract.image_to_string(..., timeout=...)`` raises ``RuntimeError``
    on timeout — that bubbles up to ``extract_with_fallback`` which logs and
    falls through to the vision stage.
    """
    import pytesseract
    from pdf2image import convert_from_path

    pages = convert_from_path(str(pdf_path), dpi=_OCR_DPI)
    parts: list[str] = []
    for img in pages:
        parts.append(
            pytesseract.image_to_string(img, lang="por", timeout=_OCR_TIMEOUT_SEC)
        )
    return "\n".join(parts)


def _vision_extract(pdf_path: Path, vision_client: Any) -> str:
    """Render the first N pages as base64 PNG and ask Claude to transcribe them.

    The adapter's ``transcribe_image_pages`` is async; we bridge here with
    ``asyncio.run`` so the cascade stays synchronous. The worker that calls
    ``extract_with_fallback`` must therefore run it off the event loop
    (``asyncio.to_thread``) — that's the standard pattern for blocking I/O.
    """
    from pdf2image import convert_from_path

    pages = convert_from_path(
        str(pdf_path),
        dpi=_VISION_DPI,
        first_page=1,
        last_page=_VISION_MAX_PAGES,
    )
    image_blocks: list[dict] = []
    for img in pages:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.standard_b64encode(buf.getvalue()).decode("ascii")
        image_blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": b64,
                },
            }
        )
    return asyncio.run(vision_client.transcribe_image_pages(image_blocks))
