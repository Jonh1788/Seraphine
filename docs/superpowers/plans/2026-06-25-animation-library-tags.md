# Animation Library — categories, tags & conversation triggers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user upload/categorize/tag avatar FBX animations in the Lab and have Seraphine play them during conversation by emitting `[anim:tag]` tokens in her replies.

**Architecture:** A new backend catalog (JSON-manifest + file storage, mirroring the existing gesture-persistence pattern) exposes CRUD + file-serve routes under `/lab/animations`. The backend builds a prompt block of available tags and appends it to the cached system prompt; it also strips `[anim:…]` tokens before TTS. The frontend gains a merged catalog store (built-ins ∪ uploaded), a Lab UI to manage animations, and a `[anim:tag]` parser in ChatView that resolves a tag to an asset and calls the existing `controller.playAnimation`.

**Tech Stack:** Python + FastAPI + Pydantic (backend), pytest; React + TypeScript + zustand + three.js (frontend), vitest.

## Global Constraints

- No emojis anywhere — icons are inline SVGs (`icons/Icons.tsx`). Verbatim from project rule.
- Backend storage mirrors the existing gestures pattern in `apps/seraphine/backend/seraphine/lab/routes.py`: JSON file under `apps/seraphine/data/lab/`, `mkdir(parents=True, exist_ok=True)`, no auth. Write the asset file first, then the manifest; on manifest write failure, delete the orphan file.
- Trigger token form is exactly `[anim:<tag>]`; tag charset `[a-z0-9_-]+`, always lowercase. Tags are normalized: lowercased, trimmed, deduped, and any tag containing `]` or `:` is dropped.
- Allowed upload extensions: `.fbx`, `.glb`, `.vrma`. Max upload size: 25 MB (`25 * 1024 * 1024` bytes).
- Backend tests run with: `cd apps/seraphine/backend && uv run pytest <path> -v`. Multipart upload routes require `python-multipart` (FastAPI `File`/`Form`); if `uv run pytest` errors with "Form data requires python-multipart", run `uv add python-multipart` first.
- Frontend commands run from `apps/seraphine/frontend/`: `pnpm test <file>`, `pnpm build`, `pnpm lint`. Known-pre-existing test baseline: 149 passed / 1 failed / 7 errors (Tauri/WebGL env) + 4 lint errors in untracked `design_handoff_seraphine/image-slot.js` — all out of scope; add zero new failures.

---

## File Structure

- `apps/seraphine/backend/seraphine/lab/routes.py` — extend: animation catalog model, storage helpers, CRUD + file-serve routes.
- `apps/seraphine/backend/seraphine/lab/animation_prompt.py` — **new**: `BUILTIN_ANIMATION_TAGS` + `build_animation_prompt_block()`.
- `apps/seraphine/backend/seraphine/conversation/engine.py` — modify: append the animation prompt block to the cached system prompt.
- `apps/seraphine/backend/seraphine/conversation/sentences.py` — modify: strip `[anim:…]` tokens before TTS (unconditionally).
- `apps/seraphine/backend/tests/test_lab_animations.py` — **new**: catalog route tests.
- `apps/seraphine/backend/tests/test_animation_prompt.py` — **new**: prompt-block builder tests.
- `apps/seraphine/backend/tests/test_sentences_anim_tag.py` — **new**: TTS strip test.
- `apps/seraphine/frontend/src/avatar/animations.ts` — modify: add `tags` to the `AnimationEntry` type + built-in entries.
- `apps/seraphine/frontend/src/avatar/animationCatalog.ts` — **new**: zustand store (built-ins ∪ uploaded) + `resolveAnimationTag`.
- `apps/seraphine/frontend/src/avatar/__tests__/animationCatalog.test.ts` — **new**.
- `apps/seraphine/frontend/src/chat/ChatView.tsx` — modify: `[anim:tag]` parse + trigger + display strip.
- `apps/seraphine/frontend/src/chat/__tests__/animTag.test.ts` — **new**: extraction/strip/resolve unit test (pure helpers extracted).
- `apps/seraphine/frontend/src/lab/AvatarLab.tsx` — modify: catalog-driven Animações section (Mixamo/Blender groups, tags, edit/delete, upload form).

---

## Task 1: Backend animation catalog (model, storage, CRUD, file-serve)

**Files:**
- Modify: `apps/seraphine/backend/seraphine/lab/routes.py`
- Test: `apps/seraphine/backend/tests/test_lab_animations.py` (create)

**Interfaces:**
- Produces (module-level in `lab/routes.py`):
  - `_ANIMATIONS_DIR: Path`, `_ANIMATIONS_FILE: Path`, `_ALLOWED_ANIM_EXT: set[str]`, `_MAX_ANIM_BYTES: int`
  - `_read_animations() -> list[dict]`, `_write_animations(list[dict]) -> None`, `_normalize_anim_tags(raw: str | list[str]) -> list[str]`
  - Routes: `GET /lab/animations`, `POST /lab/animations`, `PUT /lab/animations/{anim_id}`, `DELETE /lab/animations/{anim_id}`, `GET /lab/animations/{anim_id}/file`
  - Record shape: `{id, filename, label, source: 'mixamo'|'blender', tags: list[str], loop: bool, created_at}`

- [ ] **Step 1: Write the failing tests**

Create `apps/seraphine/backend/tests/test_lab_animations.py`:

