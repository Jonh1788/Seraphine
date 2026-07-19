"""Trilhas — fontes de curso: URL (ChatGPT share / genérica) ou tópico (deepsearch).

O share do ChatGPT embute a conversa em ``streamController.enqueue("...")``
(turbo-stream: array plano JSON-escapado). O v1 extrai as STRINGS LONGAS em
ordem — o conteúdo didático — sem reconstruir o grafo de papéis (decisão de
spec: o digest alimenta um LLM estruturador; papéis agregam pouco).
"""
from __future__ import annotations

import json
import re

import httpx

from seraphine.courses.generate import CourseGenerationError, research_digest

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
_MAX_BYTES = 2_000_000
# Import de URL: o material integral É o curso — cabe no contexto do modelo
# (120k chars ≈ 30k tokens), então não truncamos como no digest de pesquisa.
# Um cap baixo aqui degrada as últimas lições (visto em produção: conversa de
# 108k chars cortada a 18k → lição final rasa).
_DIGEST_CAP_IMPORT = 120_000
_DIGEST_CAP = 18000  # relatório do deepsearch (denso por construção)
_MIN_CONTENT_LEN = 60      # string do stream conta como conteúdo
_MIN_GENERIC_CHARS = 500   # página genérica precisa disso de texto útil


def is_url(s: str) -> bool:
    s = (s or "").strip()
    return s.startswith("http://") or s.startswith("https://")


async def _get_text(url: str) -> str:
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=20.0,
            headers={"User-Agent": _UA, "Accept-Encoding": "gzip"},
        ) as client:
            r = await client.get(url)
    except Exception as e:  # noqa: BLE001
        raise CourseGenerationError(f"não consegui acessar o link ({type(e).__name__})") from e
    if r.status_code != 200:
        raise CourseGenerationError(f"o link respondeu HTTP {r.status_code}")
    return r.text[:_MAX_BYTES]


def _page_title(html: str) -> str | None:
    m = re.search(r"<title>([^<]{1,200})</title>", html, re.IGNORECASE)
    if not m:
        return None
    t = m.group(1).strip()
    return re.sub(r"^ChatGPT\s*-\s*", "", t) or None


def parse_share_html(html: str) -> dict:
    chunks = re.findall(r'streamController\.enqueue\("((?:[^"\\]|\\.)*)"\)', html)
    if not chunks:
        raise CourseGenerationError("não consegui ler a conversa do link")
    texts: list[str] = []
    for raw in chunks:
        try:
            unescaped = json.loads(f'"{raw}"')   # des-escapa a string JS
            arr = json.loads(unescaped)          # array plano do turbo-stream
        except Exception:  # noqa: BLE001 — chunk malformado: pula
            continue
        if isinstance(arr, list):
            for item in arr:
                if isinstance(item, str) and len(item) >= _MIN_CONTENT_LEN:
                    texts.append(item)
    if not texts:
        raise CourseGenerationError("não consegui ler a conversa do link")
    return {"title": _page_title(html), "text": "\n\n".join(texts)}


def parse_generic_html(html: str) -> dict:
    body = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", body)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) < _MIN_GENERIC_CHARS:
        raise CourseGenerationError("a página não tem texto suficiente (conteúdo via JS?)")
    return {"title": _page_title(html), "text": text}


async def resolve_source(raw: str, *, engine) -> dict:
    raw = (raw or "").strip()
    if is_url(raw):
        html = await _get_text(raw)
        parsed = (parse_share_html(html) if "chatgpt.com/share/" in raw
                  else parse_generic_html(html))
        return {"title": parsed["title"], "digest": parsed["text"][:_DIGEST_CAP_IMPORT],
                "source_ref": raw}
    digest = await research_digest(engine, raw)
    return {"title": None, "digest": digest, "source_ref": None}
