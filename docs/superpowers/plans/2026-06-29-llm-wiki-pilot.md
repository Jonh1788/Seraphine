# LLM Wiki (piloto read-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um job noturno sintetiza `/data/wiki` (markdown mantido pelo LLM) a partir de deepsearches + anexos + fatos/pessoas, com citações; uma aba "Wiki" renderiza páginas (react-markdown) + grafo (react-force-graph-2d). Read-only: não muta o fact-store nem entra no retrieval do chat.

**Architecture:** Módulo `seraphine/wiki/` isolado: `files.py` (filesystem + frontmatter + grafo), `capture.py` (export de fonte → raw/), `builder.py` (LLM propõe páginas em JSON estruturado; código valida/aplica + index + log + lint; person pages; `run_once` com watermark KV), `routes.py` (`/wiki`). Um loop asyncio no lifespan (espelha `_memory_audit_loop`) roda `run_once`. Frontend `src/wiki/` (view + grafo). Único toque fora do módulo: um hook fire-and-forget em `attachments/content.py`.

**Tech Stack:** Python/FastAPI (uv, sqlite, pdfplumber via mod-vision), `llm_adapters` (AnthropicClient async `chat`), React+TS (Vite, pnpm, react-markdown, react-force-graph-2d).

## Global Constraints

- Backend tests: rodar de `apps/seraphine/backend` com `uv run pytest` (pytest `asyncio_mode = "auto"`). Um teste: `uv run pytest tests/test_x.py::test_y -v`.
- **Read-only:** o módulo wiki NUNCA escreve em `facts`/`people`/`deepsearch_runs` nem chama o retrieval do chat. Só lê. Só escreve dentro de `/data/wiki`.
- **Wiki dir:** `Path(os.environ.get("SERAPHINE_WIKI_DATA_DIR") or (os.environ.get("SERAPHINE_DATA_DIR") or Path(settings.sqlite_path).parent) / "wiki")`. Subdirs: `raw/research/`, `raw/attachments/`, `wiki/`, mais `index.md` e `log.md`.
- **LLM interface:** `llm.chat(messages, temperature=...)` é async-generator de tokens com `.text`; acumula e junta. `from llm_adapters.types import ChatMessage` (`ChatMessage(role=..., content=...)`).
- **Parse estruturado:** LLM retorna JSON estrito; parse tolerante (pega o 1º `{...}` via `re.compile(r"\{.*\}", re.DOTALL)`), valida (slug seguro, título/body não-vazios, category ∈ {topic, person}); proposta inválida é descartada, não crasha. Espelha `_parse_audit_json`.
- **category** de página ∈ `{"topic", "person"}`. Entidade v1 = só **pessoa** (tabela `people`); projeto fora de escopo.
- **Watermark:** KV `wiki_last_ingest_at` (ISO). `store.get_kv/set_kv` são async, valor texto opaco.
- **Traversal-safe:** slug casa `^[a-z0-9][a-z0-9-]{0,80}$`; `ref` de fonte confinado a `raw/`.
- **Sem emoji em ícones** (SVG / `src/icons/Icons.tsx`).
- **FE:** multipart/fetch sem auth; `API_BASE` de `../api`; typecheck via `pnpm --filter seraphine-web build` (não há script `typecheck`; `tsc -b` roda no build). Dep nova: `react-force-graph-2d` (`pnpm --filter seraphine-web add react-force-graph-2d`).
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Backend (novos):**
- `apps/seraphine/backend/seraphine/wiki/__init__.py`
- `apps/seraphine/backend/seraphine/wiki/files.py`
- `apps/seraphine/backend/seraphine/wiki/capture.py`
- `apps/seraphine/backend/seraphine/wiki/builder.py`
- `apps/seraphine/backend/seraphine/wiki/routes.py`
- Tests: `tests/test_wiki_files.py`, `tests/test_wiki_capture.py`, `tests/test_wiki_builder.py`, `tests/test_wiki_builder_run.py`, `tests/test_wiki_routes.py`

**Backend (modificar):**
- `apps/seraphine/backend/seraphine/config.py` — `wiki_build_interval_s`
- `apps/seraphine/backend/seraphine/main.py` — include router + loop `_wiki_build_loop`
- `apps/seraphine/backend/seraphine/attachments/content.py` — 1 linha fire-and-forget (hook)

**Frontend (novos):** `src/wiki/types.ts`, `src/wiki/api.ts`, `src/wiki/WikiView.tsx`, `src/wiki/index.ts`, `src/wiki/obsidian.css`
**Frontend (modificar):** `src/stores/uiStore.ts`, `src/AppLayout.tsx`, `package.json` (dep)

---

## Task 1: `files.py` — filesystem + frontmatter + grafo