```python
"""Tests for lab animation catalog routes."""
from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.lab.routes import router

_app = FastAPI()
_app.include_router(router)
client = TestClient(_app)


@pytest.fixture(autouse=True)
def _tmp_data(tmp_path: Path):
    with patch("seraphine.lab.routes._DATA_DIR", tmp_path), \
         patch("seraphine.lab.routes._ANIMATIONS_DIR", tmp_path / "animations"), \
         patch("seraphine.lab.routes._ANIMATIONS_FILE", tmp_path / "animations.json"):
        yield


def _upload(label="Acenar", source="mixamo", tags="acenar, ola", loop="false",
            name="wave.fbx", content=b"FBXDATA"):
    return client.post(
        "/lab/animations",
        files={"file": (name, io.BytesIO(content), "application/octet-stream")},
        data={"label": label, "source": source, "tags": tags, "loop": loop},
    )


def test_list_empty():
    assert client.get("/lab/animations").json() == []


def test_upload_then_list():
    r = _upload()
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["source"] == "mixamo"
    assert rec["tags"] == ["acenar", "ola"]
    assert rec["loop"] is False
    assert rec["id"]
    listed = client.get("/lab/animations").json()
    assert len(listed) == 1 and listed[0]["id"] == rec["id"]


def test_upload_rejects_bad_extension():
    r = _upload(name="evil.exe")
    assert r.status_code == 400


def test_upload_rejects_oversize():
    big = b"x" * (25 * 1024 * 1024 + 1)
    r = _upload(content=big)
    assert r.status_code == 400


def test_serve_file_returns_bytes():
    rec = _upload(content=b"HELLOFBX").json()
    r = client.get(f"/lab/animations/{rec['id']}/file")
    assert r.status_code == 200
    assert r.content == b"HELLOFBX"


def test_update_tags_and_source_moves_file():
    rec = _upload(source="mixamo").json()
    r = client.put(f"/lab/animations/{rec['id']}",
                   json={"tags": ["comemorar"], "source": "blender"})
    assert r.status_code == 200
    updated = r.json()
    assert updated["tags"] == ["comemorar"]
    assert updated["source"] == "blender"
    # file still served after the move
    assert client.get(f"/lab/animations/{rec['id']}/file").status_code == 200


def test_delete_removes_record_and_file():
    rec = _upload().json()
    assert client.delete(f"/lab/animations/{rec['id']}").status_code == 200
    assert client.get("/lab/animations").json() == []
    assert client.get(f"/lab/animations/{rec['id']}/file").status_code == 404


def test_update_unknown_404():
    assert client.put("/lab/animations/nope", json={"label": "x"}).status_code == 404
    assert client.delete("/lab/animations/nope").status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/seraphine/backend && uv run pytest tests/test_lab_animations.py -v`
Expected: FAIL/ERROR — routes and module symbols don't exist yet (import or 404 errors). If you see "Form data requires python-multipart", run `uv add python-multipart` and re-run.

- [ ] **Step 3: Add storage helpers and constants**

In `apps/seraphine/backend/seraphine/lab/routes.py`, add to the imports at the top:

```python
import shutil  # noqa: F401  (kept for parity; remove if unused)
import uuid

from fastapi import File, Form, UploadFile
from fastapi.responses import FileResponse
```

Below the existing `_GESTURES_FILE = _DATA_DIR / "gestures.json"` line, add:

```python
_ANIMATIONS_DIR = _DATA_DIR / "animations"
_ANIMATIONS_FILE = _DATA_DIR / "animations.json"
_ALLOWED_ANIM_EXT = {".fbx", ".glb", ".vrma"}
_MAX_ANIM_BYTES = 25 * 1024 * 1024


def _read_animations() -> list[dict[str, Any]]:
    if not _ANIMATIONS_FILE.exists():
        return []
    try:
        data = json.loads(_ANIMATIONS_FILE.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read animations manifest: %s", exc)
        return []


def _write_animations(records: list[dict[str, Any]]) -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        _ANIMATIONS_FILE.write_text(
            json.dumps(records, indent=2, ensure_ascii=False), "utf-8"
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Falha ao salvar animações: {exc}") from exc


def _normalize_anim_tags(raw: "str | list[str]") -> list[str]:
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    out: list[str] = []
    for t in items:
        t = t.strip().lower()
        if not t or "]" in t or ":" in t:
            continue
        if t not in out:
            out.append(t)
    return out
```

- [ ] **Step 4: Add the catalog routes**

Append to `apps/seraphine/backend/seraphine/lab/routes.py` (after the existing gesture routes):

