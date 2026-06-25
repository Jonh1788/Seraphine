# Animation Library — categories, tags & conversation triggers

**Date:** 2026-06-25
**Status:** Design approved, pending spec review
**Scope:** Seraphine avatar FBX-clip animations (System B). Adds a backend catalog with upload, source categories (Mixamo/Blender), tags, Lab management UI, conversation triggering via inline `[anim:tag]` tokens, and auto-injection of the available tags into Seraphine's system prompt.

## Problem

Today the avatar's external animations (Mixamo FBX clips, "System B") are:

- **Hardcoded** in a single TS array `apps/seraphine/frontend/src/avatar/animations.ts` (`ANIMATION_LIBRARY`). Adding one means editing source + rebuild/reinstall.
- **Uncategorized** — no notion of where a clip came from (Mixamo vs hand-made in Blender).
- **Untagged** — no semantic labels.
- **Not reachable from conversation** — they only play from a manual button in `lab/AvatarLab.tsx`. There is no name-addressable trigger path that reaches `controller.playAnimation`, and the assistant has no way to know they exist.

(The parallel "System A" procedural gestures already persist to a backend JSON file and can be triggered from conversation via ~5 hardcoded `[tag]` tokens in `chat/ChatView.tsx`. This feature builds the equivalent machinery for System B FBX clips, plus upload and categories.)

The user wants to: upload animations through the Lab, have them auto-listed and split by source (Mixamo / Blender), tag them, and have Seraphine play them during conversation by emitting tags in her replies.

## Decisions (locked)

- **A. Built-ins preserved via merge.** Keep the existing `ANIMATION_LIBRARY` (e.g. `Waving.fbx`) as read-only **built-in** entries (source `mixamo`) and merge them with uploaded entries in both the registry and the Lab UI. No data migration of the shipped asset.
- **B. Namespaced trigger token.** Conversation triggering uses `[anim:<tag>]` (e.g. `[anim:acenar]`), distinct from the existing emotion tags (`[excited]`, `[laughs]`) so the two tag spaces never collide.
- **C. Auto-inject tags into the system prompt.** The backend reads the manifest and injects a short block listing the available tags + descriptions, kept in sync automatically.

## Architecture

```
Upload (Lab)  ──►  POST /lab/animations (multipart)
                      │  writes file to data/lab/animations/<source>/<file>
                      │  appends metadata to animations.json manifest
                      ▼
Catalog  ◄── GET /lab/animations ──►  frontend registry (built-ins ∪ uploaded)
   │                                        │
   │                                        ├─► Lab UI: Mixamo / Blender sections, play, edit, delete
   │                                        └─► ChatView: resolve [anim:tag] → playAnimation(url, {loop})
   │
   └─► prompt block builder ──► injected into Seraphine's system prompt
GET /lab/animations/{id}/file ──► serves the FBX to FBXLoader at play time
```

## Components

### 1. Backend — animation catalog (`apps/seraphine/backend/seraphine/lab/routes.py`, extend)

Reuse the existing `_DATA_DIR` (`apps/seraphine/data/lab/`). Add:

- **Storage:** files under `_DATA_DIR / "animations" / <source> / <safe_filename>`; metadata in `_DATA_DIR / "animations.json"` (a list of records).
- **Record schema (Pydantic):**
  ```
  AnimationRecord {
    id: str            # uuid4 hex
    filename: str      # stored basename
    label: str         # display name (PT-BR)
    source: Literal["mixamo", "blender"]
    tags: list[str]    # lowercase, kebab/simple words; used as [anim:tag]
    loop: bool
    created_at: str    # ISO 8601
  }
  ```
- **Routes** (all under the existing `/lab` router):
  - `GET /lab/animations` → `list[AnimationRecord]` (uploaded only; built-ins live in the frontend).
  - `POST /lab/animations` → multipart: `file` (UploadFile) + form fields `label`, `source`, `tags` (comma-separated or repeated), `loop`. Validates extension ∈ {`.fbx`,`.glb`,`.vrma`} and size ≤ a cap (e.g. 25 MB). Sanitizes filename, writes file, appends record, returns the record.
  - `PUT /lab/animations/{id}` → body `{label?, source?, tags?, loop?}`; updates metadata (and moves the file if `source` changes). 404 if unknown id.
  - `DELETE /lab/animations/{id}` → removes record + file. 404 if unknown.
  - `GET /lab/animations/{id}/file` → `FileResponse` of the stored FBX (the frontend loader fetches this).
- **Concurrency/integrity:** manifest read-modify-write mirrors the existing gestures file pattern (`_read_all`/`_write_all` style); on write failure, do not leave an orphan file (write file first, then manifest; on manifest failure, delete the file).
- **Tag normalization:** lowercase, strip, drop empties, dedupe. Reject tags containing `]` or `:` (would break the `[anim:tag]` token).

### 2. Backend — prompt block builder + injection

- New helper (in `lab/` or `conversation/`) `build_animation_prompt_block() -> str | None` that reads the manifest **plus** the known built-in tags, and returns a compact block:
  ```
  ANIMAÇÕES (toque emitindo [anim:TAG] no meio da fala, use com moderação e naturalidade):
  - acenar — cumprimentar/despedir
  - comemorar — vitória/empolgação
  ...
  (Se não houver tag adequada, não invente.)
  ```
  Returns `None` when the catalog is empty (inject nothing).
