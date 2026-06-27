# Anexos (imagem + PDF) — avatar companion + chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir anexar imagem e PDF tanto no avatar companion quanto no chat, com upload-por-id, e o backend monta o conteúdo certo por provider (PDF/imagem nativo no Claude; fallback de extração de texto no OpenRouter/local).

**Architecture:** Endpoint HTTP de upload guarda o arquivo num staging store com TTL e devolve um `id`. A mensagem WS `user_message` carrega `attachments:[{id,...}]`. A engine, no único ponto onde monta o conteúdo do usuário, resolve o provider e busca os bytes pelo id: no Claude emite bloco nativo (`image_url` / novo part `pdf`→`document`); no OpenRouter/local pré-extrai texto (pdfplumber / Anthropic vision) e injeta como texto.

**Tech Stack:** Python (FastAPI, uv, pdfplumber, mod-vision), `packages/llm-adapters` (AnthropicClient), React+TypeScript (Vite, pnpm), Tauri.

## Global Constraints

- **Backend tests:** rodar de `apps/seraphine/backend` com `uv run pytest` (pytest `asyncio_mode = "auto"`, timeout 60s/test). Um teste: `uv run pytest tests/test_x.py::test_y -v`.
- **Provider gate (nativo vs fallback):** usar bloco nativo **somente** quando `settings.llm_backend in ("anthropic","claude_max")` **e** não há override OpenRouter na turn (`or_model is None`). Caso contrário, fallback de texto.
- **Caps:** imagem **10MB**, PDF **32MB**. Texto extraído de PDF capado em **30.000 chars**.
- **MIME aceitos:** `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/gif`.
- **Sem emoji em ícones:** usar SVG inline / `src/icons/Icons.tsx` (já existe `AttachIcon`).
- **Frontend HTTP:** sem header de auth; multipart via `FormData` passado direto como `body`, **sem** setar `Content-Type` (o browser põe o boundary). Base URL via `API_BASE` de `src/api.ts`.
- **Staging dir:** `Path(os.environ.get("SERAPHINE_DATA_DIR") or Path(settings.sqlite_path).parent) / "attachments"` (mesma convenção do cv_triage).
- **Imagem do chat permanece** no caminho `images[]` base64 atual; só PDF do chat e todos os anexos do avatar passam pelo pipeline novo.
- **Subagents (execução deste plano):** toda invocação de Agent passa `model: "opus"` (regra do projeto).

---

## Arquivos

**Backend (novos):**
- `apps/seraphine/backend/seraphine/attachments/__init__.py`
- `apps/seraphine/backend/seraphine/attachments/store.py` — persistência + validação + TTL cleanup.
- `apps/seraphine/backend/seraphine/attachments/content.py` — `build_user_content(...)` (montagem dos blocos por provider).
- `apps/seraphine/backend/seraphine/attachments/routes.py` — `POST /attachments`, `GET /attachments/{id}`.
- Tests: `tests/test_attachments_store.py`, `tests/test_attachments_routes.py`, `tests/test_attachments_content.py`.

**Backend (modificar):**
- `apps/seraphine/backend/pyproject.toml` — add dep `mod-vision`.
- `packages/llm-adapters/src/llm_adapters/anthropic.py` — branch `pdf`→`document` em `_convert_content_part`.
- `apps/seraphine/backend/seraphine/conversation/engine.py` — `handle_user_message` ganha `attachments`; resolve provider antes do build; chama `build_user_content`.
- `apps/seraphine/backend/seraphine/ws/routes.py` — parse `attachments`, passa pra engine.
- `apps/seraphine/backend/seraphine/main.py` — registra router + cron de housekeeping.
- Test: `tests/test_anthropic_client.py` (add caso).

**Frontend (novos):**
- `apps/seraphine/frontend/src/attachments/types.ts`
- `apps/seraphine/frontend/src/attachments/api.ts`
- `apps/seraphine/frontend/src/attachments/usePendingAttachments.ts`

**Frontend (modificar):**
- `apps/seraphine/frontend/src/ws/types.ts` — `attachments?` em `UserMessage`.
- `apps/seraphine/frontend/src/chat/ChatView.tsx` — PDF pelo pipeline novo.
- `apps/seraphine/frontend/src/avatar-companion/AvatarCompanion.tsx` — botão de anexo + chips + ride na voz.
- `apps/seraphine/frontend/src/realtime/RealtimeController.tsx` — thread `attachments` no send do realtime.

---

## Task 1: Staging store de anexos

**Files:**
- Create: `apps/seraphine/backend/seraphine/attachments/__init__.py`
- Create: `apps/seraphine/backend/seraphine/attachments/store.py`
- Test: `apps/seraphine/backend/tests/test_attachments_store.py`

**Interfaces:**
- Produces:
  - `kind_for_mime(mime: str) -> str` → `"pdf"|"image"`
  - `attachments_dir() -> pathlib.Path`
  - `save_attachment(data: bytes, *, filename: str, mime: str) -> dict` → `{id, kind, mime, filename, size}`
  - `load_attachment(att_id: str) -> tuple[bytes, dict] | None`
  - `validation_error(mime: str, size: int) -> tuple[int, str] | None`
  - `cleanup(*, ttl_hours: int = 24) -> int`
  - constants `ACCEPTED_MIMES: set[str]`, `MAX_PDF_BYTES`, `MAX_IMAGE_BYTES`

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_attachments_store.py`:

```python
import os

