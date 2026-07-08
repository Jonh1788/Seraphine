"""Filesystem + frontmatter + graph helpers for the LLM wiki.

Everything is confined to the wiki data dir. Frontmatter is a fixed,
hand-rolled format (we own both writer and reader) — no yaml dep.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from seraphine.config import settings

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def wiki_root() -> Path:
    override = os.environ.get("SERAPHINE_WIKI_DATA_DIR")
    if override:
        root = Path(override)
    else:
        data = os.environ.get("SERAPHINE_DATA_DIR")
        base = Path(data) if data else Path(settings.sqlite_path).parent
        root = base / "wiki"
    (root / "raw" / "research").mkdir(parents=True, exist_ok=True)
    (root / "raw" / "attachments").mkdir(parents=True, exist_ok=True)
    (root / "wiki").mkdir(parents=True, exist_ok=True)
    return root


def is_safe_slug(slug: str) -> bool:
    return bool(_SLUG_RE.match(slug or ""))


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", _strip_accents((title or "").lower())).strip("-")
    return (s or "pagina")[:80]


def norm_title(title: str) -> str:
    return _strip_accents((title or "").strip().lower())


def wikilinks(body: str) -> list[str]:
    return [m.strip() for m in _WIKILINK_RE.findall(body or "")]


def _strip_accents(s: str) -> str:
    import unicodedata
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)
    )


def _join(xs: list[str]) -> str:
    return " | ".join(str(x).replace("|", "/").strip() for x in xs)


def serialize_page(
    *, title: str, category: str, updated_at: str,
    sources: list[str], links: list[str], body: str,
) -> str:
    fm = (
        "---\n"
        f"title: {title}\n"
        f"category: {category}\n"
        f"updated_at: {updated_at}\n"
        f"sources: {_join(sources)}\n"
        f"links: {_join(links)}\n"
        "---\n"
    )
    return fm + "\n" + (body or "").strip() + "\n"


def parse_page(text: str) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "title": "", "category": "", "updated_at": "", "sources": [], "links": [],
    }
    body = text or ""
    if body.startswith("---\n"):
        end = body.find("\n---\n", 4)
        if end != -1:
            head = body[4:end]
            body = body[end + 5:]
            for line in head.splitlines():
                k, _, v = line.partition(": ")
                k = k.strip()
                v = v.strip()
                if k in ("sources", "links"):
                    meta[k] = [p.strip() for p in v.split("|") if p.strip()] if v else []
                elif k in meta:
                    meta[k] = v
    meta["body"] = body.strip()
    return meta


def _page_path(slug: str) -> Path:
    return wiki_root() / "wiki" / f"{slug}.md"


def read_page(slug: str) -> dict[str, Any] | None:
    if not is_safe_slug(slug):
        return None
    p = _page_path(slug)
    if not p.is_file():
        return None
    d = parse_page(p.read_text(encoding="utf-8"))
    d["slug"] = slug
    return d


def write_page(
    *, slug: str, title: str, category: str,
    sources: list[str], links: list[str], body: str,
) -> None:
    if not is_safe_slug(slug):
        return
    existing = read_page(slug)
    prior_sources = existing["sources"] if existing else []
    all_sources = list(dict.fromkeys([*prior_sources, *sources]))
    text = serialize_page(
        title=title, category=category, updated_at=_now_iso(),
        sources=all_sources, links=links, body=body,
    )
    _page_path(slug).write_text(text, encoding="utf-8")


def list_pages() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in sorted((wiki_root() / "wiki").glob("*.md")):
        d = parse_page(p.read_text(encoding="utf-8"))
        d["slug"] = p.stem
        d["summary"] = (d["body"].splitlines()[0].strip() if d["body"] else "")[:160]
        out.append(d)
    return out


def graph() -> dict[str, Any]:
    pages = list_pages()
    by_title = {norm_title(p["title"]): p["slug"] for p in pages}
    nodes = [{"id": p["slug"], "title": p["title"], "category": p["category"]} for p in pages]
    seen: set[tuple[str, str]] = set()
    edges: list[dict[str, str]] = []
    for p in pages:
        targets = set(p["links"]) | set(wikilinks(p["body"]))
        for t in targets:
            tgt = by_title.get(norm_title(t))
            if tgt and tgt != p["slug"] and (p["slug"], tgt) not in seen:
                seen.add((p["slug"], tgt))
                edges.append({"source": p["slug"], "target": tgt})
    return {"nodes": nodes, "edges": edges}


def read_source(ref: str) -> str | None:
    if not ref or ".." in ref or ref.startswith("/"):
        return None
    raw_dir = (wiki_root() / "raw").resolve()
    p = (raw_dir / ref).resolve()
    if raw_dir != p and raw_dir not in p.parents:
        return None
    if not p.is_file():
        return None
    return p.read_text(encoding="utf-8")


def write_index() -> None:
    pages = list_pages()
    lines = ["# Índice da Wiki", ""]
    for p in pages:
        lines.append(f"- [{p['title']}](wiki/{p['slug']}.md) — {p['summary']} `[{p['category']}]`")
    (wiki_root() / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_log(entry: str) -> None:
    line = f"## [{_now_iso()}] {entry}\n"
    log = wiki_root() / "log.md"
    with log.open("a", encoding="utf-8") as fh:
        fh.write(line)
