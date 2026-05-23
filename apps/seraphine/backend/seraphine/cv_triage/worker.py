"""CV triage worker — drives a job from queued → done.

The worker is dispatched by the REST route (`POST /cv_triage/jobs`) via
`asyncio.create_task(run_cv_triage(job_id, deps))`. WorkerDeps carries
all the I/O surfaces (db, bridge URL, LLM client, extract/rank fns, ws
broadcast fn) so the worker stays pure-logic and easy to test.

Cancellation is cooperative: route handlers call `request_cancel(job_id)`
to set an in-memory flag; the worker checks it between phases and between
each PDF.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from . import storage
from .extraction import ExtractionResult
from .models import JobStatus, ResultStatus, TextSource, WhatsAppStatus
from .ranking import ScoreResult
from .whatsapp import DispatchPayload, DispatchPdf, dispatch_to_whatsapp

logger = logging.getLogger(__name__)

ExtractFn = Callable[..., Awaitable[ExtractionResult]]
RankFn = Callable[..., Awaitable[ScoreResult]]
BroadcastFn = Callable[[dict], Awaitable[None]]


@dataclass
class WorkerDeps:
    db: Any
    bridge_url: str
    llm_client: Any
    vision_client: Optional[Any]
    extract_fn: ExtractFn
    rank_fn: RankFn
    broadcast_fn: BroadcastFn
    rank_concurrency: int = 5
    sleep_between_media: float = 1.5
    sonnet_model: str = "claude-sonnet-4-6"


_TOP_N = 5
_cancel_flags: set[int] = set()


def request_cancel(job_id: int) -> None:
    """Mark ``job_id`` as cancelled. The worker checks this between phases."""
    _cancel_flags.add(job_id)


def _is_cancelled(job_id: int) -> bool:
    return job_id in _cancel_flags


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def run_cv_triage(job_id: int, deps: WorkerDeps) -> None:
    """Top-level entry point. Wraps :func:`_run` with terminal-state handling
    for cancellation and unexpected exceptions."""
    try:
        await _run(job_id, deps)
    except asyncio.CancelledError:
        storage.update_status(
            deps.db, job_id, JobStatus.CANCELLED, finished_at=_now()
        )
        # Do not re-raise: cancellation is a legitimate terminal state, not
        # a propagating error. (Tests await the coroutine and inspect state.)
    except Exception as e:  # noqa: BLE001 — final safety net
        logger.exception("cv_triage job %s failed", job_id)
        storage.update_status(
            deps.db,
            job_id,
            JobStatus.FAILED,
            error=str(e)[:1000],
            finished_at=_now(),
        )
    finally:
        _cancel_flags.discard(job_id)


async def _run(job_id: int, deps: WorkerDeps) -> None:
    job = storage.get_job(deps.db, job_id)
    if job is None:
        raise RuntimeError(f"job {job_id} not found")

    staging = Path(job.staging_dir)
    pdfs = sorted(p for p in staging.glob("*.pdf"))
    storage.set_total_cvs(deps.db, job_id, len(pdfs))
    storage.update_status(deps.db, job_id, JobStatus.EXTRACTING)
    await deps.broadcast_fn(
        {
            "type": "cv_triage_progress",
            "job_id": job_id,
            "phase": "extracting",
            "processed": 0,
            "total": len(pdfs),
            "ocr_used_count": 0,
            "vision_used_count": 0,
        }
    )

    # ---- Phase: extract ----
    extracted: dict[str, tuple[str, TextSource]] = {}
    for pdf in pdfs:
        if _is_cancelled(job_id):
            raise asyncio.CancelledError
        try:
            er = await deps.extract_fn(pdf, vision_client=deps.vision_client)
        except Exception as e:  # noqa: BLE001 — per-PDF failure is non-fatal
            er = ExtractionResult("", TextSource.NONE)
            logger.warning("extract failed %s: %s", pdf.name, e)

        if er.source == TextSource.NONE:
            storage.upsert_result(
                deps.db,
                job_id=job_id,
                filename=pdf.name,
                text_source=TextSource.NONE.value,
                text_chars=0,
                status=ResultStatus.FAILED.value,
                error="extraction failed",
            )
            storage.increment_counters(deps.db, job_id, processed=1, unreadable=1)
        else:
            storage.upsert_result(
                deps.db,
                job_id=job_id,
                filename=pdf.name,
                text_source=er.source.value,
                text_chars=len(er.text),
                status=ResultStatus.EXTRACTED.value,
            )
            extracted[pdf.name] = (er.text, er.source)
            inc: dict[str, int] = {"processed": 1}
            if er.source == TextSource.TESSERACT:
                inc["ocr"] = 1
            elif er.source == TextSource.VISION:
                inc["vision"] = 1
            storage.increment_counters(deps.db, job_id, **inc)

        job_now = storage.get_job(deps.db, job_id)
        await deps.broadcast_fn(
            {
                "type": "cv_triage_progress",
                "job_id": job_id,
                "phase": "extracting",
                "processed": job_now.processed_cvs,
                "total": job_now.total_cvs,
                "current_filename": pdf.name,
                "ocr_used_count": job_now.ocr_used_count,
                "vision_used_count": job_now.vision_used_count,
            }
        )

    # ---- Phase: rank ----
    if _is_cancelled(job_id):
        raise asyncio.CancelledError
    storage.update_status(deps.db, job_id, JobStatus.RANKING)
    sem = asyncio.Semaphore(deps.rank_concurrency)
    ranked_count = 0
    ranked_lock = asyncio.Lock()

    async def _rank_task(filename: str, text: str, source: TextSource) -> None:
        nonlocal ranked_count
        async with sem:
            if _is_cancelled(job_id):
                return
            try:
                score = await deps.rank_fn(
                    deps.llm_client,
                    rubric=job.rubric,
                    cv_text=text,
                    model=deps.sonnet_model,
                )
                storage.upsert_result(
                    deps.db,
                    job_id=job_id,
                    filename=filename,
                    candidate_name=score.candidate_name,
                    text_source=source.value,
                    text_chars=len(text),
                    score=score.score,
                    match_pct=score.match_pct,
                    justification=score.justification,
                    strengths=score.strengths,
                    gaps=score.gaps,
                    status=ResultStatus.RANKED.value,
                    ranked_at=_now(),
                )
            except Exception as e:  # noqa: BLE001 — per-CV ranking failure
                logger.warning("rank failed %s: %s", filename, e)
                storage.upsert_result(
                    deps.db,
                    job_id=job_id,
                    filename=filename,
                    text_source=source.value,
                    text_chars=len(text),
                    status=ResultStatus.FAILED.value,
                    error=str(e)[:500],
                )
        async with ranked_lock:
            ranked_count += 1
            await deps.broadcast_fn(
                {
                    "type": "cv_triage_progress",
                    "job_id": job_id,
                    "phase": "ranking",
                    "processed": ranked_count,
                    "total": len(extracted),
                }
            )

    await asyncio.gather(
        *[_rank_task(fn, tx, src) for fn, (tx, src) in extracted.items()]
    )

    # ---- Phase: send ----
    if _is_cancelled(job_id):
        raise asyncio.CancelledError
    storage.update_status(deps.db, job_id, JobStatus.SENDING)
    top = storage.get_top_n(deps.db, job_id, _TOP_N)
    job_for_summary = storage.get_job(deps.db, job_id)
    summary = _build_summary(job.rubric, job.target_label, top, job_for_summary)
    top5_json = json.dumps(
        [
            {
                "rank": i + 1,
                "filename": r.filename,
                "candidate_name": r.candidate_name,
                "score": r.score,
                "match_pct": r.match_pct,
                "strengths": r.strengths,
                "gaps": r.gaps,
                "justification": r.justification,
            }
            for i, r in enumerate(top)
        ]
    )
    storage.update_status(
        deps.db, job_id, JobStatus.SENDING, top5_json=top5_json
    )

    payload = DispatchPayload(
        chat_id=job.target_chat_id,
        summary=summary,
        pdfs=[
            DispatchPdf(
                rank=i + 1,
                candidate_name=r.candidate_name or r.filename,
                score=r.score or 0,
                path=staging / r.filename,
                filename=r.filename,
            )
            for i, r in enumerate(top)
        ],
    )
    dispatch = await dispatch_to_whatsapp(
        payload,
        bridge_url=deps.bridge_url,
        sleep_between=deps.sleep_between_media,
    )
    if dispatch.text_sent and not dispatch.failed_ranks:
        wa = WhatsAppStatus.ALL_SENT
    elif dispatch.text_sent:
        wa = WhatsAppStatus.TEXT_SENT
    else:
        wa = WhatsAppStatus.FAILED

    storage.update_status(
        deps.db,
        job_id,
        JobStatus.DONE,
        whatsapp_status=wa,
        finished_at=_now(),
    )
    final_job = storage.get_job(deps.db, job_id)
    await deps.broadcast_fn(
        {
            "type": "cv_triage_finished",
            "job_id": job_id,
            "top5": json.loads(top5_json),
            "whatsapp_status": wa.value,
            "unreadable": final_job.unreadable,
        }
    )


def _build_summary(
    rubric: str, target_label: str, top: list, job
) -> str:
    lines = [
        f"📄 *Triagem de CV — Top {len(top)}*",
        f"Vaga: {rubric[:200]}",
        "",
    ]
    for i, r in enumerate(top, start=1):
        name = r.candidate_name or r.filename
        score = r.score or 0
        match = r.match_pct or 0
        lines.append(
            f"*{i}. {name}* · score {score:.0f} · match {match:.0f}%"
        )
        if r.justification:
            lines.append(f"   {r.justification}")
    if job.unreadable:
        lines.append("")
        lines.append(f"⚠ {job.unreadable} CV(s) não puderam ser lidos.")
    return "\n".join(lines)