**Files:**
- Create: `apps/seraphine/backend/seraphine/wiki/__init__.py`, `apps/seraphine/backend/seraphine/wiki/files.py`
- Test: `apps/seraphine/backend/tests/test_wiki_files.py`

**Interfaces:**
- Produces: `wiki_root()->Path`, `is_safe_slug(s)->bool`, `slugify(t)->str`, `norm_title(t)->str`, `wikilinks(body)->list[str]`, `serialize_page(...)->str`, `parse_page(text)->dict`, `read_page(slug)->dict|None`, `write_page(*,slug,title,category,sources,links,body)->None`, `list_pages()->list[dict]`, `graph()->dict`, `read_source(ref)->str|None`, `write_index()->None`, `append_log(entry)->None`.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_files.py`:

```python
import seraphine.wiki.files as f


def test_slug_and_title_helpers():
    assert f.is_safe_slug("abc-123")
    assert not f.is_safe_slug("../x")
    assert not f.is_safe_slug("")
    assert f.slugify("Olá, Mundo!") == "ola-mundo"
    assert f.norm_title("  Foo Bar ") == "foo bar"


def test_wikilinks_extraction():
    assert f.wikilinks("veja [[Página A]] e [[Outra]] aqui") == ["Página A", "Outra"]


def test_serialize_parse_roundtrip():
    text = f.serialize_page(
        title="Conceito X", category="topic", updated_at="2026-06-29T00:00:00+00:00",
        sources=["research/a.md", "attachments/b.md"], links=["Página A"],
        body="# Corpo\ncom [[Página A]].",
    )
    d = f.parse_page(text)
    assert d["title"] == "Conceito X"
    assert d["category"] == "topic"
    assert d["sources"] == ["research/a.md", "attachments/b.md"]
    assert d["links"] == ["Página A"]
    assert "Corpo" in d["body"]


def test_write_read_page_accumulates_sources(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="x", title="X", category="topic", sources=["research/a.md"], links=[], body="corpo1")
    f.write_page(slug="x", title="X", category="topic", sources=["research/b.md"], links=[], body="corpo2")
    d = f.read_page("x")
    assert d["body"] == "corpo2"
    assert d["sources"] == ["research/a.md", "research/b.md"]  # accumulated, deduped
    assert f.read_page("../etc/passwd") is None


def test_graph_from_links(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="a", title="Página A", category="topic", sources=[], links=["Página B"], body="liga em [[Página B]]")
    f.write_page(slug="b", title="Página B", category="topic", sources=[], links=[], body="folha")
    g = f.graph()
    assert {n["id"] for n in g["nodes"]} == {"a", "b"}
    assert {"source": "a", "target": "b"} in g["edges"]
    assert len(g["edges"]) == 1  # deduped, no self/back edge invented


