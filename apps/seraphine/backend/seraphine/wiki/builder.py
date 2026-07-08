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


from datetime import datetime, timezone

from seraphine.wiki import capture

_EPOCH = "1970-01-01T00:00:00+00:00"

_PERSON_PROMPT = (
    "Você mantém uma página de wiki sobre uma PESSOA. Recebe os dados da pessoa e "
    "trechos de menções. Escreva uma página markdown objetiva (quem é, relação, o "
    "que sabemos), sem inventar. Retorne JSON ESTRITO:\n"
    '{"pages":[{"slug":"kebab","title":"Nome","category":"person","body":"markdown","links":[]}]}'
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def build_person_pages(store: Any, llm: Any, since: str) -> list[str]:
    """Rebuild a page for each person mentioned since `since`. Returns slugs."""
    updated: list[str] = []
    try:
        people = await store.list_people(limit=50)
    except Exception as e:
        logger.warning("build_person_pages: list_people failed: %s", e)
        return updated
    for person in people:
        if (person.get("last_mentioned_at") or "") <= since:
            continue
        try:
            mentions = await store.list_person_mentions(person["id"], limit=8)
        except Exception:
            mentions = []
        ctx = "\n".join(f"- {m.get('context', '')}" for m in mentions) or "(sem menções)"
        user = (
            f"PESSOA: {person.get('name', '')}\nrelação: {person.get('relation', '')}\n"
            f"tags: {', '.join(person.get('tags') or [])}\nMENÇÕES:\n{ctx}"
        )
        messages = [
            ChatMessage(role="system", content=_PERSON_PROMPT),
            ChatMessage(role="user", content=user),
        ]
        acc: list[str] = []
        try:
            async for tok in llm.chat(messages, temperature=0.2):
                if getattr(tok, "text", None):
                    acc.append(tok.text)
        except Exception:
            continue
        ops = [op for op in _parse_page_ops("".join(acc)) if op["category"] == "person"]
        touched = apply_page_ops(ops, source_ref=None)
        if touched:
            files.append_log(f"person | {person.get('name', '')} -> {', '.join(touched)}")
            updated.extend(touched)
    return updated


async def run_once(store: Any, llm: Any, deepsearch_service: Any) -> dict[str, Any]:
    """One nightly pass: ingest new deepsearch + attachment sources, rebuild
    person pages, index, lint. Advances the watermark. Read-only on memory."""
    start = _now_iso()
    try:
        watermark = (await store.get_kv("wiki_last_ingest_at")) or _EPOCH
    except Exception:
        watermark = _EPOCH

    sources_ingested = 0

    # 1) new deepsearch runs
    try:
        runs = await deepsearch_service.list_runs(limit=100) if deepsearch_service else []
    except Exception as e:
        logger.warning("run_once: list_runs failed: %s", e)
        runs = []
    new_runs = [
        r for r in runs
        if r.get("status") == "done" and (r.get("report") or "").strip()
        and (r.get("created_at") or "") > watermark
    ]
    for run in new_runs:
        ref = capture.export_deepsearch_run(run)
        if not ref:
            continue
        source = {"ref": ref, "title": run.get("query", ""), "text": run.get("report", "")}
        ops = await build_pages_from_source(source, files.list_pages(), llm)
        touched = apply_page_ops(ops, source_ref=ref)
        if touched:
            files.append_log(f"ingest | {run.get('query', '')} -> {', '.join(touched)}")
            sources_ingested += 1

    # 2) new attachment sources (captured on-the-fly into raw/attachments)
    wm_dt = _parse_iso(watermark)
    att_dir = files.wiki_root() / "raw" / "attachments"
    for p in sorted(att_dir.glob("*.md")):
        if p.stat().st_mtime <= wm_dt:
            continue
        ref = f"attachments/{p.stem}.md"
        source = {"ref": ref, "title": p.stem, "text": p.read_text(encoding="utf-8")}
        ops = await build_pages_from_source(source, files.list_pages(), llm)
        touched = apply_page_ops(ops, source_ref=ref)
        if touched:
            files.append_log(f"ingest | anexo {p.stem} -> {', '.join(touched)}")
            sources_ingested += 1

    # 3) person pages
    people_updated = await build_person_pages(store, llm, since=watermark)

    # 4) index + lint
    files.write_index()
    report = lint()
    files.append_log(
        f"lint | broken={len(report['broken_links'])} orphans={len(report['orphans'])}"
    )

    try:
        await store.set_kv("wiki_last_ingest_at", start)
    except Exception:
        pass

    return {
        "sources_ingested": sources_ingested,
        "people_updated": len(people_updated),
        "lint": report,
    }


def _parse_iso(s: str) -> float:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0