```python
class AnimationUpdate(BaseModel):
    label: str | None = None
    source: Literal["mixamo", "blender"] | None = None
    tags: list[str] | None = None
    loop: bool | None = None


def _find_anim(records: list[dict[str, Any]], anim_id: str) -> dict[str, Any] | None:
    for rec in records:
        if rec.get("id") == anim_id:
            return rec
    return None


@router.get("/animations")
async def list_animations() -> list[dict[str, Any]]:
    return _read_animations()


@router.post("/animations")
async def upload_animation(
    file: UploadFile = File(...),
    label: str = Form(...),
    source: Literal["mixamo", "blender"] = Form(...),
    tags: str = Form(""),
    loop: bool = Form(False),
) -> dict[str, Any]:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ALLOWED_ANIM_EXT:
        raise HTTPException(status_code=400, detail=f"Formato não suportado: {ext or 'sem extensão'}")
    blob = await file.read()
    if not blob:
        raise HTTPException(status_code=400, detail="Arquivo vazio")
    if len(blob) > _MAX_ANIM_BYTES:
        raise HTTPException(status_code=400, detail="Arquivo muito grande (máx 25 MB)")

    anim_id = uuid.uuid4().hex
    stored_name = f"{anim_id}{ext}"
    dest_dir = _ANIMATIONS_DIR / source
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / stored_name
    dest.write_bytes(blob)

    record: dict[str, Any] = {
        "id": anim_id,
        "filename": stored_name,
        "label": label.strip() or stored_name,
        "source": source,
        "tags": _normalize_anim_tags(tags),
        "loop": bool(loop),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    records = _read_animations()
    records.append(record)
    try:
        _write_animations(records)
    except HTTPException:
        dest.unlink(missing_ok=True)  # don't leave an orphan file
        raise
    return record


@router.put("/animations/{anim_id}")
async def update_animation(anim_id: str, body: AnimationUpdate) -> dict[str, Any]:
    records = _read_animations()
    rec = _find_anim(records, anim_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"Animação '{anim_id}' não encontrada")
    if body.label is not None:
        rec["label"] = body.label.strip() or rec["label"]
    if body.tags is not None:
        rec["tags"] = _normalize_anim_tags(body.tags)
    if body.loop is not None:
        rec["loop"] = bool(body.loop)
    if body.source is not None and body.source != rec["source"]:
        old = _ANIMATIONS_DIR / rec["source"] / rec["filename"]
        new_dir = _ANIMATIONS_DIR / body.source
        new_dir.mkdir(parents=True, exist_ok=True)
        if old.exists():
            old.rename(new_dir / rec["filename"])
        rec["source"] = body.source
    _write_animations(records)
    return rec


@router.delete("/animations/{anim_id}")
async def delete_animation(anim_id: str) -> dict[str, str]:
    records = _read_animations()
    rec = _find_anim(records, anim_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"Animação '{anim_id}' não encontrada")
    f = _ANIMATIONS_DIR / rec["source"] / rec["filename"]
    f.unlink(missing_ok=True)
    records.remove(rec)
    _write_animations(records)
    return {"status": "ok"}


@router.get("/animations/{anim_id}/file")
async def get_animation_file(anim_id: str) -> FileResponse:
    records = _read_animations()
    rec = _find_anim(records, anim_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"Animação '{anim_id}' não encontrada")
    f = _ANIMATIONS_DIR / rec["source"] / rec["filename"]
    if not f.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")
    return FileResponse(str(f), filename=rec["filename"])
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/seraphine/backend && uv run pytest tests/test_lab_animations.py -v`
Expected: PASS (9 tests). Output pristine.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/lab/routes.py apps/seraphine/backend/tests/test_lab_animations.py
git commit -m "feat(lab): backend animation catalog (upload, list, edit, delete, serve)"
```

---

## Task 2: Prompt block builder + system-prompt injection

**Files:**
- Create: `apps/seraphine/backend/seraphine/lab/animation_prompt.py`
- Modify: `apps/seraphine/backend/seraphine/conversation/engine.py`
- Test: `apps/seraphine/backend/tests/test_animation_prompt.py` (create)

**Interfaces:**
- Consumes: `_read_animations` from `seraphine.lab.routes` (Task 1).
- Produces: `BUILTIN_ANIMATION_TAGS: list[tuple[str, str]]`, `build_animation_prompt_block() -> str | None`.

- [ ] **Step 1: Write the failing tests**

Create `apps/seraphine/backend/tests/test_animation_prompt.py`:

```python
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from seraphine.lab.animation_prompt import build_animation_prompt_block, BUILTIN_ANIMATION_TAGS


@pytest.fixture(autouse=True)
def _tmp(tmp_path: Path):
    with patch("seraphine.lab.routes._ANIMATIONS_FILE", tmp_path / "animations.json"):
        yield


def test_block_includes_builtin_tags():
    block = build_animation_prompt_block()
    assert block is not None
    for tag, _desc in BUILTIN_ANIMATION_TAGS:
        assert f"- {tag}" in block
    assert "[anim:TAG]" in block


def test_block_includes_uploaded_tags():
    with patch("seraphine.lab.animation_prompt._read_animations",
               return_value=[{"label": "Comemorar", "tags": ["comemorar"]}]):
        block = build_animation_prompt_block()
    assert "- comemorar" in block


def test_block_none_when_no_tags_at_all():
    with patch("seraphine.lab.animation_prompt.BUILTIN_ANIMATION_TAGS", []), \
         patch("seraphine.lab.animation_prompt._read_animations", return_value=[]):
        assert build_animation_prompt_block() is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/seraphine/backend && uv run pytest tests/test_animation_prompt.py -v`
Expected: FAIL — `seraphine.lab.animation_prompt` does not exist.

- [ ] **Step 3: Create the builder module**

Create `apps/seraphine/backend/seraphine/lab/animation_prompt.py`:

```python
"""Build the system-prompt block advertising playable avatar animations.

Seraphine triggers an animation by emitting ``[anim:<tag>]`` in her reply
text (parsed client-side). This block tells her which tags exist.
"""
from __future__ import annotations

from seraphine.lab.routes import _read_animations