import seraphine.attachments.store as store


def test_kind_for_mime():
    assert store.kind_for_mime("application/pdf") == "pdf"
    assert store.kind_for_mime("image/png") == "image"


def test_save_and_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"%PDF-1.4 hi", filename="a.pdf", mime="application/pdf")
    assert meta["kind"] == "pdf"
    assert meta["mime"] == "application/pdf"
    assert meta["filename"] == "a.pdf"
    assert meta["size"] == len(b"%PDF-1.4 hi")
    loaded = store.load_attachment(meta["id"])
    assert loaded is not None
    data, meta2 = loaded
    assert data == b"%PDF-1.4 hi"
    assert meta2["id"] == meta["id"]


def test_load_rejects_bad_id(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    assert store.load_attachment("../etc/passwd") is None
    assert store.load_attachment("") is None
    assert store.load_attachment("nope") is None


def test_validation_error():
    assert store.validation_error("text/plain", 10) == (415, "unsupported media type")
    assert store.validation_error("application/pdf", store.MAX_PDF_BYTES + 1) == (413, "file too large")
    assert store.validation_error("image/png", store.MAX_IMAGE_BYTES + 1) == (413, "file too large")
    assert store.validation_error("image/png", 5) is None
    assert store.validation_error("application/pdf", 5) is None


def test_cleanup_removes_old(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"x", filename="a.png", mime="image/png")
    d = store.attachments_dir()
    for p in d.glob(f"{meta['id']}*"):
        os.utime(p, (1.0, 1.0))  # epoch — way past any TTL
    removed = store.cleanup(ttl_hours=24)
    assert removed >= 1
    assert store.load_attachment(meta["id"]) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_attachments_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.attachments'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/attachments/__init__.py` (empty file).

Create `apps/seraphine/backend/seraphine/attachments/store.py`:

```python
"""Ephemeral staging store for user-uploaded attachments (image/PDF).

Bytes are written under <data_dir>/attachments/<id> with a sibling
<id>.meta.json. A daily housekeeping job (see main.py) reclaims files
past their TTL. Mirrors the cv_triage staging convention.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from seraphine.config import settings

ACCEPTED_MIMES: set[str] = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def kind_for_mime(mime: str) -> str:
    return "pdf" if mime == "application/pdf" else "image"


def validation_error(mime: str, size: int) -> tuple[int, str] | None:
    """Return ``(status, detail)`` if invalid, else ``None``."""
    if mime not in ACCEPTED_MIMES:
        return (415, "unsupported media type")
    cap = MAX_PDF_BYTES if mime == "application/pdf" else MAX_IMAGE_BYTES
    if size > cap:
        return (413, "file too large")
    return None


def attachments_dir() -> Path:
    base = os.environ.get("SERAPHINE_DATA_DIR")
    root = Path(base) if base else Path(settings.sqlite_path).parent
    d = root / "attachments"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_attachment(data: bytes, *, filename: str, mime: str) -> dict[str, Any]:
    att_id = uuid.uuid4().hex
    d = attachments_dir()
    (d / att_id).write_bytes(data)
    meta = {
        "id": att_id,
        "kind": kind_for_mime(mime),
        "mime": mime,
        "filename": filename,
        "size": len(data),
    }
    (d / f"{att_id}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


def _safe_id(att_id: str) -> bool:
    # uuid4().hex is 32 lowercase hex chars; keep this strict to block traversal.
    return bool(att_id) and att_id.isalnum() and len(att_id) <= 64


def load_attachment(att_id: str) -> tuple[bytes, dict[str, Any]] | None:
    if not _safe_id(att_id):
        return None
    d = attachments_dir()
    f = d / att_id
    m = d / f"{att_id}.meta.json"
    if not f.is_file() or not m.is_file():
        return None
    try:
        data = f.read_bytes()
        meta = json.loads(m.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data, meta


def cleanup(*, ttl_hours: int = 24) -> int:
    """Delete staged files older than the TTL (by mtime). Returns count removed."""
    d = attachments_dir()
    cutoff = time.time() - ttl_hours * 3600
    removed = 0
    for p in d.glob("*"):
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except Exception:
            pass
    return removed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_attachments_store.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/attachments/__init__.py \
        apps/seraphine/backend/seraphine/attachments/store.py \
        apps/seraphine/backend/tests/test_attachments_store.py
git commit -m "feat(attachments): staging store for image/PDF uploads with TTL"
```

---

## Task 2: Endpoint de upload + preview + wiring (router + cron)

**Files:**
- Create: `apps/seraphine/backend/seraphine/attachments/routes.py`
- Modify: `apps/seraphine/backend/seraphine/main.py` (include_router ~linha 1276; cron ~linha 1166)
- Test: `apps/seraphine/backend/tests/test_attachments_routes.py`

**Interfaces:**
- Consumes: `store.validation_error`, `store.save_attachment`, `store.load_attachment`, `store.attachments_dir`, `store.cleanup` (Task 1).
- Produces: `router` (`APIRouter(prefix="/attachments")`) with `POST ""` → `{id,kind,mime,filename,size}` and `GET "/{att_id}"` → FileResponse.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_attachments_routes.py` (monta um app mínimo só com o router — evita bootar o lifespan inteiro, que trava sem cliproxy):

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.attachments.routes import router


def _client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_upload_pdf_returns_meta(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    resp = c.post("/attachments", files={"file": ("a.pdf", b"%PDF-1.4 x", "application/pdf")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "pdf"
    assert body["mime"] == "application/pdf"
    assert body["id"]


def test_upload_rejects_bad_mime(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    resp = c.post("/attachments", files={"file": ("a.txt", b"hi", "text/plain")})
    assert resp.status_code == 415


def test_upload_rejects_empty(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    resp = c.post("/attachments", files={"file": ("a.png", b"", "image/png")})
    assert resp.status_code == 400


def test_get_preview(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    up = c.post("/attachments", files={"file": ("a.png", b"\x89PNG", "image/png")}).json()
    resp = c.get(f"/attachments/{up['id']}")
    assert resp.status_code == 200
    assert resp.content == b"\x89PNG"


def test_get_missing_is_404(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.get("/attachments/deadbeef").status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_attachments_routes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.attachments.routes'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/attachments/routes.py`:

```python
"""Upload + preview endpoints for staged attachments (image/PDF)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from seraphine.attachments import store

router = APIRouter(prefix="/attachments", tags=["attachments"])


@router.post("")
async def upload_attachment(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    mime = file.content_type or ""
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    verr = store.validation_error(mime, len(data))
    if verr is not None:
        raise HTTPException(status_code=verr[0], detail=verr[1])
    return store.save_attachment(data, filename=file.filename or "anexo", mime=mime)


@router.get("/{att_id}")
async def get_attachment(att_id: str) -> Any:
    loaded = store.load_attachment(att_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="not found")
    _data, meta = loaded
    path = store.attachments_dir() / att_id
    return FileResponse(str(path), media_type=meta["mime"], filename=meta["filename"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_attachments_routes.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the router into the app**

In `apps/seraphine/backend/seraphine/main.py`, na região dos `app.include_router(...)` (logo após a linha `app.include_router(images_router)`, ~1276), adicione o import lazy + o include:

```python
    from seraphine.attachments.routes import router as attachments_router
    app.include_router(attachments_router)
```

- [ ] **Step 6: Register the daily housekeeping cron**

In `apps/seraphine/backend/seraphine/main.py`, logo após o bloco que registra `freshness_archive` (~linha 1166), adicione (mesmo padrão do `cv_triage_housekeeping`):

```python
    # Anexos: TTL cleanup diário do staging store.
    try:
        if proactive_scheduler is not None and proactive_scheduler.enabled:
            from seraphine.attachments.store import cleanup as _attachments_cleanup

            def _attachments_housekeeping_tick() -> int:
                return _attachments_cleanup(ttl_hours=24)

            proactive_scheduler._sched.add_job(
                _attachments_housekeeping_tick,
                "cron", hour=4, minute=45,
                id="attachments_housekeeping",
                name="attachments_housekeeping",
            )
            logger.info("attachments housekeeping cron registered (04:45 daily)")
    except Exception:
        logger.exception("attachments housekeeping registration failed")
```

- [ ] **Step 7: Verify the suite still passes**

Run: `uv run pytest tests/test_attachments_routes.py -v`
Expected: PASS. (O wiring do main.py é exercitado em manual/E2E; não quebra os testes do módulo.)

- [ ] **Step 8: Commit**

```bash
git add apps/seraphine/backend/seraphine/attachments/routes.py \
        apps/seraphine/backend/seraphine/main.py \
        apps/seraphine/backend/tests/test_attachments_routes.py
git commit -m "feat(attachments): upload/preview routes + router wiring + TTL cron"
```

---

## Task 3: Adapter — bloco `document` nativo (PDF)

**Files:**
- Modify: `packages/llm-adapters/src/llm_adapters/anthropic.py:66-108` (`_convert_content_part`)
- Test: `apps/seraphine/backend/tests/test_anthropic_client.py` (add caso)

**Interfaces:**
- Produces: `_convert_content_part({"type":"pdf","data_url":"data:application/pdf;base64,..."})` → `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"..."}}`.

- [ ] **Step 1: Write the failing test**

Add to `apps/seraphine/backend/tests/test_anthropic_client.py`:

```python
def test_convert_pdf_part_to_document_block():
    from llm_adapters.anthropic import _convert_content_part

    part = {"type": "pdf", "data_url": "data:application/pdf;base64,QUJD"}
    out = _convert_content_part(part)
    assert out == {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": "QUJD"},
    }