- **Injection point:** append to the **cached** region of the system prompt next to `_PERSONALITY_SEED` in `conversation/engine.py` (so it costs ~0 runtime tokens via prompt caching), rebuilt when the engine initializes. The block reflects the catalog at conversation start. (Alternative considered: per-turn injection via `conversation/ambient.py` — rejected for this feature because the tag list is near-static and per-turn injection forfeits caching.)
- Built-in tags (from `ANIMATION_LIBRARY`) must also appear in the block. Since built-ins live in the frontend today, the builder needs their tags too: introduce a small shared list of built-in animation tags on the backend (mirrors the frontend built-ins — e.g. `waving → acenar`), or have the frontend register built-ins into the catalog on first run. **Chosen:** a tiny backend constant `BUILTIN_ANIMATION_TAGS` listing built-in tag→description, kept beside the builder; documented as the one place to update when a built-in is added. (Keeps the prompt builder backend-only and avoids a frontend→backend sync round-trip.)

### 3. Frontend — registry & types (`apps/seraphine/frontend/src/avatar/`)

- New type `AnimationAsset { id, label, source: 'mixamo'|'blender', tags: string[], loop: boolean, url: string, builtin: boolean }`.
- A loader/store (e.g. `avatar/animationCatalog.ts`) that:
  - Fetches `GET /lab/animations`, maps each record to an `AnimationAsset` with `url = ${API_BASE}/lab/animations/{id}/file`, `builtin: false`.
  - Merges the existing `ANIMATION_LIBRARY` built-ins (mapped to `AnimationAsset` with `builtin: true`, `url` = their static `/animations/*.fbx` path, `source: 'mixamo'`, plus a `tags` field added to those entries).
  - Exposes `useAnimationCatalog()` (or a small zustand store) returning the merged list + a `resolveTag(tag): AnimationAsset | undefined` (first match; case-insensitive).
- Extend `ANIMATION_LIBRARY` entries in `animations.ts` with a `tags: string[]` field (e.g. waving → `['acenar']`).

### 4. Frontend — Lab UI (`apps/seraphine/frontend/src/lab/AvatarLab.tsx`, Animações section)

- Replace the hardcoded `ANIMATION_LIBRARY` rendering with the merged catalog, grouped into two labelled sections: **Mixamo** and **Blender (minhas)**.
- Each item: existing play/stop toggle (`controller.playAnimation(asset.url, { loop: asset.loop })`), the asset's tags shown as chips, and for non-builtin items an **edit** (label/source/tags/loop) and **delete** control. Built-ins are read-only (no edit/delete).
- **"Adicionar animação"** button → a small form/modal: file picker (`.fbx/.glb/.vrma`), label, source (Mixamo/Blender), tags (comma-separated input), loop checkbox → `POST /lab/animations` (multipart) → refetch catalog. Show upload errors (bad extension, too large) inline.
- After upload/edit/delete, refresh the catalog store so the list and the chat trigger stay current within the session.

### 5. Frontend — conversation trigger (`apps/seraphine/frontend/src/chat/ChatView.tsx`)

- Add an animation-tag matcher alongside the existing emotion-tag parsing. Regex: `/\[anim:([a-z0-9_-]+)\]/gi`.
- On match while the assistant's text streams: `resolveTag(tag)` against the catalog; if found, `controller.playAnimation(asset.url, { loop: asset.loop })`; if not found, ignore silently (never throw, never block the stream).
- Strip the `[anim:...]` token from the displayed/spoken text exactly as existing `[tag]` tokens are stripped, so the user never sees it.
- The catalog must be available to ChatView (same store as the Lab). If the catalog hasn't loaded yet when a tag arrives, ignore (best-effort).
- Reuse the existing controller `playAnimation` (System B) — it already takes over idle/procedural work and a non-looping clip returns to idle when done. No controller change beyond what exists.

## Error handling

- Upload: reject non-allowed extensions and oversized files with a 400 + clear message surfaced in the Lab form. Never persist a partial record.
- Playback from chat: a missing/failed clip is caught (existing `playAnimation` logs and no-ops); the chat stream is never interrupted.
- Unknown tag in assistant text: silently ignored.
- Manifest corruption: backend logs and treats as empty (mirrors gestures-file behavior), so the app still runs.

## Testing

- **Backend (pytest):** upload (happy path → file written + record appended), extension rejection, size rejection, list, edit (incl. source change moves file), delete (removes file + record), `GET .../file` serves bytes, tag normalization, `build_animation_prompt_block` (empty → None; with records → block contains each tag + built-ins).
- **Frontend (vitest):** catalog merge (built-ins ∪ uploaded, correct urls/flags), `resolveTag` (case-insensitive, first match, miss → undefined), and the `[anim:tag]` extraction/strip on a sample assistant text (matched token removed; resolved asset → playAnimation called via a mocked controller).
- **Manual:** upload an FBX in the Lab → appears under the right section with its tags → plays from the Lab → in chat, get Seraphine to emit `[anim:tag]` (or inject a test reply) → the clip plays and the token is not shown.

## Out of scope

- System A procedural gestures (unchanged).
- LLM tool/function-calling trigger path (explicitly chose tag-in-text).
- Backend-side regex auto-detection of intent (`embodied.py` stays as-is).
- Runtime directory-scan discovery (chose UI upload).
- Animation editing/trimming in-app (use Blender; this feature only catalogs finished clips).

## Risks / notes

- **Built-in tag sync:** `BUILTIN_ANIMATION_TAGS` (backend) must mirror the frontend built-in `tags`. Single documented source of truth on each side; only relevant if built-ins are added (rare). Acceptable.
- **Token cost:** the injected block is small and lands in the cached prompt region, so steady-state runtime cost is ~0; only the cache-write turn pays for it.
- **Tag overuse by the model:** the prompt block instructs moderation ("use com moderação e naturalidade", "não invente"). Tune wording if she over-triggers.
- **Serving FBX from the backend:** ensure the backend is reachable from the frontend at `API_BASE` (it already serves `/lab/gestures`), so `/lab/animations/{id}/file` is consistent with the existing setup.
