"""PDF helpers — text extraction via pdfplumber.

These are the stateless, dependency-free building blocks. The
LLM-driven extraction loop (categorize transactions, dedupe, etc.)
lives at the app layer — Seraphine has it in
``seraphine.tools.financial.ImportFinancialPdfTool`` and Aura would
write its own much simpler version using ``LLMClient`` directly.
"""

from __future__ import annotations

import io


def extract_text(pdf_bytes: bytes, *, password: str | None = None) -> str:
    """Return all extractable text from a PDF, joined by ``\\n\\n`` per page.

    Falls back to an empty string per page if extraction fails. Does
    NOT do OCR — pure text-layer extraction via pdfplumber.
    """
    import pdfplumber

    pages: list[str] = []
    open_kwargs: dict = {}
    if password is not None:
        open_kwargs["password"] = password

    with pdfplumber.open(io.BytesIO(pdf_bytes), **open_kwargs) as pdf:
        for page in pdf.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pages.append("")
    return "\n\n".join(pages)
