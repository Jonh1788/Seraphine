"""mod-vision — PDF text extraction + LLM-driven image description.

Two stateless modules:

- ``pdf.extract_text(bytes, password=...)``: pdfplumber wrapper.
- ``image.describe_image(image_bytes, mime_type, prompt, llm, ...)``:
  one-shot Anthropic vision call returning text.

Higher-level workflows (financial PDF parsing, receipt categorization)
live at the app/tool layer — those compose multiple LLM calls, prompt
caching, dedup logic, and per-app conventions.
"""

from mod_vision.pdf import extract_text as extract_pdf_text
from mod_vision.image import describe_image

__all__ = ["extract_pdf_text", "describe_image"]
