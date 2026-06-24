from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from seraphine.learning.knobs import knob_registry
from seraphine.learning.traces import recent_traces

router = APIRouter(prefix="/learning", tags=["learning"])


def _svc(request: Request):
    svc = getattr(request.app.state, "learning_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="learning service not running")
    return svc


@router.get("/active")
async def active_policy(request: Request) -> dict[str, Any]:
    return await _svc(request).get_active_policy()


@router.get("/knobs")
async def knobs(request: Request) -> list[dict[str, Any]]:
    return knob_registry()


@router.get("/candidates")
async def candidates(
    request: Request, status: str | None = None, limit: int = 50
) -> list[dict[str, Any]]:
    return await _svc(request).list_candidates(status=status, limit=limit)


@router.get("/candidates/{cid}")
async def candidate(cid: str, request: Request) -> dict[str, Any]:
    c = await _svc(request).get_candidate(cid)
    if c is None:
        raise HTTPException(status_code=404, detail="candidate not found")
    return c


@router.post("/candidates/{cid}/promote")
async def promote(cid: str, request: Request) -> dict[str, Any]:
    try:
        version = await _svc(request).promote(cid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"version": version}


@router.post("/candidates/{cid}/reject")
async def reject(cid: str, request: Request) -> dict[str, Any]:
    await _svc(request).reject(cid)
    return {"ok": True}


@router.get("/traces")
async def traces(request: Request, limit: int = 50) -> list[dict[str, Any]]:
    svc = _svc(request)
    return await recent_traces(svc.store, limit=limit)


@router.post("/run")
async def run(request: Request) -> dict[str, Any]:
    return await _svc(request).run_cycle()
