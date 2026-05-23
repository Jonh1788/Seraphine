"""HTTP routes for the CV triage feature.

Surfaces the worker (Task 11) to the Mac client. All routes operate on
the cv_triage_jobs / cv_triage_results tables defined in
:mod:`seraphine.cv_triage.schema` and dispatch the worker in the
background via ``asyncio.create_task``.

State acquisition: the routes prefer ``request.app.state.store`` /
``app.state.whatsapp_bridge_url`` / ``app.state.llm`` when the lifespan
has populated them (production); otherwise they fall back to a local
sqlite3 connection opened straight from ``settings.sqlite_path`` and the
env vars. This keeps the route layer testable without spinning up the
full ``lifespan``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from pydantic import BaseModel

from seraphine.config import settings

from . import storage
from .extraction import extract_with_fallback
from .models import JobStatus, WhatsAppStatus
from .ranking import rank_one
from .schema import migrate as cv_triage_migrate
from .whatsapp import DispatchPayload, DispatchPdf, dispatch_to_whatsapp
from .worker import WorkerDeps, request_cancel, run_cv_triage
from .broadcaster import broadcast_frame
from .zip_utils import ZipExtractionError, extract_pdfs_safely

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/cv_triage", tags=["cv_triage"])

_RUBRIC_MIN = 30
_MAX_ZIP_BYTES = 50 * 1024 * 1024  # 50 MiB
_TOP_N = 5

# Per-process flag so we only run the cv_triage migrator once when the
# routes open their own sqlite connection (test path with no lifespan).
_schema_ensured: set[str] = set()


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _data_dir() -> Path:
    """Where to stage extracted PDFs. Reads ``SERAPHINE_DATA_DIR`` if set,
    falling back to the directory that holds the SQLite file."""
    env = os.environ.get("SERAPHINE_DATA_DIR")
    if env:
        return Path(env)
    return Path(settings.sqlite_path).parent


def _bridge_url(request: Request) -> str:
    state_url = getattr(request.app.state, "whatsapp_bridge_url", None)
    return state_url or settings.whatsapp_bridge_url or ""


def _get_conn(request: Request) -> sqlite3.Connection:
    """Return a sqlite3.Connection with the cv_triage schema applied.

    Prefers ``app.state.store._connect()`` when available (production —
    the lifespan already registered + ran the migrator). Falls back to
    opening ``settings.sqlite_path`` directly when no store is present
    (unit-test path; ``TestClient`` doesn't run the lifespan).
    """
    store = getattr(request.app.state, "store", None)
    if store is not None:
        conn = store._connect()  # per-thread connection
        # The MemoryStore connection uses default tuple rows; cv_triage's
        # _row_to_* readers index by column name, so force Row mapping.
        conn.row_factory = sqlite3.Row
        return conn

    path = Path(settings.sqlite_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    key = str(path)
    if key not in _schema_ensured:
        cv_triage_migrate(conn)
        _schema_ensured.add(key)
    return conn


def _result_to_dict(r) -> dict[str, Any]:
    return {
        "id": r.id,
        "filename": r.filename,
        "candidate_name": r.candidate_name,
        "text_source": r.text_source.value,
        "text_chars": r.text_chars,
        "score": r.score,
        "match_pct": r.match_pct,
        "justification": r.justification,
        "strengths": r.strengths,
        "gaps": r.gaps,
        "status": r.status.value,
        "error": r.error,
        "ranked_at": r.ranked_at,
    }


def _job_to_dict(job, *, include_results: bool = False, results=None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": job.id,
        "conversation_id": job.conversation_id,
        "turn_id": job.turn_id,
        "status": job.status.value,
        "rubric": job.rubric,
        "target_chat_id": job.target_chat_id,
        "target_label": job.target_label,
        "total_cvs": job.total_cvs,
        "processed_cvs": job.processed_cvs,
        "ocr_used_count": job.ocr_used_count,
        "vision_used_count": job.vision_used_count,
        "unreadable": job.unreadable,
        "staging_dir": job.staging_dir,
        "top5_json": job.top5_json,
        "whatsapp_status": (
            job.whatsapp_status.value if job.whatsapp_status else None
        ),
        "error": job.error,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }
    if include_results:
        out["results"] = [_result_to_dict(r) for r in (results or [])]
    return out


def _build_summary(rubric: str, top: list, unreadable: int) -> str:
    """Same shape as worker._build_summary; duplicated here so /resend
    doesn't need to reach into worker internals."""
    lines = [
        f"*Triagem de CV — Top {len(top)}*",
        f"Vaga: {rubric[:200]}",
        "",
    ]
    for i, r in enumerate(top, start=1):
        name = r.get("candidate_name") or r.get("filename")
        score = r.get("score") or 0
        match = r.get("match_pct") or 0
        lines.append(
            f"*{i}. {name}* · score {score:.0f} · match {match:.0f}%"
        )
        if r.get("justification"):
            lines.append(f"   {r['justification']}")
    if unreadable:
        lines.append("")
        lines.append(f"{unreadable} CV(s) não puderam ser lidos.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# POST /cv_triage/jobs
# ---------------------------------------------------------------------------


@router.post("/jobs", status_code=201)
async def create_job(
    request: Request,
    zip: UploadFile = File(...),
    rubric: str = Form(...),
    target_chat_id: str = Form(...),
    target_label: str = Form(...),
) -> dict[str, Any]:
    # Validate rubric length.
    if len(rubric.strip()) < _RUBRIC_MIN:
        raise HTTPException(
            status_code=422,
            detail=f"rubric too short (min {_RUBRIC_MIN} chars)",
        )
    if not target_chat_id.strip():
        raise HTTPException(status_code=422, detail="target_chat_id is required")

    # Read the upload, capped at 50 MiB.
    zip_bytes = await zip.read()
    if len(zip_bytes) == 0:
        raise HTTPException(status_code=422, detail="empty zip upload")
    if len(zip_bytes) > _MAX_ZIP_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"zip too large ({len(zip_bytes)} > {_MAX_ZIP_BYTES})",
        )

    conn = _get_conn(request)

    # Pull conversation id from header (best effort — synthetic if absent).
    conv_header = request.headers.get("X-Conversation-Id")
    try:
        conversation_id = int(conv_header) if conv_header else 1
    except ValueError:
        conversation_id = 1

    # Create the job with a placeholder turn_id; we'll set turn_id := id once
    # we know the autoincrement value (1:1 mapping until a richer
    # conversation_turns table lands — see Task 12 design note).
    job_id = storage.create_job(
        conn,
        conversation_id=conversation_id,
        turn_id=0,
        rubric=rubric,
        target_chat_id=target_chat_id,
        target_label=target_label,
        staging_dir="",  # patched below
        created_at=_now(),
    )

    # Stage the zip and extract PDFs.
    staging_root = _data_dir() / "cv_triage" / str(job_id)
    try:
        staging_root.mkdir(parents=True, exist_ok=True)
        pdfs = extract_pdfs_safely(zip_bytes, staging_root)
    except ZipExtractionError as e:
        storage.update_status(
            conn,
            job_id,
            JobStatus.FAILED,
            error=f"zip extraction failed: {e}",
            finished_at=_now(),
        )
        raise HTTPException(status_code=422, detail=f"zip extraction failed: {e}")

    if not pdfs:
        storage.update_status(
            conn,
            job_id,
            JobStatus.FAILED,
            error="no PDFs found in upload",
            finished_at=_now(),
        )
        raise HTTPException(status_code=422, detail="no PDFs found in upload")

    # Patch staging_dir + turn_id := job_id now that we know it.
    with conn:
        conn.execute(
            "UPDATE cv_triage_jobs SET staging_dir=?, turn_id=? WHERE id=?",
            (str(staging_root), job_id, job_id),
        )

    # Dispatch the worker. Use vision_client + llm + ws_clients from
    # app.state when present; otherwise pass safe stubs (the route never
    # awaits the task — failures land in the DB).
    llm_client = getattr(request.app.state, "llm", None)
    vision_client = llm_client  # AnthropicClient exposes transcribe_image_pages
    ws_clients = getattr(request.app.state, "ws_clients", set())
    bridge_url = _bridge_url(request)

    async def _extract_fn(pdf_path: Path, *, vision_client=None):
        # Sync extraction must run off the event loop.
        return await asyncio.to_thread(
            extract_with_fallback, pdf_path, vision_client=vision_client
        )

    async def _broadcast_fn(frame: dict) -> None:
        await broadcast_frame(ws_clients, frame)

    deps = WorkerDeps(
        db=conn,
        bridge_url=bridge_url,
        llm_client=llm_client,
        vision_client=vision_client,
        extract_fn=_extract_fn,
        rank_fn=rank_one,
        broadcast_fn=_broadcast_fn,
    )
    asyncio.create_task(run_cv_triage(job_id, deps))

    return {"job_id": job_id, "turn_id": job_id}


# ---------------------------------------------------------------------------
# GET /cv_triage/jobs
# ---------------------------------------------------------------------------


@router.get("/jobs")
async def list_jobs(request: Request) -> list[dict[str, Any]]:
    """Return a flat ``JobSummary[]`` — matches the frontend's TypeScript
    contract and mirrors how ``GET /jobs/{id}`` returns the job dict
    directly (no wrapping envelope)."""
    conn = _get_conn(request)
    jobs = storage.list_jobs(conn)
    return [_job_to_dict(j) for j in jobs]


# ---------------------------------------------------------------------------
# GET /cv_triage/jobs/{job_id}
# ---------------------------------------------------------------------------


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: int) -> dict[str, Any]:
    conn = _get_conn(request)
    job = storage.get_job(conn, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    results = storage.list_results(conn, job_id)
    return _job_to_dict(job, include_results=True, results=results)


# ---------------------------------------------------------------------------
# POST /cv_triage/jobs/{job_id}/cancel
# ---------------------------------------------------------------------------


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(request: Request, job_id: int) -> dict[str, Any]:
    conn = _get_conn(request)
    job = storage.get_job(conn, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED):
        raise HTTPException(
            status_code=409, detail=f"job already terminal ({job.status.value})"
        )
    request_cancel(job_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# POST /cv_triage/jobs/{job_id}/resend
# ---------------------------------------------------------------------------


class ResendBody(BaseModel):
    target_chat_id: Optional[str] = None

    model_config = {"extra": "ignore"}


@router.post("/jobs/{job_id}/resend")
async def resend_job(
    request: Request,
    job_id: int,
    response: Response,
) -> dict[str, Any]:
    # Body is optional — read it manually so missing body doesn't 422.
    body: Optional[ResendBody] = None
    try:
        raw = await request.body()
        if raw:
            body = ResendBody.model_validate_json(raw)
    except Exception:
        body = None

    conn = _get_conn(request)
    job = storage.get_job(conn, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != JobStatus.DONE:
        raise HTTPException(
            status_code=409,
            detail=f"job not done yet (status={job.status.value})",
        )
    if not job.top5_json:
        raise HTTPException(
            status_code=409, detail="job has no top5 to resend"
        )

    try:
        top5 = json.loads(job.top5_json)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=409, detail="job top5_json is corrupt"
        )

    target = (body.target_chat_id if body and body.target_chat_id else job.target_chat_id)
    summary = _build_summary(job.rubric, top5, job.unreadable)
    staging = Path(job.staging_dir)

    payload = DispatchPayload(
        chat_id=target,
        summary=summary,
        pdfs=[
            DispatchPdf(
                rank=int(item.get("rank") or (i + 1)),
                candidate_name=item.get("candidate_name") or item.get("filename") or "",
                score=float(item.get("score") or 0),
                path=staging / item["filename"],
                filename=item["filename"],
            )
            for i, item in enumerate(top5)
        ],
    )

    result = await dispatch_to_whatsapp(
        payload,
        bridge_url=_bridge_url(request),
        sleep_between=0.5,
    )

    if result.text_sent and not result.failed_ranks:
        wa = WhatsAppStatus.ALL_SENT
    elif result.text_sent:
        wa = WhatsAppStatus.TEXT_SENT
    else:
        wa = WhatsAppStatus.FAILED

    storage.update_status(conn, job_id, JobStatus.DONE, whatsapp_status=wa)

    return {
        "ok": result.text_sent and not result.failed_ranks,
        "media_sent": result.media_sent,
        "failed_ranks": result.failed_ranks,
    }
