from __future__ import annotations
from dataclasses import asdict
from typing import Any
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Literal
from llm_adapters.types import LLMUnavailableError

router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/engine")
async def engine_info(request: Request) -> dict[str, Any]:
    info = getattr(request.app.state, "engine_info", None)
    if info is None:
        return {"name": "unknown", "backend": "?", "model": "?", "is_local": False,
                "is_flat_cost": False, "supports_tools": False, "supports_vision": False}
    return asdict(info)


@router.get("/backends")
async def backends(request: Request) -> dict[str, Any]:
    llm = request.app.state.llm
    return {"selected": llm.selection}


class BackendSelection(BaseModel):
    backend: Literal["ollama", "claude", "codex"]


@router.post("/backend")
async def select_backend(payload: BackendSelection, request: Request) -> dict[str, Any]:
    llm = request.app.state.llm
    try:
        await llm.select(payload.backend, request.app.state.store)
    except (LLMUnavailableError, RuntimeError, OSError, TimeoutError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request.app.state.engine_info = llm.info
    return {"selected": llm.selection, "engine": asdict(llm.info)}
