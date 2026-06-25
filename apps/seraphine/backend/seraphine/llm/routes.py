from __future__ import annotations
from dataclasses import asdict
from typing import Any
from fastapi import APIRouter, Request

router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/engine")
async def engine_info(request: Request) -> dict[str, Any]:
    info = getattr(request.app.state, "engine_info", None)
    if info is None:
        return {"name": "unknown", "backend": "?", "model": "?", "is_local": False,
                "is_flat_cost": False, "supports_tools": False, "supports_vision": False}
    return asdict(info)
