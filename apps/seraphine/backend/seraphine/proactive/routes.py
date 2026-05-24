"""040 — Scheduler inspector routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/proactive", tags=["proactive"])


@router.get("/jobs")
async def list_jobs(request: Request) -> dict[str, Any]:
    sched = getattr(request.app.state, "proactive_scheduler", None)
    if sched is None:
        raise HTTPException(status_code=503, detail="scheduler not running")
    jobs = sched.list_jobs()
    # Fetch last scheduler_run events to annotate.
    store = request.app.state.store
    events = await store.get_recent_events(limit=50, source="proactive")
    last_by_name: dict[str, dict[str, Any]] = {}
    for e in events:
        meta = e.get("metadata") or {}
        if isinstance(meta, str):
            import json as _j
            try:
                meta = _j.loads(meta)
            except Exception:
                meta = {}
        nm = meta.get("name")
        if nm and nm not in last_by_name:
            last_by_name[nm] = {
                "finished_at": meta.get("finished_at"),
                "ok": meta.get("ok"),
                "error": meta.get("error"),
            }
    for job in jobs:
        job["last_run"] = last_by_name.get(job["id"]) or last_by_name.get(job["name"])
    return {"jobs": jobs}


@router.post("/jobs/{name}/run")
async def run_job(name: str, request: Request) -> dict[str, Any]:
    sched = getattr(request.app.state, "proactive_scheduler", None)
    if sched is None:
        raise HTTPException(status_code=503, detail="scheduler not running")
    ok = await sched.run_job_now(name)
    if not ok:
        raise HTTPException(status_code=404, detail="job not found")
    return {"triggered": name}


@router.post("/jobs/{name}/pause")
async def pause_job(name: str, request: Request) -> dict[str, Any]:
    sched = getattr(request.app.state, "proactive_scheduler", None)
    if sched is None:
        raise HTTPException(status_code=503, detail="scheduler not running")
    ok = sched.set_job_paused(name, True)
    if not ok:
        raise HTTPException(status_code=404, detail="job not found")
    return {"paused": name}


@router.post("/jobs/{name}/resume")
async def resume_job(name: str, request: Request) -> dict[str, Any]:
    sched = getattr(request.app.state, "proactive_scheduler", None)
    if sched is None:
        raise HTTPException(status_code=503, detail="scheduler not running")
    ok = sched.set_job_paused(name, False)
    if not ok:
        raise HTTPException(status_code=404, detail="job not found")
    return {"resumed": name}