def test_convert_pdf_part_without_dataurl_is_empty_data():
    from llm_adapters.anthropic import _convert_content_part

    out = _convert_content_part({"type": "pdf", "data_url": "garbage"})
    assert out["type"] == "document"
    assert out["source"]["data"] == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_anthropic_client.py::test_convert_pdf_part_to_document_block -v`
Expected: FAIL — retorna o fallback `{"type":"text","text": json.dumps(part)}` (não é `document`).

- [ ] **Step 3: Write minimal implementation**

In `packages/llm-adapters/src/llm_adapters/anthropic.py`, dentro de `_convert_content_part`, adicione o branch logo **após** o `if ptype == "image": return part` (antes do `if ptype == "image_url"`):

```python
    if ptype in ("pdf", "document"):
        url = part.get("data_url") or part.get("url") or ""
        data = ""
        if isinstance(url, str) and url.startswith("data:"):
            try:
                _header, data = url.split(",", 1)
            except ValueError:
                data = ""
        return {
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": data,
            },
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_anthropic_client.py -v`
Expected: PASS (incl. os 2 novos e os existentes).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-adapters/src/llm_adapters/anthropic.py \
        apps/seraphine/backend/tests/test_anthropic_client.py
git commit -m "feat(llm-adapters): emit Anthropic document block for pdf content parts"
```