# Tags for the built-in animations that ship in the frontend
# (apps/seraphine/frontend/src/avatar/animations.ts). Keep in sync when a
# built-in animation is added — this is the one backend source of truth.
BUILTIN_ANIMATION_TAGS: list[tuple[str, str]] = [
    ("acenar", "cumprimentar ou se despedir"),
]


def build_animation_prompt_block() -> str | None:
    """Return a compact prompt block listing available [anim:TAG]s, or None."""
    pairs: list[tuple[str, str]] = list(BUILTIN_ANIMATION_TAGS)
    for rec in _read_animations():
        label = str(rec.get("label", "")).strip()
        for tag in rec.get("tags", []) or []:
            pairs.append((str(tag), label))

    seen: dict[str, str] = {}
    for tag, desc in pairs:
        if tag and tag not in seen:
            seen[tag] = desc

    if not seen:
        return None

    lines = "\n".join(f"- {tag} — {desc}" if desc else f"- {tag}" for tag, desc in seen.items())
    return (
        "\n\nANIMAÇÕES (toque emitindo [anim:TAG] no meio da fala, com "
        "moderação e naturalidade):\n"
        f"{lines}\n"
        "(Se não houver tag adequada, não use nenhuma — não invente tags.)"
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/seraphine/backend && uv run pytest tests/test_animation_prompt.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Inject the block into the system prompt**

In `apps/seraphine/backend/seraphine/conversation/engine.py`, add to the imports near the other `seraphine.` imports:

```python
from seraphine.lab.animation_prompt import build_animation_prompt_block
```

Find (≈ line 518-520):

```python
        # Append the personality seed to the cached system prompt so it
        # adds zero runtime cost on Anthropic (cacheable prefix).
        self.system_prompt = system_prompt + _PERSONALITY_SEED
```

Replace the assignment with:

```python
        # Append the personality seed + animation-tag catalog to the cached
        # system prompt so they add zero runtime cost on Anthropic (cacheable prefix).
        _anim_block = build_animation_prompt_block() or ""
        self.system_prompt = system_prompt + _PERSONALITY_SEED + _anim_block
```

- [ ] **Step 6: Verify the engine still imports and the existing engine tests pass**

Run: `cd apps/seraphine/backend && uv run pytest tests/conversation -v -k "engine or prompt" 2>&1 | tail -20`
Expected: no import errors; pre-existing engine/prompt tests still pass (no new failures). If there is no matching test, run `uv run python -c "import seraphine.conversation.engine"` and expect no error.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/lab/animation_prompt.py apps/seraphine/backend/seraphine/conversation/engine.py apps/seraphine/backend/tests/test_animation_prompt.py
git commit -m "feat(conversation): inject animation [anim:tag] catalog into system prompt"
```

---

## Task 3: Strip `[anim:…]` tokens before TTS

**Files:**
- Modify: `apps/seraphine/backend/seraphine/conversation/sentences.py`
- Test: `apps/seraphine/backend/tests/test_sentences_anim_tag.py` (create)

**Interfaces:**
- Consumes: existing `strip_markdown_for_tts(text, *, strip_audio_tags=False)` in `sentences.py`.
- Produces: `_RE_ANIM_TAG` regex; `[anim:…]` removed from TTS output unconditionally.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_sentences_anim_tag.py`:

```python
from seraphine.conversation.sentences import strip_markdown_for_tts


def test_anim_tag_stripped_when_audio_tags_kept():
    # v3 path: audio tags are LEFT in, but [anim:...] must still go.
    out = strip_markdown_for_tts("Oi [anim:acenar] tudo bem?", strip_audio_tags=False)
    assert "[anim:acenar]" not in out
    assert "anim" not in out
    assert "tudo bem" in out


def test_anim_tag_stripped_when_audio_tags_removed():
    out = strip_markdown_for_tts("Vamos [anim:comemorar] juntos", strip_audio_tags=True)
    assert "[anim:comemorar]" not in out
    assert "comemorar" not in out
    assert "juntos" in out
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/seraphine/backend && uv run pytest tests/test_sentences_anim_tag.py -v`
Expected: FAIL — `[anim:acenar]` survives (the existing audio-tag regex doesn't match the colon form).

- [ ] **Step 3: Add the regex and strip it unconditionally**

In `apps/seraphine/backend/seraphine/conversation/sentences.py`, near the other module-level regexes (next to `_RE_AUDIO_TAG = re.compile(...)`), add:

```python
# Avatar animation triggers like [anim:acenar] — never spoken; stripped
# unconditionally (unlike ElevenLabs audio tags, which v3 renders).
_RE_ANIM_TAG = re.compile(r"\[anim:[a-z0-9_-]+\]", re.IGNORECASE)
```

In `strip_markdown_for_tts`, find the audio-tag block:

```python
    # Strip ElevenLabs audio tags when the TTS model doesn't support them.
    if strip_audio_tags:
        s = _RE_AUDIO_TAG.sub("", s)
```

Insert the unconditional anim-tag strip immediately ABOVE it:

```python
    # Animation triggers are control tokens, never speech — always remove.
    s = _RE_ANIM_TAG.sub("", s)
    # Strip ElevenLabs audio tags when the TTS model doesn't support them.
    if strip_audio_tags:
        s = _RE_AUDIO_TAG.sub("", s)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/seraphine/backend && uv run pytest tests/test_sentences_anim_tag.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/conversation/sentences.py apps/seraphine/backend/tests/test_sentences_anim_tag.py
git commit -m "fix(tts): strip [anim:tag] control tokens before speech synthesis"
```

---

## Task 4: Frontend animation catalog store + built-in tags

**Files:**
- Modify: `apps/seraphine/frontend/src/avatar/animations.ts`
- Create: `apps/seraphine/frontend/src/avatar/animationCatalog.ts`
- Test: `apps/seraphine/frontend/src/avatar/__tests__/animationCatalog.test.ts` (create)

**Interfaces:**
- Consumes: `API_BASE` from `../api`; `ANIMATION_LIBRARY` from `./animations`.
- Produces:
  - `AnimationEntry.tags?: string[]` (added field)
  - `AnimationAsset { id, label, source: 'mixamo'|'blender', tags: string[], loop: boolean, url: string, builtin: boolean }`
  - `useAnimationCatalog` zustand store: `{ assets: AnimationAsset[]; loaded: boolean; load: () => Promise<void> }`
  - `resolveAnimationTag(assets: AnimationAsset[], tag: string): AnimationAsset | undefined`

- [ ] **Step 1: Add `tags` to built-ins**

In `apps/seraphine/frontend/src/avatar/animations.ts`, change the interface and the entry:

```ts
export interface AnimationEntry {
  name: string;
  label: string;      // PT-BR display name
  url: string;        // path to .fbx or .glb in /public/animations/
  loop: boolean;      // true for idle-type, false for one-shot
  tags?: string[];    // [anim:tag] triggers; built-ins ship with their tags
}

/** Built-in animations that ship in /public/animations/. Users can add more. */
export const ANIMATION_LIBRARY: AnimationEntry[] = [
  { name: 'waving', label: 'Acenar (Mixamo)', url: '/animations/Waving.fbx', loop: false, tags: ['acenar'] },
];
```

- [ ] **Step 2: Write the failing tests**

Create `apps/seraphine/frontend/src/avatar/__tests__/animationCatalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveAnimationTag, type AnimationAsset } from '../animationCatalog';

const assets: AnimationAsset[] = [
  { id: 'builtin:waving', label: 'Acenar', source: 'mixamo', tags: ['acenar'], loop: false, url: '/animations/Waving.fbx', builtin: true },
  { id: 'abc', label: 'Comemorar', source: 'blender', tags: ['comemorar', 'vitoria'], loop: false, url: 'http://x/abc/file', builtin: false },
];

describe('resolveAnimationTag', () => {
  it('matches a tag case-insensitively', () => {
    expect(resolveAnimationTag(assets, 'ACENAR')?.id).toBe('builtin:waving');
    expect(resolveAnimationTag(assets, 'vitoria')?.id).toBe('abc');
  });
  it('returns undefined on a miss', () => {
    expect(resolveAnimationTag(assets, 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/seraphine/frontend && pnpm test src/avatar/__tests__/animationCatalog.test.ts`
Expected: FAIL — cannot resolve `../animationCatalog`.

- [ ] **Step 4: Create the catalog store**

Create `apps/seraphine/frontend/src/avatar/animationCatalog.ts`:

```ts
import { create } from 'zustand';
import { API_BASE } from '../api';
import { ANIMATION_LIBRARY } from './animations';

export interface AnimationAsset {
  id: string;
  label: string;
  source: 'mixamo' | 'blender';
  tags: string[];
  loop: boolean;
  url: string;
  builtin: boolean;
}

interface AnimationRecord {
  id: string;
  filename: string;
  label: string;
  source: 'mixamo' | 'blender';
  tags: string[];
  loop: boolean;
  created_at: string;
}

function builtinsAsAssets(): AnimationAsset[] {
  return ANIMATION_LIBRARY.map((e) => ({
    id: `builtin:${e.name}`,
    label: e.label,
    source: 'mixamo' as const,
    tags: e.tags ?? [],
    loop: e.loop,
    url: e.url, // served statically from /public/animations/
    builtin: true,
  }));
}

interface CatalogState {
  assets: AnimationAsset[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useAnimationCatalog = create<CatalogState>((set) => ({
  assets: builtinsAsAssets(),
  loaded: false,
  load: async () => {
    try {
      const res = await fetch(`${API_BASE}/lab/animations`);
      const records: AnimationRecord[] = res.ok ? await res.json() : [];
      const uploaded: AnimationAsset[] = records.map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source,
        tags: r.tags ?? [],
        loop: r.loop,
        url: `${API_BASE}/lab/animations/${r.id}/file`,
        builtin: false,
      }));
      set({ assets: [...builtinsAsAssets(), ...uploaded], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** First asset whose tags include `tag` (case-insensitive). */
export function resolveAnimationTag(
  assets: AnimationAsset[],
  tag: string,
): AnimationAsset | undefined {
  const t = tag.toLowerCase();
  return assets.find((a) => a.tags.some((x) => x.toLowerCase() === t));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/seraphine/frontend && pnpm test src/avatar/__tests__/animationCatalog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Verify build/lint**

Run: `cd apps/seraphine/frontend && pnpm build && pnpm lint 2>&1 | grep -iE 'animationCatalog|animations.ts' || echo "clean"`
Expected: build OK; no lint errors in the new/changed files.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/frontend/src/avatar/animations.ts apps/seraphine/frontend/src/avatar/animationCatalog.ts apps/seraphine/frontend/src/avatar/__tests__/animationCatalog.test.ts
git commit -m "feat(avatar): animation catalog store (built-ins ∪ uploaded) + tag resolver"
```

---

## Task 5: ChatView `[anim:tag]` trigger + display strip

**Files:**
- Modify: `apps/seraphine/frontend/src/chat/ChatView.tsx`
- Create: `apps/seraphine/frontend/src/chat/animTag.ts` (pure helpers, for testability)
- Test: `apps/seraphine/frontend/src/chat/__tests__/animTag.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAnimationTag`, `useAnimationCatalog`, `AnimationAsset` (Task 4); the controller's existing `playAnimation(url, { loop })`.
- Produces: `ANIM_TAG_RE`, `extractAnimTags(text): string[]`, `stripAnimTags(text): string` in `chat/animTag.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/frontend/src/chat/__tests__/animTag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractAnimTags, stripAnimTags } from '../animTag';

describe('animTag helpers', () => {
  it('extracts anim tags', () => {
    expect(extractAnimTags('Oi [anim:acenar]! e [anim:comemorar]')).toEqual(['acenar', 'comemorar']);
  });
  it('ignores plain emotion tags', () => {
    expect(extractAnimTags('estou [excited] hoje')).toEqual([]);
  });
  it('strips anim tags but leaves text and emotion tags', () => {
    expect(stripAnimTags('Oi [anim:acenar] [excited]!')).toBe('Oi  [excited]!');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/seraphine/frontend && pnpm test src/chat/__tests__/animTag.test.ts`
Expected: FAIL — cannot resolve `../animTag`.

- [ ] **Step 3: Create the pure helpers**

Create `apps/seraphine/frontend/src/chat/animTag.ts`:

```ts
/** Matches avatar animation triggers like [anim:acenar]. */
export const ANIM_TAG_RE = /\[anim:([a-z0-9_-]+)\]/gi;

export function extractAnimTags(text: string): string[] {
  const re = new RegExp(ANIM_TAG_RE.source, ANIM_TAG_RE.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
  return out;
}

export function stripAnimTags(text: string): string {
  return text.replace(new RegExp(ANIM_TAG_RE.source, ANIM_TAG_RE.flags), '');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/seraphine/frontend && pnpm test src/chat/__tests__/animTag.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the catalog + trigger into ChatView**

In `apps/seraphine/frontend/src/chat/ChatView.tsx`:

(a) Add imports near the other avatar/catalog imports:

```ts
import { useAnimationCatalog, resolveAnimationTag } from '../avatar/animationCatalog';
import { extractAnimTags } from './animTag';
```

(b) Extend the existing display-strip helper `stripAudioTags` (the `AUDIO_TAG_RE`/`stripAudioTags` near line 100) so anim tokens never render. Change the function body to also strip anim tags:

```ts
function stripAudioTags(text: string): string {
  return text
    .replace(AUDIO_TAG_RE, '')
    .replace(/\[anim:[a-z0-9_-]+\]/gi, '')
    .replace(/ {2,}/g, ' ');
}
```

(c) Inside the `ChatView` component body (near the other store/ref hooks, before `triggerAvatarFromTag`), subscribe to the catalog and load it once:

```ts
  const animAssets = useAnimationCatalog((s) => s.assets);
  const loadAnimCatalog = useAnimationCatalog((s) => s.load);
  useEffect(() => { void loadAnimCatalog(); }, [loadAnimCatalog]);
```

(d) Add the trigger callback next to `triggerAvatarFromTag`:

```ts
  const triggerAnimationFromTag = useCallback(
    (tag: string) => {
      const ctrl = avatarController?.current;
      if (!ctrl) return;
      const asset = resolveAnimationTag(animAssets, tag);
      if (!asset) return; // unknown tag → ignore silently
      try {
        void ctrl.playAnimation?.(asset.url, { loop: asset.loop });
      } catch {
        // controller may not expose playAnimation yet
      }
    },
    [avatarController, animAssets],
  );
```

(e) In BOTH places where the existing emotion-tag scan runs (the `msg.type === 'token'` handler ≈ line 606 and the `assistant_opener` handler ≈ line 630), add a parallel anim scan right after the existing `while ((tagMatch = tagRe.exec(...)))` loop. For each handler, after the emotion loop add:

```ts
        for (const animTag of extractAnimTags(tokenText)) {
          triggerAnimationFromTag(animTag);
        }
```

Use the same source variable the surrounding handler uses (`tokenText` in the token handler, `openerText` in the opener handler).

(f) Add `triggerAnimationFromTag` to the dependency array of the `ws.onMessage` effect (the one currently listing `[ws, triggerAvatarFromTag, avatarController]` ≈ line 874):

```ts
  }, [ws, triggerAvatarFromTag, triggerAnimationFromTag, avatarController]);
