"""Lab gesture persistence -- JSON file backed, no auth."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/lab", tags=["lab"])
logger = logging.getLogger(__name__)

# Resolve data dir relative to the project root (apps/seraphine/data/lab/).
_DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "lab"
_GESTURES_FILE = _DATA_DIR / "gestures.json"


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


@router.get("/gestures")
async def get_gestures() -> dict[str, Any]:
    return _read_all()


@router.post("/gestures")
async def save_gesture(body: SaveGestureBody) -> dict[str, str]:
    data = _read_all()
    data[body.name] = body.definition.model_dump()
    _write_all(data)
    return {"status": "ok"}
