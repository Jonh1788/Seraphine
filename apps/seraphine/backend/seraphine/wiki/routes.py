"""Read-only HTTP surface for the LLM wiki."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from seraphine.wiki import files

router = APIRouter(prefix="/wiki", tags=["wiki"])


@router.get("/index")
async def wiki_index() -> list[dict[str, Any]]:
    return [
        {"slug": p["slug"], "title": p["title"], "summary": p["summary"],
         "category": p["category"], "updated_at": p["updated_at"]}
        for p in files.list_pages()
    ]


@router.get("/page/{slug}")
async def wiki_page(slug: str) -> dict[str, Any]:
    if not files.is_safe_slug(slug):
        raise HTTPException(status_code=400, detail="bad slug")
    page = files.read_page(slug)
    if page is None:
        raise HTTPException(status_code=404, detail="not found")
    backlinks = [
        {"slug": p["slug"], "title": p["title"]}
        for p in files.list_pages()
        if files.norm_title(page["title"]) in {files.norm_title(t) for t in (set(p["links"]) | set(files.wikilinks(p["body"])))}
        and p["slug"] != slug
    ]
    return {
        "slug": slug, "title": page["title"], "category": page["category"],
        "updated_at": page["updated_at"], "sources": page["sources"],
        "links": page["links"], "body": page["body"], "backlinks": backlinks,
    }


@router.get("/graph")
async def wiki_graph() -> dict[str, Any]:
    return files.graph()


@router.get("/source/{ref:path}")
async def wiki_source(ref: str) -> dict[str, Any]:
    content = files.read_source(ref)
    if content is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"ref": ref, "content": content}