```

- [ ] **Step 6: Verify build, lint, and full suite (no new failures)**

Run: `cd apps/seraphine/frontend && pnpm build`
Expected: clean.

Run: `pnpm lint 2>&1 | grep -iE 'ChatView|animTag' | grep -v image-slot || echo "clean"`
Expected: no new errors (no exhaustive-deps warning on the touched effects).

Run: `pnpm test 2>&1 | grep -E "Test Files|Tests|Errors"`
Expected: animTag + animationCatalog tests pass; overall failures ≤ baseline (149 passed plus the 5 new = 154 passed / 1 failed / 7 errors; zero NEW failures).

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/frontend/src/chat/ChatView.tsx apps/seraphine/frontend/src/chat/animTag.ts apps/seraphine/frontend/src/chat/__tests__/animTag.test.ts
git commit -m "feat(chat): play avatar animations from [anim:tag] tokens in replies"
```

---

## Task 6: Lab UI — catalog-driven Animações (groups, tags, upload, edit, delete)

**Files:**
- Modify: `apps/seraphine/frontend/src/lab/AvatarLab.tsx`

**Interfaces:**
- Consumes: `useAnimationCatalog` (`assets`, `load`) + `AnimationAsset` (Task 4); existing `handleAnimation`/`handleStopAnimation`/`playingAnimation` in AvatarLab; `API_BASE` from `../api` (already imported in AvatarLab or import it).

