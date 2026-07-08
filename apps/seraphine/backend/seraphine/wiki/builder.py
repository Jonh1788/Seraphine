"""LLM-driven wiki maintainer: propose pages (structured JSON), code applies."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from llm_adapters.types import ChatMessage

from seraphine.wiki import files

logger = logging.getLogger("seraphine.wiki.builder")

_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)

_BUILD_PROMPT = (
    "Você mantém uma wiki pessoal de conhecimento em markdown. Recebe UMA fonte "
    "nova e a lista de páginas existentes. Sintetize ou atualize páginas de "
    "CONCEITO/TÓPICO a partir da fonte, incorporando o conteúdo relevante de uma "
    "página existente quando estiver atualizando-a. Markdown claro e objetivo, com "
    "links [[Título Da Página]] pra páginas relacionadas. NÃO invente fatos fora da "
    "fonte. Retorne JSON ESTRITO, sem prosa:\n"
    '{"pages":[{"slug":"kebab-case","title":"...","category":"topic","body":"markdown","links":["Outra Página"]}]}\n'
    'Se a fonte não render página, retorne {"pages":[]}.'
)


def _parse_page_ops(raw: str) -> list[dict[str, Any]]:
    m = _JSON_OBJ_RE.search(raw or "")
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    ops: list[dict[str, Any]] = []
    for p in data.get("pages") or []:
        if not isinstance(p, dict):
            continue
        title = str(p.get("title") or "").strip()
        body = str(p.get("body") or "").strip()
        slug = str(p.get("slug") or files.slugify(title))
        category = str(p.get("category") or "topic").strip()
        links = [str(x).strip() for x in (p.get("links") or []) if str(x).strip()]
        if not files.is_safe_slug(slug) or not title or not body:
            continue
        if category not in ("topic", "person"):
            category = "topic"
        ops.append({"slug": slug, "title": title, "category": category, "body": body, "links": links})
    return ops


async def build_pages_from_source(
    source: dict[str, Any], existing_pages: list[dict[str, Any]], llm: Any,
) -> list[dict[str, Any]]:
    existing_blob = "\n\n".join(
        f"### [{p['slug']}] {p['title']}\n{(p.get('body') or '')[:2000]}"
        for p in existing_pages[:8]
    ) or "(nenhuma)"
    user = (
        f"FONTE ({source.get('ref', '')}): {source.get('title', '')}\n"
        f"{(source.get('text') or '')[:12000]}\n\nPÁGINAS EXISTENTES:\n{existing_blob}"
    )
    messages = [
        ChatMessage(role="system", content=_BUILD_PROMPT),
        ChatMessage(role="user", content=user),
    ]
    acc: list[str] = []
    try:
        async for tok in llm.chat(messages, temperature=0.2):
            if getattr(tok, "text", None):
                acc.append(tok.text)
    except Exception as e:
        logger.warning("build_pages_from_source: llm failed: %s", e)
        return []
    return _parse_page_ops("".join(acc))


def apply_page_ops(ops: list[dict[str, Any]], source_ref: str | None) -> list[str]:
    touched: list[str] = []
    for op in ops:
        files.write_page(
            slug=op["slug"], title=op["title"], category=op["category"],
            sources=[source_ref] if source_ref else [], links=op["links"], body=op["body"],
        )
        touched.append(op["slug"])
    return touched


def lint() -> dict[str, Any]:
    pages = files.list_pages()
    by_title = {files.norm_title(p["title"]): p["slug"] for p in pages}
    broken: list[dict[str, str]] = []
    linked: set[str] = set()
    for p in pages:
        for t in set(p["links"]) | set(files.wikilinks(p["body"])):
            tgt = by_title.get(files.norm_title(t))
            if tgt is None:
                broken.append({"page": p["slug"], "link": t})
            elif tgt != p["slug"]:
                linked.add(tgt)
    orphans = [p["slug"] for p in pages if p["slug"] not in linked]
    return {"broken_links": broken, "orphans": orphans}