> Nota de implementação: blocos `document` base64 são GA na API da Anthropic — o header `anthropic-beta` atual (`anthropic.py:294-298`) não precisa mudar. Se o endpoint cliproxy rejeitar o bloco em runtime, o caminho de fallback de texto (Task 4) cobre; nesse caso, adicionar `pdfs-2024-09-25` ao header é a correção. Validar no E2E manual (Task 10).

---

## Task 4: Content builder (nativo vs fallback) + dep mod-vision

**Files:**
- Modify: `apps/seraphine/backend/pyproject.toml` (add `mod-vision`)
- Create: `apps/seraphine/backend/seraphine/attachments/content.py`
- Test: `apps/seraphine/backend/tests/test_attachments_content.py`

**Interfaces:**
- Consumes: `store.load_attachment` (Task 1); `mod_vision.extract_pdf_text`, `mod_vision.describe_image`.
- Produces:
  `async build_user_content(content: str, *, images: list[str] | None, attachments: list[dict] | None, use_native: bool, vision_llm: Any | None) -> str | list[dict]`
  - Sem anexos/imagens → retorna `content` (str).
  - Com extras → retorna `[{"type":"text","text":content}, ...partes...]`.
  - Imagem nativa → `{"type":"image_url","image_url":{"url":"data:<mime>;base64,..."}}`.
  - PDF nativo → `{"type":"pdf","data_url":"data:application/pdf;base64,..."}`.
  - PDF fallback → `{"type":"text","text":"[conteúdo do PDF ...]\n<texto>\n[fim do PDF]"}`.
  - Imagem fallback → `describe_image(vision_llm)` como texto, ou placeholder se `vision_llm is None`.

- [ ] **Step 1: Add the mod-vision dependency**

In `apps/seraphine/backend/pyproject.toml`, em `[project].dependencies` adicione `"mod-vision"` à lista (junto de `llm-adapters`, `core-db`, etc.), e em `[tool.uv.sources]` adicione:

```toml
mod-vision = { workspace = true }
```

Then run (from `apps/seraphine/backend`): `uv sync`
Expected: resolve sem erro; `mod-vision` instalado do workspace.

- [ ] **Step 2: Write the failing test**

Create `apps/seraphine/backend/tests/test_attachments_content.py`:

```python
import seraphine.attachments.content as content
import seraphine.attachments.store as store


async def test_no_attachments_returns_str():
    out = await content.build_user_content(
        "oi", images=None, attachments=None, use_native=True, vision_llm=None,
    )
    assert out == "oi"


async def test_native_pdf_makes_pdf_part(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"%PDF-1.4 hi", filename="x.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "resume", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    assert isinstance(parts, list)
    assert parts[0] == {"type": "text", "text": "resume"}
    pdfs = [p for p in parts if p.get("type") == "pdf"]
    assert len(pdfs) == 1
    assert pdfs[0]["data_url"].startswith("data:application/pdf;base64,")


async def test_native_image_makes_image_url(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"\x89PNG", filename="x.png", mime="image/png")
    parts = await content.build_user_content(
        "o que e", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    imgs = [p for p in parts if p.get("type") == "image_url"]
    assert len(imgs) == 1
    assert imgs[0]["image_url"]["url"].startswith("data:image/png;base64,")


async def test_fallback_pdf_extracts_text(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(content, "extract_pdf_text", lambda data, **k: "TEXTO_EXTRAIDO")
    meta = store.save_attachment(b"whatever", filename="x.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "oi", images=None, attachments=[{"id": meta["id"]}],
        use_native=False, vision_llm=None,
    )
    joined = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    assert "TEXTO_EXTRAIDO" in joined


async def test_fallback_image_without_vision_llm_is_placeholder(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"\x89PNG", filename="x.png", mime="image/png")
    parts = await content.build_user_content(
        "oi", images=None, attachments=[{"id": meta["id"]}],
        use_native=False, vision_llm=None,
    )
    joined = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    assert "vis" in joined.lower()  # "visão indisponível"


async def test_legacy_images_passthrough():
    parts = await content.build_user_content(
        "x", images=["data:image/png;base64,AAAA"], attachments=None,
        use_native=True, vision_llm=None,
    )
    imgs = [p for p in parts if p.get("type") == "image_url"]
    assert imgs[0]["image_url"]["url"] == "data:image/png;base64,AAAA"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_attachments_content.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'seraphine.attachments.content'`.

- [ ] **Step 4: Write minimal implementation**

Create `apps/seraphine/backend/seraphine/attachments/content.py`:

```python
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_attachments_content.py -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/pyproject.toml \
        apps/seraphine/backend/uv.lock \
        apps/seraphine/backend/seraphine/attachments/content.py \
        apps/seraphine/backend/tests/test_attachments_content.py
git commit -m "feat(attachments): provider-aware content builder (native vs text fallback)"
```

---