This task is UI-heavy; its gate is `pnpm build` + `pnpm lint` clean + manual verification (the upload/play/edit/delete flow cannot be exercised in jsdom). Follow existing AvatarLab styling/classes.

- [ ] **Step 1: Replace the hardcoded Animações section with the catalog**

In `apps/seraphine/frontend/src/lab/AvatarLab.tsx`:

(a) Change the import on line 3 to also pull the catalog (keep `AnimationEntry` if still referenced by `handleAnimation`):

```ts
import { ANIMATION_LIBRARY, type AnimationEntry } from '../avatar/animations';
import { useAnimationCatalog, type AnimationAsset } from '../avatar/animationCatalog';
import { API_BASE } from '../api';
```

(b) In the component body, subscribe + load:

```ts
  const animAssets = useAnimationCatalog((s) => s.assets);
  const loadAnimCatalog = useAnimationCatalog((s) => s.load);
  useEffect(() => { void loadAnimCatalog(); }, [loadAnimCatalog]);
```

(c) Add a play helper that works with `AnimationAsset` (the existing `handleAnimation` takes an `AnimationEntry`; reuse the controller call directly):

```ts
  const playAsset = useCallback(
    (asset: AnimationAsset) => {
      void controller?.playAnimation?.(asset.url, { loop: asset.loop });
      setPlayingAnimation(asset.url);
    },
    [controller],
  );
```

