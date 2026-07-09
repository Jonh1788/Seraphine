"""Monta o conteúdo do user a partir de imagens legadas + anexos por id.

Provider-aware: ``use_native`` (Claude/cliproxy) emite blocos nativos
(image_url / pdf→document); senão pré-extrai texto (pdfplumber / Anthropic
vision) e injeta como texto — porque o caminho OpenRouter descarta blocos
não-texto.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any

from mod_vision import describe_image, extract_pdf_text

from seraphine.attachments.store import load_attachment
from seraphine.wiki.capture import capture_attachment

_MAX_PDF_TEXT_CHARS = 30_000
_IMG_DESCRIBE_PROMPT = (
    "Descreva objetivamente o conteúdo desta imagem (texto, objetos, dados) "
    "para que eu possa responder perguntas sobre ela."
)


async def build_user_content(
    content: str,
    *,
    images: list[str] | None,
    attachments: list[dict[str, Any]] | None,
    use_native: bool,
    vision_llm: Any | None,
) -> str | list[dict[str, Any]]:
    parts: list[dict[str, Any]] = [{"type": "text", "text": content}]
    extra = False

    for img_url in images or []:
        parts.append({"type": "image_url", "image_url": {"url": img_url}})
        extra = True

    for att in attachments or []:
        att_id = att.get("id") if isinstance(att, dict) else None
        if not att_id:
            continue
        loaded = await asyncio.to_thread(load_attachment, att_id)
        if loaded is None:
            continue
        data, meta = loaded
        # Wiki (Task 7): capture the used attachment as a raw/ source. Fire-and-
        # forget — never blocks or breaks the turn. Nightly run_once ingests it.
        try:
            asyncio.create_task(capture_attachment(str(att_id), data, meta))
        except Exception:
            pass
        kind = meta.get("kind")
        mime = meta.get("mime") or "application/octet-stream"
        name = meta.get("filename", "")

        if kind == "image":
            if use_native:
                b64 = base64.b64encode(data).decode("ascii")
                parts.append(
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
                )
            elif vision_llm is not None:
                try:
                    desc = await describe_image(
                        image_bytes=data, mime_type=mime,
                        prompt=_IMG_DESCRIBE_PROMPT, llm=vision_llm,
                    )
                except Exception:
                    desc = ""
                parts.append(
                    {"type": "text", "text": f'[imagem anexada "{name}"]\n{desc}'.rstrip()}
                )
            else:
                parts.append(
                    {"type": "text",
                     "text": f'[imagem anexada "{name}" — visão indisponível no provider atual]'}
                )
            extra = True

        elif kind == "pdf":
            if use_native:
                b64 = base64.b64encode(data).decode("ascii")
                parts.append({"type": "pdf", "data_url": f"data:application/pdf;base64,{b64}"})
            else:
                text = await asyncio.to_thread(extract_pdf_text, data)
                text = (text or "")[:_MAX_PDF_TEXT_CHARS]
                if not text.strip():
                    text = "[PDF parece escaneado; sem texto extraível no provider atual]"
                parts.append(
                    {"type": "text",
                     "text": f'[conteúdo do PDF "{name}"]\n{text}\n[fim do PDF]'}
                )
            extra = True

    if not extra:
        return content
    return parts