## Task 5: Engine — `handle_user_message` aceita `attachments`

**Files:**
- Modify: `apps/seraphine/backend/seraphine/conversation/engine.py` (assinatura ~811; resolve ~1061; build block ~1029)

**Interfaces:**
- Consumes: `build_user_content` (Task 4), `self._resolve_chat_llm`, `self.llm`, `_current_user_images`, `ChatMessage`.
- Produces: `handle_user_message(conversation_id, content, *, think=False, images=None, attachments=None, cancel_event=None)`.

- [ ] **Step 1: Add `attachments` to the signature**

In `apps/seraphine/backend/seraphine/conversation/engine.py`, troque a assinatura (em `engine.py:811-819`):

```python
    async def handle_user_message(
        self,
        conversation_id: str | None,
        content: str,
        *,
        think: bool = False,
        images: list[str] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[StreamEvent]:
```

por:

```python
    async def handle_user_message(
        self,
        conversation_id: str | None,
        content: str,
        *,
        think: bool = False,
        images: list[str] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[StreamEvent]:
```

- [ ] **Step 2: Resolve o provider antes do build e troque o build block**

Encontre o bloco de build atual (`engine.py:1029-1042`):

```python
        if images:
            parts: list[dict[str, Any]] = [{"type": "text", "text": content}]
            for img_url in images:
                parts.append({"type": "image_url", "image_url": {"url": img_url}})
            msg_content = parts
        else:
            msg_content = content
        messages.append(ChatMessage(role="user", content=msg_content))

        # Expose images to opt-in tools for this turn (ContextVar)
        _images_token = _current_user_images.set(list(images or []))
```

Substitua por:

```python
        from seraphine.config import settings as _prov_settings
        from seraphine.attachments.content import build_user_content

        # Resolve o provider UMA vez, antes de montar o conteúdo, pra decidir
        # bloco nativo (Claude) vs fallback de texto (OpenRouter/local).
        chat_llm, or_model = await self._resolve_chat_llm()
        use_native = (or_model is None) and (
            _prov_settings.llm_backend in ("anthropic", "claude_max")
        )
        vision_llm = self.llm if hasattr(self.llm, "_client") else None

        msg_content = await build_user_content(
            content,
            images=images,
            attachments=attachments,
            use_native=use_native,
            vision_llm=vision_llm,
        )
        messages.append(ChatMessage(role="user", content=msg_content))

        # Expose images to opt-in tools for this turn (ContextVar).
        # v1: só imagens legadas do chat alimentam tools consumidoras; anexos
        # por id ainda não (fora de escopo).
        _images_token = _current_user_images.set(list(images or []))
```

- [ ] **Step 3: Remova o resolve duplicado**

Mais abaixo (`engine.py:1061`), o resolve já roda novamente. Apague a linha duplicada:

```python
        chat_llm, or_model = await self._resolve_chat_llm()
```

(Mantenha tudo ao redor — o `active_stream`, o comentário e o bloco do cost-guard logo abaixo continuam. `chat_llm`/`or_model` agora vêm do Step 2.)

- [ ] **Step 4: Run the engine + full suite to check for regressions**

Run: `uv run pytest tests/ -q`
Expected: PASS (sem regressão; `tests/test_engine_*.py` continuam verdes). O comportamento novo é coberto pelos units de `build_user_content` (Task 4) e pelo E2E manual (Task 10).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/conversation/engine.py
git commit -m "feat(engine): handle_user_message accepts attachments; provider-aware content build"
```

---

## Task 6: WS — parse `attachments` e repassa pra engine

**Files:**
- Modify: `apps/seraphine/backend/seraphine/ws/routes.py:767` (parse) e `:894-902` (call)

**Interfaces:**
- Consumes: `engine.handle_user_message(..., attachments=...)` (Task 5).

- [ ] **Step 1: Parse o campo**

In `apps/seraphine/backend/seraphine/ws/routes.py`, no bloco `user_message` (`:767-774`), logo após `images = payload.get("images") or None`, adicione:

```python
                attachments = payload.get("attachments") or None
```

- [ ] **Step 2: Passe pra engine**

In the same file (`:894-902`), no `_drive_turn`, troque a chamada:

```python
                    async for event in engine.handle_user_message(
                        conv_id,
                        content,
                        think=think,
                        images=images,
                        cancel_event=turn_cancel_event,
                    ):
```

por:

```python
                    async for event in engine.handle_user_message(
                        conv_id,
                        content,
                        think=think,
                        images=images,
                        attachments=attachments,
                        cancel_event=turn_cancel_event,
                    ):
```

- [ ] **Step 3: Regression check**

Run: `uv run pytest tests/test_ws_user_message.py -v`
Expected: PASS (o `user_message` sem `attachments` continua funcionando — `payload.get("attachments")` → `None`).

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/backend/seraphine/ws/routes.py
git commit -m "feat(ws): forward user_message attachments to the engine"
```

---

## Task 7: Frontend — API de upload + hook + tipo

**Files:**
- Create: `apps/seraphine/frontend/src/attachments/types.ts`
- Create: `apps/seraphine/frontend/src/attachments/api.ts`
- Create: `apps/seraphine/frontend/src/attachments/usePendingAttachments.ts`
- Modify: `apps/seraphine/frontend/src/ws/types.ts:24-33`