(If `setPlayingAnimation` is not the existing state setter name, use whatever the current `playingAnimation` state uses.)

(d) Replace the JSX of the `{/* Animations */}` section (currently rendering `ANIMATION_LIBRARY`) with two source-grouped lists built from `animAssets`. Render a group for `source === 'mixamo'` titled "Mixamo" and one for `source === 'blender'` titled "Blender (minhas)". Each item: a play/stop button (active when `playingAnimation === asset.url`), the asset's tags shown as small chips, and — for `!asset.builtin` — an edit control (prompt or inline form updating label/source/tags/loop via `PUT`) and a delete control (`DELETE`). Built-ins render without edit/delete. Keep the existing `playingAnimation && <Parar>` stop button behavior via `handleStopAnimation`. Example shape for one group (mirror for the other source):

```tsx
{(['mixamo', 'blender'] as const).map((src) => (
  <div key={src} className="avatar-lab__anim-group">
    <h4 className="avatar-lab__section-subtitle">{src === 'mixamo' ? 'Mixamo' : 'Blender (minhas)'}</h4>
    <div className="avatar-lab__gestures">
      {animAssets.filter((a) => a.source === src).map((asset) => (
        <div key={asset.id} className="avatar-lab__anim-item">
          <button
            type="button"
            className={`avatar-lab__gesture-btn${playingAnimation === asset.url ? ' avatar-lab__btn--active' : ''}`}
            onClick={() => playAsset(asset)}
          >
            {asset.label}
          </button>
          {asset.tags.length > 0 && (
            <span className="avatar-lab__anim-tags">
              {asset.tags.map((t) => (<span key={t} className="avatar-lab__chip">{t}</span>))}
            </span>
          )}
          {!asset.builtin && (
            <>
              <button type="button" className="avatar-lab__icon-btn" onClick={() => void handleEditAnim(asset)} aria-label="Editar">editar</button>
              <button type="button" className="avatar-lab__icon-btn" onClick={() => void handleDeleteAnim(asset)} aria-label="Excluir">excluir</button>
            </>
          )}
        </div>
      ))}
      {animAssets.filter((a) => a.source === src).length === 0 && (
        <p className="avatar-lab__test-hint">Nenhuma animação {src === 'mixamo' ? 'Mixamo' : 'do Blender'} ainda.</p>
      )}
    </div>
  </div>
))}
{playingAnimation && (
  <button type="button" className="avatar-lab__gesture-btn" onClick={handleStopAnimation}>Parar</button>
)}
```

(Text labels "editar"/"excluir" are placeholders for inline SVG icons from `icons/Icons.tsx` if available — no emojis. Use existing icon components if AvatarLab already imports any; otherwise plain text buttons are acceptable.)

- [ ] **Step 2: Add edit/delete handlers**

Add to the AvatarLab component body:

