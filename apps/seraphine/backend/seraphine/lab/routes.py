"""Lab gesture persistence -- JSON file backed, no auth."""

from __future__ import annotations

import json
import logging
import shutil  # noqa: F401  (kept for parity; remove if unused)
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/lab", tags=["lab"])
logger = logging.getLogger(__name__)

# Resolve data dir relative to the project root (apps/seraphine/data/lab/).
_DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "lab"
_GESTURES_FILE = _DATA_DIR / "gestures.json"

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


_EXPORT_SCHEMA_VERSION = 1


def _read_all() -> dict[str, Any]:
    if not _GESTURES_FILE.exists():
        return {}
    try:
        return json.loads(_GESTURES_FILE.read_text("utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read gestures file: %s", exc)
        return {}


def _write_all(data: dict[str, Any]) -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        _GESTURES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Falha ao salvar gestures: {exc}") from exc


def _validate_gesture(g: dict[str, Any]) -> None:
    """Validate a gesture dict has the minimum required fields."""
    if not isinstance(g, dict):
        raise ValueError("Gesture must be an object")
    name = g.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Gesture missing valid 'name'")
    duration = g.get("duration")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise ValueError(f"Gesture '{name}' has invalid duration")
    kfs = g.get("keyframes")
    if not isinstance(kfs, list):
        raise ValueError(f"Gesture '{name}' missing keyframes list")
    for i, kf in enumerate(kfs):
        if not isinstance(kf, dict):
            raise ValueError(f"Gesture '{name}' keyframe {i} is not an object")
        if "bone" not in kf or not isinstance(kf["bone"], str):
            raise ValueError(f"Gesture '{name}' keyframe {i} missing bone")
        if "rotation" not in kf or not isinstance(kf["rotation"], dict):
            raise ValueError(f"Gesture '{name}' keyframe {i} missing rotation")
        if "time" not in kf or not isinstance(kf["time"], (int, float)):
            raise ValueError(f"Gesture '{name}' keyframe {i} missing time")


class RotationIn(BaseModel):
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


class KeyframeIn(BaseModel):
    bone: str
    rotation: RotationIn
    time: float


class GestureDefinitionIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    duration: float = Field(gt=0)
    keyframes: list[KeyframeIn]


class SaveGestureBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    definition: GestureDefinitionIn


class ImportBody(BaseModel):
    version: int = Field(ge=1, le=_EXPORT_SCHEMA_VERSION)
    gestures: list[dict[str, Any]]
    conflict_strategy: Literal["replace", "rename", "skip"] = "skip"


class ImportResult(BaseModel):
    imported: list[str] = []
    skipped: list[str] = []
    renamed: dict[str, str] = {}
    errors: list[str] = []


@router.get("/gestures")
async def get_gestures() -> dict[str, Any]:
    return _read_all()


@router.post("/gestures")
async def save_gesture(body: SaveGestureBody) -> dict[str, str]:
    data = _read_all()
    data[body.name] = body.definition.model_dump()
    _write_all(data)
    return {"status": "ok"}


@router.get("/gestures/export")
async def export_all_gestures() -> dict[str, Any]:
    data = _read_all()
    gestures_list: list[dict[str, Any]] = []
    for name, defn in data.items():
        g = dict(defn)
        g.setdefault("name", name)
        gestures_list.append(g)
    return {
        "version": _EXPORT_SCHEMA_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "gestures": gestures_list,
    }


@router.get("/gestures/{gesture_id}/export")
async def export_gesture(gesture_id: str) -> dict[str, Any]:
    data = _read_all()
    if gesture_id not in data:
        raise HTTPException(status_code=404, detail=f"Gesto '{gesture_id}' nao encontrado")
    g = dict(data[gesture_id])
    g.setdefault("name", gesture_id)
    return {
        "version": _EXPORT_SCHEMA_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "gestures": [g],
    }


@router.post("/gestures/import", response_model=ImportResult)
async def import_gestures(
    body: ImportBody,
    conflict_strategy: Literal["replace", "rename", "skip"] | None = Query(default=None),
) -> ImportResult:
    strategy = conflict_strategy or body.conflict_strategy
    data = _read_all()
    result = ImportResult()

    for raw_gesture in body.gestures:
        try:
            _validate_gesture(raw_gesture)
        except ValueError as exc:
            result.errors.append(str(exc))
            continue

        name = raw_gesture["name"]

        if name in data:
            if strategy == "skip":
                result.skipped.append(name)
                continue
            elif strategy == "rename":
                original_name = name
                suffix = 2
                while f"{name} ({suffix})" in data:
                    suffix += 1
                name = f"{name} ({suffix})"
                raw_gesture = dict(raw_gesture, name=name)
                result.renamed[original_name] = name
            # strategy == "replace" falls through

        data[name] = raw_gesture
        result.imported.append(name)

    if result.imported:
        _write_all(data)

    return result


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