**Interfaces:**
- Produces:
  - `AttachmentRef = { id: string; kind: 'pdf'|'image'; mime: string; filename: string; size: number }`
  - `uploadAttachment(file: File): Promise<AttachmentRef>`
  - `usePendingAttachments()` → `{ pending: AttachmentRef[]; add(file: File): Promise<AttachmentRef|null>; remove(id: string): void; clear(): void }`
  - `UserMessage.attachments?: { id: string; kind: string; mime: string; filename: string }[]`

- [ ] **Step 1: Create the types**

Create `apps/seraphine/frontend/src/attachments/types.ts`:

```ts
export interface AttachmentRef {
  id: string;
  kind: 'pdf' | 'image';
  mime: string;
  filename: string;
  size: number;
}
```

- [ ] **Step 2: Create the upload API**

Create `apps/seraphine/frontend/src/attachments/api.ts`:

```ts
import { API_BASE } from '../api';
import type { AttachmentRef } from './types';

/** Upload a file to the staging store; returns its reference (id + meta). */
export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  // Multipart — let the browser set Content-Type with the boundary.
  const res = await fetch(`${API_BASE}/attachments`, { method: 'POST', body: fd });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as AttachmentRef;
}
```

- [ ] **Step 3: Create the hook**

Create `apps/seraphine/frontend/src/attachments/usePendingAttachments.ts`:

```ts
import { useCallback, useState } from 'react';

import { uploadAttachment } from './api';
import type { AttachmentRef } from './types';

/** Stage uploaded attachments until the next message is sent. */
export function usePendingAttachments() {
  const [pending, setPending] = useState<AttachmentRef[]>([]);

  const add = useCallback(async (file: File): Promise<AttachmentRef | null> => {
    try {
      const ref = await uploadAttachment(file);
      setPending((prev) => [...prev, ref]);
      return ref;
    } catch (e) {
      console.error('attachment upload failed', e);
      return null;
    }
  }, []);

  const remove = useCallback((id: string) => {
    setPending((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => setPending([]), []);

  return { pending, add, remove, clear };
}
```

- [ ] **Step 4: Add `attachments` to UserMessage**

In `apps/seraphine/frontend/src/ws/types.ts`, dentro de `interface UserMessage` (`:24-33`), adicione antes do `}`:

```ts
  /** Staged attachments (image/PDF) referenced by id; resolved server-side. */
  attachments?: { id: string; kind: string; mime: string; filename: string }[];
```

- [ ] **Step 5: Typecheck**

Run (from repo root): `pnpm -C apps/seraphine/frontend build`
Expected: build conclui sem erro de tipos (Vite roda `tsc`).

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src/attachments/ apps/seraphine/frontend/src/ws/types.ts
git commit -m "feat(frontend): attachment upload api + usePendingAttachments hook + UserMessage type"
```

---

## Task 8: Frontend — PDF no chat (`ChatView`)

**Files:**
- Modify: `apps/seraphine/frontend/src/chat/ChatView.tsx`

**Interfaces:**
- Consumes: `usePendingAttachments` (Task 7); inclui `attachments` no payload `user_message`.

- [ ] **Step 1: Importe o hook e instancie**

In `apps/seraphine/frontend/src/chat/ChatView.tsx`, adicione o import (junto dos demais imports do topo):

```ts
import { usePendingAttachments } from '../attachments/usePendingAttachments';
```

E dentro do componente, junto da declaração de `pendingImages` (`:410`):

```ts
  const attach = usePendingAttachments();
```

- [ ] **Step 2: Aceite PDF no input e roteie**

Troque o `accept` do file input (`:1477`) de `accept="image/*"` para:

```tsx
              accept="image/*,application/pdf"
```

Em `handleFilesSelected` (`:942-956`), dentro do `forEach`, roteie PDF pro hook e imagem pro caminho atual:

```ts
    Array.from(files).forEach((file) => {
      if (file.type === 'application/pdf') {
        void attach.add(file);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setPendingImages((prev) => [...prev, { name: file.name, dataUrl: reader.result as string }]);
        }
      };
      reader.readAsDataURL(file);
    });
```

No `handleDrop` (`:1017-1037`), troque o branch do PDF (que hoje injeta o hint de texto) por upload:

```ts
      } else if (file.type === 'application/pdf') {
        void attach.add(file);
      }
```

- [ ] **Step 3: Inclua `attachments` no envio e limpe**

Na função `send()` (`:918-932`), logo após calcular `images`, monte os anexos e inclua no payload:

```ts
    const atts = attach.pending.length > 0
      ? attach.pending.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, filename: a.filename }))
      : undefined;
    ws.send({
      type: 'user_message',
      conversation_id: conversationIdRef.current,
      content: content || '',
      speak,
      think,
      ...(images ? { images } : {}),
      ...(atts ? { attachments: atts } : {}),
    });
```

E logo após `setPendingImages([])` (`:932`), adicione:

```ts
    attach.clear();
```

Atualize `canSend` (`:913`) pra também habilitar quando houver PDF pendente:

```ts
    const canSend = (draft.trim().length > 0 || pendingImages.length > 0 || attach.pending.length > 0) && connected && !isStreaming;
