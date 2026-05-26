"""Lab gesture persistence -- JSON file backed, no auth."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter(prefix="/lab", tags=["lab"])
logger = logging.getLogger(__name__)

# Resolve data dir relative to the project root (apps/seraphine/data/lab/).
_DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "lab"
_GESTURES_FILE = _DATA_DIR / "gestures.json"

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