```ts
  const handleDeleteAnim = useCallback(async (asset: AnimationAsset) => {
    if (!window.confirm(`Excluir a animação "${asset.label}"?`)) return;
    await fetch(`${API_BASE}/lab/animations/${asset.id}`, { method: 'DELETE' });
    await loadAnimCatalog();
  }, [loadAnimCatalog]);

  const handleEditAnim = useCallback(async (asset: AnimationAsset) => {
    const label = window.prompt('Nome:', asset.label) ?? asset.label;
    const tags = (window.prompt('Tags (separadas por vírgula):', asset.tags.join(', ')) ?? asset.tags.join(', '))
      .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    await fetch(`${API_BASE}/lab/animations/${asset.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, tags }),
    });
    await loadAnimCatalog();
  }, [loadAnimCatalog]);
```

(A `prompt`-based editor is intentionally minimal; an inline form is a nice-to-have, not required.)

- [ ] **Step 3: Add the "Adicionar animação" upload control**

Add an upload form at the top of the Animações section. Minimal version: a hidden file input + fields for label/source/tags/loop, posting multipart to `POST /lab/animations`:

```tsx
<form
  className="avatar-lab__anim-upload"
  onSubmit={async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get('file') as File | null;
    if (!file || !file.size) { setAnimUploadError('Escolha um arquivo'); return; }
    setAnimUploadError(null);
    const res = await fetch(`${API_BASE}/lab/animations`, { method: 'POST', body: fd });
    if (!res.ok) { setAnimUploadError((await res.json().catch(() => ({}))).detail ?? 'Falha no upload'); return; }
    form.reset();
    await loadAnimCatalog();
  }}
>
  <input type="file" name="file" accept=".fbx,.glb,.vrma" required />
  <input type="text" name="label" placeholder="Nome (ex: Comemorar)" required />
  <select name="source" defaultValue="mixamo">
    <option value="mixamo">Mixamo</option>
    <option value="blender">Blender (minhas)</option>
  </select>
  <input type="text" name="tags" placeholder="tags: comemorar, vitoria" />
  <label><input type="checkbox" name="loop" value="true" /> Loop</label>
  <button type="submit" className="avatar-lab__gesture-btn">Adicionar animação</button>
  {animUploadError && <span className="avatar-lab__test-hint">{animUploadError}</span>}
</form>
```

Add the error state near the other AvatarLab state:

```ts
  const [animUploadError, setAnimUploadError] = useState<string | null>(null);
```

Note: the `loop` checkbox sends the string `"true"` only when checked; the backend `loop: bool = Form(False)` parses `"true"`→True and treats absence as False. Confirm this in manual testing.

- [ ] **Step 4: Verify build + lint**

Run: `cd apps/seraphine/frontend && pnpm build`
Expected: clean (no unused `ANIMATION_LIBRARY`/`AnimationEntry` import errors — remove them if `handleAnimation` is no longer used, or keep if still referenced).

Run: `pnpm lint 2>&1 | grep -iE 'AvatarLab' | grep -v image-slot || echo "clean"`
Expected: no new errors.

- [ ] **Step 5: Manual verification (requires the running app + backend)**

Run the app (`pnpm tauri dev` or the installed build with the backend up). In the Avatar Lab → Animações:
1. Upload a `.fbx` with source Mixamo, label "Acenar 2", tag `acenar2` → it appears under **Mixamo** with the chip `acenar2`.
2. Click it → the avatar plays the clip; **Parar** stops it.
3. Edit its tags → the chip updates after refresh.
4. Upload one as **Blender** → appears under **Blender (minhas)**.
5. Delete one → it disappears and its file 404s.
6. Reject path: try uploading a `.txt` → inline error "Formato não suportado".

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src/lab/AvatarLab.tsx
git commit -m "feat(lab): catalog-driven Animações — Mixamo/Blender groups, tags, upload, edit, delete"
```

---

## Self-Review

**Spec coverage:**
- Backend catalog (storage, model, CRUD, file-serve) → Task 1. ✓
- Prompt block builder + injection (Decision C) → Task 2. ✓
- `[anim:…]` TTS strip → Task 3 (discovered during planning: existing audio-tag strippers don't match the colon form). ✓
- Frontend registry, built-in merge (Decision A), `resolveTag` → Task 4. ✓
- Conversation trigger via `[anim:tag]` (Decision B) + display strip → Task 5. ✓
- Lab UI: Mixamo/Blender groups, tags, upload, edit, delete, built-ins read-only → Task 6. ✓
- Testing: backend pytest (Tasks 1-3), frontend vitest (Tasks 4-5), manual (Task 6). ✓
- Out-of-scope items (System A, LLM tool, embodied.py, dir-scan, in-app editing) — not implemented, as intended. ✓

**Type consistency:** `AnimationAsset` (Task 4) is consumed verbatim in Tasks 5-6. `resolveAnimationTag(assets, tag)` signature consistent across Tasks 4-5. Backend record keys (`id/filename/label/source/tags/loop/created_at`) consistent across Task 1 routes, Task 2 builder (`label`,`tags`), and Task 4 frontend `AnimationRecord`. Token form `[anim:<tag>]` and charset `[a-z0-9_-]+` identical in Task 3 (`_RE_ANIM_TAG`), Task 5 (`ANIM_TAG_RE`), and the display strip. `build_animation_prompt_block() -> str | None` consistent (Task 2 def, engine consumes with `or ""`).

**Placeholder scan:** No "TBD"/"add error handling" placeholders. Two intentional latitude points are explicitly bounded: Task 6's edit UI (prompt-based is acceptable; inline form is nice-to-have) and the edit/delete icon text (use existing SVG icons if present, plain text otherwise, never emojis). Both are real, runnable code as written.