```

- [ ] **Step 4: Chips de PDF pendente**

Logo após o bloco do `image-preview-strip` (`:1383-1401`), adicione uma faixa de chips pros PDFs (reusa os tokens de tema):

```tsx
      {attach.pending.length > 0 && (
        <div className="image-preview-strip">
          {attach.pending.map((a) => (
            <div key={a.id} className="image-preview">
              <span className="image-preview__badge">PDF</span>
              <span className="image-preview__name">{a.filename}</span>
              <button
                type="button"
                className="image-preview__remove"
                onClick={() => attach.remove(a.id)}
                aria-label={`Remover ${a.filename}`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm -C apps/seraphine/frontend build`
Expected: build sem erro.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src/chat/ChatView.tsx
git commit -m "feat(chat): attach PDFs via the staged attachment pipeline"
```

---

## Task 9: Frontend — anexo no avatar companion (botão + chips + ride na voz)

**Files:**
- Modify: `apps/seraphine/frontend/src/avatar-companion/AvatarCompanion.tsx`
- Modify: `apps/seraphine/frontend/src/realtime/RealtimeController.tsx`

**Interfaces:**
- Consumes: `usePendingAttachments` (Task 7).

- [ ] **Step 1: Hook + ref + import**

In `apps/seraphine/frontend/src/avatar-companion/AvatarCompanion.tsx`, adicione os imports:

```ts
import { useRef } from 'react'; // se ainda não importado
import { usePendingAttachments } from '../attachments/usePendingAttachments';
import { AttachIcon } from '../icons/Icons';
import type { AttachmentRef } from '../attachments/types';
```

Dentro do componente (junto dos refs/estados do topo, ~`:46-68`):

```ts
  const attach = usePendingAttachments();
  const pendingAttachmentsRef = useRef<AttachmentRef[]>([]);
  const attachFileInputRef = useRef<HTMLInputElement>(null);
```

E mantenha o ref sincronizado com o estado (logo após a linha do hook, via efeito):

```ts
  useEffect(() => {
    pendingAttachmentsRef.current = attach.pending;
  }, [attach.pending]);
```

- [ ] **Step 2: Helper de payload de anexos**

Adicione, dentro do componente, um helper que lê o ref (pros sends que rodam fora do render):

```ts
  const attachmentsPayload = () => {
    const list = pendingAttachmentsRef.current;
    if (!list.length) return undefined;
    return list.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, filename: a.filename }));
  };
```

- [ ] **Step 3: Injete nos sends de voz (push-to-talk)**

No `stopTalk`, no send do transcript (`:403-409`), inclua os anexos e limpe:

```ts
      const atts = attachmentsPayload();
      ws.send({
        type: 'user_message',
        conversation_id: conversationIdRef.current,
        content: text,
        speak: true,
        think,
        ...(atts ? { attachments: atts } : {}),
      } as never);
      if (atts) attach.clear();
```

- [ ] **Step 4: Upgrade o drag-drop Tauri pra subir o arquivo**

Troque o handler de drag-drop (`:486-514`) pra ler os bytes e subir via `/attachments` (em vez de mandar um texto com o caminho):

```ts
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
        const paths = event.payload?.paths || [];
        if (paths.length === 0) return;
        const first = paths[0];
        const ext = first.split('.').pop()?.toLowerCase() || '';
        const mime =
          ext === 'pdf' ? 'application/pdf'
          : ext === 'png' ? 'image/png'
          : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
          : ext === 'webp' ? 'image/webp'
          : ext === 'gif' ? 'image/gif'
          : '';
        if (!mime) {
          bubbles.push({ text: 'tipo de arquivo não suportado', priority: 'normal', durationMs: 4000 });
          return;
        }
        try {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          const bytes = await readFile(first);
          const name = first.split('/').pop() || 'anexo';
          const file = new File([bytes as BlobPart], name, { type: mime });
          const ref = await attach.add(file);
          if (ref) {
            bubbles.push({ text: `anexei: ${name} — manda a pergunta`, priority: 'normal', durationMs: 4000 });
          }
        } catch (e) {
          console.error('drag-drop upload failed', e);
          bubbles.push({ text: 'falhou ao ler o arquivo', priority: 'normal', durationMs: 4000 });
        }
      }).then((fn) => { unlisten = fn; });
    }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);
```

- [ ] **Step 5: Botão de anexo + input + chips no composer**

No composer (a flex row de botões em `:624-726`), adicione um 4º `<button>` (mesmo padrão inline 44px) + um input escondido. Antes do fechamento da row, adicione:

```tsx
        <input
          ref={attachFileInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void attach.add(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => attachFileInputRef.current?.click()}
          title="Anexar imagem ou PDF"
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'rgba(17, 17, 26, 0.75)',
            border: '1px solid rgba(255,255,255,0.15)',
            color: '#c4b5fd',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            boxShadow: '0 4px 10px rgba(0, 0, 0, 0.3)',
            transition: 'all 150ms',
          }}
        >
          <AttachIcon size={18} />
        </button>
```

Adicione a faixa de chips dos anexos pendentes (acima da row de botões — novo `<div>` irmão, antes da row em `:624`):

```tsx
      {attach.pending.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: 70,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 8,
          zIndex: 15,
          maxWidth: '90%',
          flexWrap: 'wrap',
        }}>
          {attach.pending.map((a) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', borderRadius: 8,
              background: 'rgba(17,17,26,0.85)', color: '#c4b5fd',
              fontSize: 12, border: '1px solid rgba(255,255,255,0.15)',
            }}>
              <span>{a.kind === 'pdf' ? 'PDF' : 'IMG'}</span>
              <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
              <button
                onClick={() => attach.remove(a.id)}
                aria-label={`Remover ${a.filename}`}
                style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 6: Ride no realtime (conversa contínua)**

In `apps/seraphine/frontend/src/realtime/RealtimeController.tsx`, adicione uma prop opcional `attachmentsPayload?: () => Array<{id:string;kind:string;mime:string;filename:string}> | undefined` na interface de props, e no send do transcript (`:309-314`) inclua:

```ts
        const atts = attachmentsPayload?.();
        socket.send({
          type: 'user_message',
          conversation_id,
          content: text,
          speak: true,
          ...(atts ? { attachments: atts } : {}),
        } as never);
        if (atts) onAttachmentsConsumed?.();
```

Adicione também a prop `onAttachmentsConsumed?: () => void`. Em `AvatarCompanion.tsx`, ao renderizar `<RealtimeController ... />` (`:730-738`), passe:

```tsx
        attachmentsPayload={attachmentsPayload}
        onAttachmentsConsumed={() => attach.clear()}
```

- [ ] **Step 7: Typecheck**

Run: `pnpm -C apps/seraphine/frontend build`
Expected: build sem erro.

> Se `@tauri-apps/plugin-fs` não estiver instalado, adicione: `pnpm -C apps/seraphine/frontend add @tauri-apps/plugin-fs` e registre o plugin no `src-tauri` conforme a doc do Tauri (o `readFile` precisa da permission `fs:allow-read-file`). Confirme no build.

- [ ] **Step 8: Commit**

```bash
git add apps/seraphine/frontend/src/avatar-companion/AvatarCompanion.tsx \
        apps/seraphine/frontend/src/realtime/RealtimeController.tsx
git commit -m "feat(avatar): attach image/PDF (button + drag-drop) staged onto next voice/realtime turn"
```

---

## Task 10: Verificação E2E manual

**Files:** nenhum (validação).

- [ ] **Step 1: Subir o backend local**

Run (from `apps/seraphine/backend`): `uv run pytest tests/ -q`
Expected: suíte verde. Depois suba o serviço local conforme o README (`scripts/`), com cliproxy:8317 ativo.

- [ ] **Step 2: Chat — PDF nativo**

No chat, anexar um PDF (com camada de texto) e pedir "resume". Verificar que o Claude responde com base no conteúdo (não um hint). Verificar nos logs/rede que o `user_message` carregou `attachments:[{id,...}]` e o backend montou um part `pdf`→`document`.

- [ ] **Step 3: Chat — PDF escaneado (nativo)**

Anexar um PDF **escaneado** (sem camada de texto). No Claude/cliproxy (nativo), o Claude deve conseguir ler (renderiza a página). Confirma a vantagem do bloco nativo vs pdfplumber.

- [ ] **Step 4: Avatar — PDF + voz**

No avatar (Tauri), soltar/anexar um PDF e **falar** "resume isso". Confirmar que o anexo grudou na turn de voz transcrita e o avatar respondeu falando sobre o PDF. Repetir com imagem ("o que você vê?").

- [ ] **Step 5: Fallback OpenRouter (opcional)**

Setar `chat_model=openrouter:<modelo>` com key configurada e repetir o PDF do chat. Verificar que o backend pré-extraiu texto (part de texto `[conteúdo do PDF ...]`) em vez de bloco nativo, e que a resposta saiu.

- [ ] **Step 6: Se o cliproxy rejeitar o document block**

Se o Step 2 falhar com erro do bloco `document`, adicionar `pdfs-2024-09-25` ao header `anthropic-beta` em `packages/llm-adapters/src/llm_adapters/anthropic.py:294-298`, reiniciar e revalidar. Commitar a correção se necessária.

- [ ] **Step 7: Commit (se houve ajuste do Step 6)**

```bash
git add packages/llm-adapters/src/llm_adapters/anthropic.py
git commit -m "fix(llm-adapters): add pdfs beta header for native PDF via cliproxy"
```

---

## Self-Review (cobertura do spec)

- **Escopo (pipeline compartilhado):** backend único (Tasks 4-6) + dois entrypoints de UI (Tasks 8-9). ✓
- **PDF híbrido (nativo + fallback):** Task 3 (document block) + Task 4 (`use_native` vs `extract_pdf_text`). ✓
- **Transporte upload+id:** Tasks 1-2 (store + `/attachments`) + Task 7 (upload front). ✓
- **Imagem do chat fica no caminho legado:** Task 8 roteia só PDF; imagem segue `images[]`. ✓
- **Provider gate:** Task 5 (`settings.llm_backend in (...)` e `or_model is None`). ✓
- **mod_vision (fallback):** Task 4 (dep + `extract_pdf_text`/`describe_image`). ✓
- **Efemeridade/TTL:** Task 1 (`cleanup`) + Task 2 (cron). ✓
- **Erros/limites (415/413/400; PDF escaneado; fallback texto):** Tasks 1-2 (validation) + Task 4 (placeholder/cap 30k) + Task 10. ✓
- **Compat tools consumidoras de imagem:** Task 5 mantém `_current_user_images` (anexo-imagem→tools fora de escopo, anotado). ✓
- **Sem emoji / SVG:** Task 9 usa `AttachIcon`. ✓