def test_read_source_confined_to_raw(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    (f.wiki_root() / "raw" / "research" / "s.md").write_text("fonte", encoding="utf-8")
    assert f.read_source("research/s.md") == "fonte"
    assert f.read_source("../../etc/passwd") is None
    assert f.read_source("/etc/passwd") is None


def test_write_index_and_log(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="a", title="Página A", category="topic", sources=[], links=[], body="resumo linha um\nmais")
    f.write_index()
    idx = (f.wiki_root() / "index.md").read_text(encoding="utf-8")
    assert "Página A" in idx and "a.md" in idx
    f.append_log("ingest | fonte X -> a")
    log = (f.wiki_root() / "log.md").read_text(encoding="utf-8")
    assert "ingest | fonte X -> a" in log
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_wiki_files.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.wiki'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/wiki/__init__.py` (empty).

Create `apps/seraphine/backend/seraphine/wiki/files.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_wiki_files.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/__init__.py \
        apps/seraphine/backend/seraphine/wiki/files.py \
        apps/seraphine/backend/tests/test_wiki_files.py
git commit -m "feat(wiki): filesystem + frontmatter + graph helpers"
```

---

## Task 2: `capture.py` — export de fonte → raw/

**Files:**
- Create: `apps/seraphine/backend/seraphine/wiki/capture.py`
- Test: `apps/seraphine/backend/tests/test_wiki_capture.py`

**Interfaces:**
- Consumes: `files.wiki_root` (Task 1); `mod_vision.extract_pdf_text`.
- Produces: `export_deepsearch_run(run: dict) -> str|None` (escreve `raw/research/<date>-<slug>.md`, retorna o `ref` relativo tipo `"research/…md"`); `async capture_attachment(att_id, data, meta) -> str|None` (escreve `raw/attachments/<id>.md`, idempotente, retorna ref).

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_capture.py`:

```python
import seraphine.wiki.capture as cap
import seraphine.wiki.files as f


def test_export_deepsearch_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    run = {"id": "r1", "query": "café arábica", "report": "# Resultado\nblá", "created_at": "2026-06-29T10:00:00+00:00", "status": "done"}
    ref = cap.export_deepsearch_run(run)
    assert ref and ref.startswith("research/")
    text = f.read_source(ref)
    assert "café arábica" in text and "Resultado" in text


def test_export_deepsearch_run_skips_empty_report(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    assert cap.export_deepsearch_run({"id": "r2", "query": "x", "report": "", "created_at": "2026-06-29T10:00:00+00:00", "status": "done"}) is None


async def test_capture_attachment_pdf(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(cap, "extract_pdf_text", lambda data, **k: "TEXTO DO PDF")
    meta = {"kind": "pdf", "mime": "application/pdf", "filename": "doc.pdf"}
    ref = await cap.capture_attachment("att123", b"%PDF-...", meta)
    assert ref == "attachments/att123.md"
    text = f.read_source(ref)
    assert "TEXTO DO PDF" in text and "doc.pdf" in text
    # idempotent: second call does not duplicate / re-extract
    ref2 = await cap.capture_attachment("att123", b"%PDF-...", meta)
    assert ref2 == ref


async def test_capture_attachment_image_stub(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    meta = {"kind": "image", "mime": "image/png", "filename": "foto.png"}
    ref = await cap.capture_attachment("img1", b"\x89PNG", meta)
    text = f.read_source(ref)
    assert "foto.png" in text  # v1: minimal image source note
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_capture.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.wiki.capture'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/wiki/capture.py`:

```python
"""Export sources into the immutable raw/ layer of the wiki."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from mod_vision import extract_pdf_text

from seraphine.wiki import files

logger = logging.getLogger("seraphine.wiki.capture")

_MAX_PDF_CHARS = 30_000


def export_deepsearch_run(run: dict[str, Any]) -> str | None:
    """Write a done deepsearch report into raw/research/. Returns the ref."""
    report = (run.get("report") or "").strip()
    if not report:
        return None
    created = (run.get("created_at") or "")[:10] or "0000-00-00"
    slug = files.slugify(run.get("query") or run.get("id") or "pesquisa")
    ref = f"research/{created}-{slug}.md"
    path = files.wiki_root() / "raw" / ref
    if path.exists():
        return ref
    header = f"# Pesquisa: {run.get('query', '')}\n\n_id: {run.get('id', '')} · {run.get('created_at', '')}_\n\n"
    path.write_text(header + report + "\n", encoding="utf-8")
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_wiki_capture.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/capture.py \
        apps/seraphine/backend/tests/test_wiki_capture.py
git commit -m "feat(wiki): capture deepsearch runs and attachments into raw/"
```

---

## Task 3: `builder.py` (parte 1) — fonte → page ops → apply + index + log + lint

**Files:**
- Create: `apps/seraphine/backend/seraphine/wiki/builder.py`
- Test: `apps/seraphine/backend/tests/test_wiki_builder.py`

**Interfaces:**
- Consumes: `files` (Task 1); `llm_adapters.types.ChatMessage`; an `llm` with `async chat(messages, temperature=...)` yielding tokens with `.text`.
- Produces: `async build_pages_from_source(source: dict, existing_pages: list[dict], llm) -> list[dict]` (page ops), `_parse_page_ops(raw)->list[dict]`, `apply_page_ops(ops: list[dict], source_ref: str|None) -> list[str]`, `lint() -> dict`.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_builder.py`:

```python
import seraphine.wiki.builder as b
import seraphine.wiki.files as f


class _Tok:
    def __init__(self, text): self.text = text


class _FakeLLM:
    def __init__(self, payload): self._payload = payload
    async def chat(self, messages, temperature=0.2):
        yield _Tok(self._payload)


def test_parse_page_ops_valid_and_invalid():
    raw = 'prosa {"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"corpo","links":["Arábica"]},{"slug":"../bad","title":"x","body":"y"},{"title":"","body":""}]} fim'
    ops = b._parse_page_ops(raw)
    assert len(ops) == 1
    assert ops[0]["slug"] == "cafe" and ops[0]["links"] == ["Arábica"]


def test_parse_page_ops_bad_json():
    assert b._parse_page_ops("sem json") == []
    assert b._parse_page_ops('{"pages": not json}') == []


async def test_build_pages_from_source():
    llm = _FakeLLM('{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"sobre café","links":[]}]}')
    ops = await b.build_pages_from_source(
        {"ref": "research/x.md", "title": "Café", "text": "café é bom"}, [], llm,
    )
    assert ops == [{"slug": "cafe", "title": "Café", "category": "topic", "body": "sobre café", "links": []}]


async def test_build_pages_from_source_llm_error():
    class _Boom:
        async def chat(self, messages, temperature=0.2):
            raise RuntimeError("down")
            yield  # pragma: no cover
    assert await b.build_pages_from_source({"ref": "r", "title": "t", "text": "x"}, [], _Boom()) == []


def test_apply_page_ops_writes_pages(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    touched = b.apply_page_ops(
        [{"slug": "cafe", "title": "Café", "category": "topic", "body": "corpo", "links": ["Arábica"]}],
        "research/x.md",
    )
    assert touched == ["cafe"]
    d = f.read_page("cafe")
    assert d["title"] == "Café" and d["sources"] == ["research/x.md"]


def test_lint_detects_broken_and_orphan(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="a", title="A", category="topic", sources=[], links=["Inexistente"], body="liga [[Inexistente]]")
    f.write_page(slug="b", title="B", category="topic", sources=[], links=[], body="ninguém liga aqui")
    rep = b.lint()
    assert {"page": "a", "link": "Inexistente"} in rep["broken_links"]
    assert "b" in rep["orphans"] and "a" in rep["orphans"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_builder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.wiki.builder'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/wiki/builder.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_wiki_builder.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/builder.py \
        apps/seraphine/backend/tests/test_wiki_builder.py
git commit -m "feat(wiki): builder — source→page ops (structured LLM), apply, lint"
```

---

## Task 4: `builder.py` (parte 2) — person pages + `run_once`

**Files:**
- Modify: `apps/seraphine/backend/seraphine/wiki/builder.py`
- Test: `apps/seraphine/backend/tests/test_wiki_builder_run.py`

**Interfaces:**
- Consumes: `build_pages_from_source`, `apply_page_ops`, `lint` (Task 3); `files` (Task 1); `capture.export_deepsearch_run` (Task 2); a `store` exposing async `get_kv/set_kv`, `list_people(limit)`, `list_person_mentions(person_id, limit)`; a `deepsearch_service` exposing async `list_runs(limit)`.
- Produces: `async build_person_pages(store, llm, since: str) -> list[str]`, `async run_once(store, llm, deepsearch_service) -> dict`.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_builder_run.py`:

```python
import seraphine.wiki.builder as b
import seraphine.wiki.files as f


class _Tok:
    def __init__(self, text): self.text = text


class _FakeLLM:
    def __init__(self, payload): self._payload = payload
    async def chat(self, messages, temperature=0.2):
        yield _Tok(self._payload)


class _FakeStore:
    def __init__(self, people=None, mentions=None):
        self._kv = {}
        self._people = people or []
        self._mentions = mentions or {}
    async def get_kv(self, k): return self._kv.get(k)
    async def set_kv(self, k, v): self._kv[k] = v
    async def list_people(self, limit=30): return self._people
    async def list_person_mentions(self, pid, limit=5): return self._mentions.get(pid, [])


class _FakeDeep:
    def __init__(self, runs): self._runs = runs
    async def list_runs(self, limit=100): return self._runs


async def test_run_once_ingests_deepsearch_and_advances_watermark(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore()
    deep = _FakeDeep([
        {"id": "r1", "query": "café", "report": "# Café\nbom", "status": "done", "created_at": "2026-06-29T10:00:00+00:00"},
        {"id": "r0", "query": "velho", "report": "# Velho", "status": "done", "created_at": "2020-01-01T00:00:00+00:00"},
    ])
    llm = _FakeLLM('{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"resumo","links":[]}]}')
    # watermark in the past → r1 is new, r0 stays old only if we set watermark; here none → both new
    await store.set_kv("wiki_last_ingest_at", "2025-01-01T00:00:00+00:00")
    summary = await b.run_once(store, llm, deep)
    assert summary["sources_ingested"] == 1  # only r1 (r0 is before watermark)
    assert f.read_page("cafe") is not None
    assert (await store.get_kv("wiki_last_ingest_at")) > "2025-01-01T00:00:00+00:00"
    # index + log written
    assert (f.wiki_root() / "index.md").exists()
    assert (f.wiki_root() / "log.md").exists()


async def test_run_once_builds_person_page(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore(
        people=[{"id": "p1", "name": "Ana", "relation": "amiga", "last_mentioned_at": "2026-06-29T10:00:00+00:00", "tags": ["design"]}],
        mentions={"p1": [{"context": "Ana ama café", "sentiment": "pos", "created_at": "2026-06-29T09:00:00+00:00"}]},
    )
    deep = _FakeDeep([])
    llm = _FakeLLM('{"pages":[{"slug":"ana","title":"Ana","category":"person","body":"amiga designer","links":[]}]}')
    await store.set_kv("wiki_last_ingest_at", "2025-01-01T00:00:00+00:00")
    summary = await b.run_once(store, llm, deep)
    assert summary["people_updated"] == 1
    d = f.read_page("ana")
    assert d["category"] == "person"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_builder_run.py -v`
Expected: FAIL — `AttributeError: module 'seraphine.wiki.builder' has no attribute 'run_once'`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/seraphine/backend/seraphine/wiki/builder.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_wiki_builder_run.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/builder.py \
        apps/seraphine/backend/tests/test_wiki_builder_run.py
git commit -m "feat(wiki): person pages + run_once orchestration with watermark"
```

---

## Task 5: `/wiki` API routes

**Files:**
- Create: `apps/seraphine/backend/seraphine/wiki/routes.py`
- Modify: `apps/seraphine/backend/seraphine/main.py` (include_router, região dos outros includes ~1296)
- Test: `apps/seraphine/backend/tests/test_wiki_routes.py`

**Interfaces:**
- Consumes: `files` (Task 1): `list_pages`, `read_page`, `graph`, `read_source`, `read_index` (via reading `index.md`? use `files` helpers).
- Produces: router `APIRouter(prefix="/wiki")` — `GET /wiki/index`, `GET /wiki/page/{slug}`, `GET /wiki/graph`, `GET /wiki/source/{ref:path}`.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_routes.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

import seraphine.wiki.files as f
from seraphine.wiki.routes import router


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="cafe", title="Café", category="topic", sources=["research/x.md"], links=["Arábica"], body="sobre [[Arábica]]")
    f.write_page(slug="arabica", title="Arábica", category="topic", sources=[], links=[], body="variedade")
    (f.wiki_root() / "raw" / "research" / "x.md").write_text("fonte café", encoding="utf-8")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_index(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/wiki/index")
    assert r.status_code == 200
    slugs = {p["slug"] for p in r.json()}
    assert slugs == {"cafe", "arabica"}


def test_page(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/wiki/page/cafe")
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Café" and body["sources"] == ["research/x.md"]
    assert c.get("/wiki/page/naoexiste").status_code == 404
    assert c.get("/wiki/page/..%2f..%2fetc").status_code in (400, 404)


def test_graph(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    g = c.get("/wiki/graph").json()
    assert {"source": "cafe", "target": "arabica"} in g["edges"]


def test_source(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.get("/wiki/source/research/x.md").text.strip('"') == "fonte café" or "fonte café" in c.get("/wiki/source/research/x.md").json()
    assert c.get("/wiki/source/../../etc/passwd").status_code in (400, 404)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_routes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.wiki.routes'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/wiki/routes.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_wiki_routes.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the router into main.py**

In `apps/seraphine/backend/seraphine/main.py`, na região dos `app.include_router(...)` (logo após `app.include_router(attachments_router)`), adicione:

```python
    from seraphine.wiki.routes import router as wiki_router
    app.include_router(wiki_router)
```

- [ ] **Step 6: Verify import + routes test still pass**

Run: `uv run python -c "import seraphine.main" && uv run pytest tests/test_wiki_routes.py -v`
Expected: import OK; PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/routes.py \
        apps/seraphine/backend/seraphine/main.py \
        apps/seraphine/backend/tests/test_wiki_routes.py
git commit -m "feat(wiki): /wiki read-only API + router wiring"
```

---

## Task 6: Config + nightly loop (`_wiki_build_loop`)

**Files:**
- Modify: `apps/seraphine/backend/seraphine/config.py` (add field junto de `memory_audit_interval_s`)
- Modify: `apps/seraphine/backend/seraphine/main.py` (loop no lifespan; espelha `_memory_audit_loop`)

**Interfaces:**
- Consumes: `builder.run_once(store, llm, deepsearch_service)` (Task 4); `store`, `llm`, `deepsearch_service` do escopo do lifespan.

- [ ] **Step 1: Add the config field**

In `apps/seraphine/backend/seraphine/config.py`, logo após `memory_audit_interval_s: int = 86400  # 24h`, adicione:

```python
    # Scheduled read-only "LLM wiki" build pass (Karpathy pattern): synthesizes
    # /data/wiki markdown from new deepsearch runs + captured attachments +
    # people. Daily cadence; watermark short-circuits when nothing is new.
    wiki_build_interval_s: int = 86400  # 24h
```

- [ ] **Step 2: Add the nightly loop in the lifespan**

In `apps/seraphine/backend/seraphine/main.py`, logo após o bloco do `_memory_audit_loop` / `memory_audit_task = asyncio.create_task(...)` (~1073), adicione (espelha o padrão, capturando `store`, `llm`, `deepsearch_service`, `settings` do escopo):

```python
    wiki_build_task: asyncio.Task[None] | None = None
    async def _wiki_build_loop() -> None:
        from seraphine.wiki import builder as _wiki_builder
        interval = max(60, int(settings.wiki_build_interval_s))
        while True:
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
            try:
                result = await _wiki_builder.run_once(store, llm, deepsearch_service)
                if result.get("sources_ingested") or result.get("people_updated"):
                    logger.info(
                        "wiki build: %s sources, %s people",
                        result.get("sources_ingested", 0), result.get("people_updated", 0),
                    )
            except Exception:
                logger.exception("wiki build loop iteration failed")

    wiki_build_task = asyncio.create_task(_wiki_build_loop())
```

- [ ] **Step 3: Cancel it in the finally**

In `apps/seraphine/backend/seraphine/main.py`, no `finally` do lifespan, logo após o bloco que cancela `memory_audit_task` (~1224), adicione:

```python
        if wiki_build_task is not None:
            wiki_build_task.cancel()
            try:
                await wiki_build_task
            except (asyncio.CancelledError, Exception):
                pass
```

- [ ] **Step 4: Verify import + no regression**

Run: `uv run python -c "import seraphine.main"` (import OK).
Run: `uv run pytest tests/ -q`
Expected: sem NOVAS falhas vs baseline (rode com `git stash` pra comparar se necessário; failures pré-existentes de event-loop py3.13 / serviços não contam). O loop é exercitado no E2E manual (Task 10).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/config.py \
        apps/seraphine/backend/seraphine/main.py
git commit -m "feat(wiki): nightly build loop + wiki_build_interval_s config"
```

---

## Task 7: Attachment capture hook (`content.py`)

**Files:**
- Modify: `apps/seraphine/backend/seraphine/attachments/content.py` (dentro do loop de `attachments`, após `data, meta = loaded`)
- Test: `apps/seraphine/backend/tests/test_wiki_attachment_hook.py`

**Interfaces:**
- Consumes: `capture.capture_attachment(att_id, data, meta)` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_attachment_hook.py`:

```python
import asyncio

import seraphine.attachments.content as content
import seraphine.attachments.store as store


async def test_build_user_content_fires_capture(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path / "wiki"))
    captured = {}

    async def _fake_capture(att_id, data, meta):
        captured["id"] = att_id
        return f"attachments/{att_id}.md"

    monkeypatch.setattr(content, "capture_attachment", _fake_capture)
    meta = store.save_attachment(b"%PDF-1.4 x", filename="d.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "resume", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    await asyncio.sleep(0)  # let the fire-and-forget task run
    assert captured.get("id") == meta["id"]
    # content itself is unchanged (still produces the pdf part)
    assert any(p.get("type") == "pdf" for p in parts)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_attachment_hook.py -v`
Expected: FAIL — `AttributeError: module 'seraphine.attachments.content' has no attribute 'capture_attachment'` (name not imported yet).

- [ ] **Step 3: Write minimal implementation**

In `apps/seraphine/backend/seraphine/attachments/content.py`, adicione o import no topo (junto dos outros imports):

```python
import asyncio

from seraphine.wiki.capture import capture_attachment
```

(`asyncio` provavelmente já está importado — se sim, não duplique.)

Dentro de `build_user_content`, no loop `for att in attachments or []:`, logo após `data, meta = loaded` (a linha que desempacota o anexo carregado), adicione a captura fire-and-forget:

```python
        # Wiki capture (read-only side-channel): persist the source into raw/.
        # Fire-and-forget — never blocks or breaks the turn.
        try:
            asyncio.create_task(capture_attachment(str(att_id), data, meta))
        except Exception:
            pass
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_wiki_attachment_hook.py tests/test_attachments_content.py -v`
Expected: PASS (novo + os 6 de content continuam verdes).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/attachments/content.py \
        apps/seraphine/backend/tests/test_wiki_attachment_hook.py
git commit -m "feat(wiki): capture used attachments into raw/ (fire-and-forget hook)"
```

---

## Task 8: Frontend — api + types + dep

**Files:**
- Create: `apps/seraphine/frontend/src/wiki/types.ts`, `apps/seraphine/frontend/src/wiki/api.ts`
- Modify: `apps/seraphine/frontend/package.json` (add `react-force-graph-2d`)

**Interfaces:**
- Produces: `WikiIndexItem`, `WikiPage`, `WikiGraph` types; `listWikiIndex()`, `getWikiPage(slug)`, `getWikiGraph()`, `getWikiSource(ref)`.

- [ ] **Step 1: Add the graph dependency**

Run (from repo root): `pnpm --filter seraphine-web add react-force-graph-2d`
Expected: instala e adiciona a `apps/seraphine/frontend/package.json` deps.

- [ ] **Step 2: Create the types**

Create `apps/seraphine/frontend/src/wiki/types.ts`:

```ts
export interface WikiIndexItem {
  slug: string;
  title: string;
  summary: string;
  category: string;
  updated_at: string;
}

export interface WikiPage {
  slug: string;
  title: string;
  category: string;
  updated_at: string;
  sources: string[];
  links: string[];
  body: string;
  backlinks: { slug: string; title: string }[];
}

export interface WikiGraph {
  nodes: { id: string; title: string; category: string }[];
  edges: { source: string; target: string }[];
}
```

- [ ] **Step 3: Create the api**

Create `apps/seraphine/frontend/src/wiki/api.ts`:

```ts
import { API_BASE } from '../api';
import type { WikiGraph, WikiIndexItem, WikiPage } from './types';

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

export function listWikiIndex(): Promise<WikiIndexItem[]> {
  return request<WikiIndexItem[]>('/wiki/index');
}

export function getWikiPage(slug: string): Promise<WikiPage> {
  return request<WikiPage>(`/wiki/page/${encodeURIComponent(slug)}`);
}

export function getWikiGraph(): Promise<WikiGraph> {
  return request<WikiGraph>('/wiki/graph');
}

export function getWikiSource(ref: string): Promise<{ ref: string; content: string }> {
  return request<{ ref: string; content: string }>(`/wiki/source/${ref}`);
}
```

- [ ] **Step 4: Typecheck**

Run (from repo root): `pnpm --filter seraphine-web build`
Expected: build sem erro de tipos.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/wiki/types.ts \
        apps/seraphine/frontend/src/wiki/api.ts \
        apps/seraphine/frontend/package.json \
        pnpm-lock.yaml
git commit -m "feat(wiki-fe): api client + types + react-force-graph-2d dep"
```

---

## Task 9: Frontend — aba Wiki (viewer + grafo) + wiring

**Files:**
- Create: `apps/seraphine/frontend/src/wiki/WikiView.tsx`, `apps/seraphine/frontend/src/wiki/index.ts`, `apps/seraphine/frontend/src/wiki/obsidian.css`
- Modify: `apps/seraphine/frontend/src/stores/uiStore.ts` (union), `apps/seraphine/frontend/src/AppLayout.tsx` (navItem + render + import)

**Interfaces:**
- Consumes: `listWikiIndex`, `getWikiPage`, `getWikiGraph` (Task 8); `ForceGraph2D` from `react-force-graph-2d`.

- [ ] **Step 1: Create the view**

Create `apps/seraphine/frontend/src/wiki/obsidian.css`:

```css
/* Wiki view — reuses global tokens; scoped tweaks only. */
.wiki { display: flex; height: 100%; gap: var(--space-4, 12px); }
.wiki__graph { flex: 1; min-width: 0; border-right: 1px solid var(--border, #333); }
.wiki__panel { flex: 1; min-width: 0; overflow-y: auto; padding: var(--space-4, 12px); }
.wiki__empty { opacity: 0.6; padding: var(--space-4, 12px); }
.wiki__src { font-size: 12px; opacity: 0.7; margin-top: 12px; }
```

Create `apps/seraphine/frontend/src/wiki/WikiView.tsx`:

```tsx
import './obsidian.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';

import { getWikiGraph, getWikiPage, listWikiIndex } from './api';
import type { WikiGraph, WikiPage } from './types';

interface WikiViewProps { onBack: () => void; }

export function WikiView({ onBack }: WikiViewProps) {
  const [graph, setGraph] = useState<WikiGraph>({ nodes: [], edges: [] });
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 400, h: 400 });

  useEffect(() => {
    getWikiGraph().then(setGraph).catch((e) => setError(String(e)));
    listWikiIndex().then((items) => {
      if (items[0]) void openPage(items[0].slug);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function openPage(slug: string) {
    try { setPage(await getWikiPage(slug)); } catch (e) { setError(String(e)); }
  }

  // react-force-graph wants { nodes, links } with source/target.
  const graphData = useMemo(() => ({
    nodes: graph.nodes.map((n) => ({ id: n.id, name: n.title })),
    links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
  }), [graph]);

  return (
    <div className="wiki">
      <div className="wiki__graph" ref={wrapRef}>
        <ForceGraph2D
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          nodeLabel="name"
          onNodeClick={(n: { id?: string | number }) => { if (n.id) void openPage(String(n.id)); }}
        />
      </div>
      <div className="wiki__panel">
        <button type="button" onClick={onBack} className="btn-back">← Chat</button>
        {error && <div className="wiki__empty">{error}</div>}
        {!page && !error && <div className="wiki__empty">A wiki ainda está vazia — rode uma pesquisa ou anexe um PDF; ela é montada à noite.</div>}
        {page && (
          <article>
            <h1>{page.title}</h1>
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{page.body}</Markdown>
            {page.sources.length > 0 && (
              <div className="wiki__src">Fontes: {page.sources.join(', ')}</div>
            )}
            {page.backlinks.length > 0 && (
              <div className="wiki__src">
                Linkado por: {page.backlinks.map((b) => (
                  <a key={b.slug} href="#" onClick={(e) => { e.preventDefault(); void openPage(b.slug); }}>{b.title} </a>
                ))}
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
```

Create `apps/seraphine/frontend/src/wiki/index.ts`:

```ts
export { WikiView } from './WikiView';
```

- [ ] **Step 2: Wire the tab (uiStore + AppLayout)**

In `apps/seraphine/frontend/src/stores/uiStore.ts`, no union `ActiveView`, adicione `| 'wiki'` (ex.: logo após `| 'research'`).

In `apps/seraphine/frontend/src/AppLayout.tsx`:
- Import (topo, junto de `import { ResearchView } from './research';`): `import { WikiView } from './wiki';`
- No `navItems` (grupo "Conhecimento", junto da entrada `research` ~292), adicione:
  ```tsx
    { id: 'wiki', icon: <NotesIcon size={22} />, label: 'Wiki', group: 'Conhecimento', onClick: () => setActiveView(activeView === 'wiki' ? 'chat' : 'wiki'), active: activeView === 'wiki' },
  ```
  (Reusa `NotesIcon` já importado; se preferir outro ícone existente em `./icons/Icons`, use-o — sem emoji.)
- No bloco de render (junto do `{activeView === 'research' && (...)}` ~543), adicione:
  ```tsx
                {activeView === 'wiki' && (
                  <WikiView onBack={() => setActiveView('chat')} />
                )}
  ```

- [ ] **Step 3: Typecheck**

Run (from repo root): `pnpm --filter seraphine-web build`
Expected: build sem erro. (Se `react-force-graph-2d` reclamar de tipos do nó no `onNodeClick`, o cast `{ id?: string | number }` já cobre; ajuste o tipo do parâmetro conforme o erro do tsc, mantendo o comportamento.)

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/wiki/ \
        apps/seraphine/frontend/src/stores/uiStore.ts \
        apps/seraphine/frontend/src/AppLayout.tsx
git commit -m "feat(wiki-fe): Wiki tab — markdown viewer + force graph"
```

---

## Task 10: Verificação E2E manual

**Files:** nenhum.

- [ ] **Step 1: Suíte backend verde**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_wiki_*.py -v`
Expected: todos os testes do wiki verdes.

- [ ] **Step 2: Rodar um build manual**

Suba o backend local (cliproxy:8317 ativo). Num shell Python do backend, dispare `run_once` uma vez (ou reduza `SERAPHINE_WIKI_BUILD_INTERVAL_S=60` e espere), tendo pelo menos: 1 deepsearch `done` do dia + 1 anexo PDF usado numa conversa. Confira em `/data/wiki`: `raw/research/*.md`, `raw/attachments/*.md`, `wiki/*.md` (frontmatter + citações), `index.md`, `log.md`.

- [ ] **Step 3: Aba Wiki**

No app, abra a aba **Wiki**: o grafo deve renderizar os nós/arestas; clicar num nó abre a página; as fontes aparecem; backlinks navegam. Confirme que o markdown herda o visual (obsidian.css).

- [ ] **Step 4: Read-only sanity**

Confirme que o fact-store não mudou (a wiki só leu `facts`/`people`) e que apagar `/data/wiki` e rodar de novo reconstrói tudo do `raw/` + memória.

---

## Self-Review (cobertura do spec)

- **3 camadas + /data/wiki:** Task 1 (`files.py` dirs/frontmatter) + Task 2 (raw/). ✓
- **Fontes: deepsearch + anexos + facts/people:** Task 2 (export deepsearch, capture anexo) + Task 4 (person pages) + Task 7 (hook de anexo). ✓
- **Maintainer LLM controlado (JSON estruturado, código aplica):** Task 3 (`build_pages_from_source`/`_parse_page_ops`/`apply_page_ops`) + Task 4 (`run_once`). ✓
- **index.md + log.md + lint leve:** Task 1 (`write_index`/`append_log`) + Task 3 (`lint`) + Task 4 (chamadas). ✓
- **Watermark KV:** Task 4 (`run_once` + `wiki_last_ingest_at`). ✓
- **Cadência batch noturno:** Task 6 (loop + config). ✓
- **API /wiki:** Task 5. ✓
- **UI viewer + grafo (react-force-graph-2d), grupo Conhecimento:** Task 8 (dep/api) + Task 9 (view+wiring). ✓
- **Read-only (sem mutação de memória, sem retrieval no chat):** nenhuma task escreve em facts/people; hook é fire-and-forget só pro raw/. ✓
- **Traversal-safety:** Task 1 (slug/ref) + Task 5 (guards na API). ✓
- **Fora de escopo respeitado:** sem retrieval no chat, sem on-demand, sem contradição/dedup pesado, sem página de projeto, sem sync Obsidian real. ✓
