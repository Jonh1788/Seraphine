"""Worker state-machine tests: extract → rank → send → done.

These tests substitute ``extract_fn`` and ``rank_fn`` with ``AsyncMock``s so
the pure-logic worker can be exercised without real PDFs or Anthropic calls.
The WhatsApp bridge is intercepted with ``respx``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
import respx

from seraphine.cv_triage import storage
from seraphine.cv_triage.models import JobStatus, WhatsAppStatus
from seraphine.cv_triage.worker import run_cv_triage, WorkerDeps


@pytest.mark.asyncio
@respx.mock
async def test_happy_path_3_cvs(db, tmp_path):
    staging = tmp_path / "cv_triage_1"
    staging.mkdir()
    for name in ["a.pdf", "b.pdf", "c.pdf"]:
        (staging / name).write_bytes(b"%PDF-1.4 fake")

    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="vaga py senior" + "x" * 40,
        target_chat_id="g@g.us",
        target_label="RH",
        staging_dir=str(staging),
        created_at=datetime.now(timezone.utc).isoformat(),
    )

    respx.post("http://bridge/api/send").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.post("http://bridge/api/send-media").mock(
        return_value=httpx.Response(200, json={"ok": True, "id": "X"})
    )

    from seraphine.cv_triage.extraction import ExtractionResult
    from seraphine.cv_triage.models import TextSource

    fake_extract = AsyncMock()
    fake_extract.side_effect = lambda p, *, vision_client=None: ExtractionResult(
        f"CV de {p.name} — desenvolvedor python senior. " * 30,
        TextSource.PDFPLUMBER,
    )

    from seraphine.cv_triage.ranking import ScoreResult

    fake_rank = AsyncMock()
    fake_rank.side_effect = lambda client, *, rubric, cv_text, model: ScoreResult(
        candidate_name=cv_text.split("—")[0].strip(),
        score=float(sum(ord(c) for c in cv_text[:50]) % 100),
        match_pct=80.0,
        strengths=["py"],
        gaps=["k8s"],
        justification="ok",
    )

    deps = WorkerDeps(
        db=db,
        bridge_url="http://bridge",
        llm_client=AsyncMock(),
        vision_client=None,
        extract_fn=fake_extract,
        rank_fn=fake_rank,
        broadcast_fn=AsyncMock(),
        rank_concurrency=2,
        sleep_between_media=0.0,
        sonnet_model="claude-sonnet-4-6",
    )

    await run_cv_triage(job_id, deps)

    job = storage.get_job(db, job_id)
    assert job.status == JobStatus.DONE
    assert job.processed_cvs == 3
    assert job.whatsapp_status == WhatsAppStatus.ALL_SENT
    top5 = storage.get_top_n(db, job_id, 5)
    assert len(top5) == 3
    assert top5[0].score >= top5[-1].score
    assert deps.broadcast_fn.await_count >= 3


@pytest.mark.asyncio
@respx.mock
async def test_bridge_offline_keeps_ranking_done_marks_wa_failed(db, tmp_path):
    staging = tmp_path / "s"
    staging.mkdir()
    (staging / "x.pdf").write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    respx.post("http://bridge/api/send").mock(return_value=httpx.Response(503))

    from seraphine.cv_triage.extraction import ExtractionResult
    from seraphine.cv_triage.models import TextSource
    from seraphine.cv_triage.ranking import ScoreResult

    deps = WorkerDeps(
        db=db,
        bridge_url="http://bridge",
        llm_client=AsyncMock(),
        vision_client=None,
        extract_fn=AsyncMock(
            side_effect=lambda p, *, vision_client=None: ExtractionResult(
                "ok " * 100, TextSource.PDFPLUMBER
            )
        ),
        rank_fn=AsyncMock(
            side_effect=lambda *a, **kw: ScoreResult("X", 50.0, 50.0, [], [], "ok")
        ),
        broadcast_fn=AsyncMock(),
        rank_concurrency=1,
        sleep_between_media=0.0,
        sonnet_model="m",
    )
    await run_cv_triage(job_id, deps)
    job = storage.get_job(db, job_id)
    assert job.status == JobStatus.DONE
    assert job.whatsapp_status == WhatsAppStatus.FAILED


@pytest.mark.asyncio
@respx.mock
async def test_cancel_during_extraction(db, tmp_path):
    staging = tmp_path / "s"
    staging.mkdir()
    for n in ["a.pdf", "b.pdf", "c.pdf"]:
        (staging / n).write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=datetime.now(timezone.utc).isoformat(),
    )

    from seraphine.cv_triage.worker import request_cancel
    from seraphine.cv_triage.extraction import ExtractionResult
    from seraphine.cv_triage.models import TextSource

    call_count = {"n": 0}

    async def slow_extract(p, *, vision_client=None):
        call_count["n"] += 1
        if call_count["n"] == 2:
            request_cancel(job_id)
        return ExtractionResult("ok " * 100, TextSource.PDFPLUMBER)

    deps = WorkerDeps(
        db=db,
        bridge_url="http://bridge",
        llm_client=AsyncMock(),
        vision_client=None,
        extract_fn=AsyncMock(side_effect=slow_extract),
        rank_fn=AsyncMock(),
        broadcast_fn=AsyncMock(),
        rank_concurrency=1,
        sleep_between_media=0.0,
        sonnet_model="m",
    )
    await run_cv_triage(job_id, deps)
    job = storage.get_job(db, job_id)
    assert job.status == JobStatus.CANCELLED
    assert call_count["n"] < 3


@pytest.mark.asyncio
@respx.mock
async def test_anthropic_5xx_one_cv_still_succeeds(db, tmp_path):
    staging = tmp_path / "s"
    staging.mkdir()
    for n in ["a.pdf", "b.pdf", "c.pdf"]:
        (staging / n).write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    respx.post("http://bridge/api/send").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.post("http://bridge/api/send-media").mock(
        return_value=httpx.Response(200, json={"ok": True, "id": "X"})
    )

    from seraphine.cv_triage.extraction import ExtractionResult
    from seraphine.cv_triage.models import TextSource
    from seraphine.cv_triage.ranking import ScoreResult

    async def maybe_fail_rank(client, *, rubric, cv_text, model):
        if "b.pdf" in cv_text:
            raise RuntimeError("anthropic 5xx persistent")
        return ScoreResult("X", 75.0, 75.0, [], [], "ok")

    deps = WorkerDeps(
        db=db,
        bridge_url="http://bridge",
        llm_client=AsyncMock(),
        vision_client=None,
        extract_fn=AsyncMock(
            side_effect=lambda p, *, vision_client=None: ExtractionResult(
                f"CV {p.name}: " + "x" * 300, TextSource.PDFPLUMBER
            )
        ),
        rank_fn=AsyncMock(side_effect=maybe_fail_rank),
        broadcast_fn=AsyncMock(),
        rank_concurrency=2,
        sleep_between_media=0.0,
        sonnet_model="m",
    )
    await run_cv_triage(job_id, deps)
    job = storage.get_job(db, job_id)
    assert job.status == JobStatus.DONE
    results = storage.list_results(db, job_id)
    statuses = sorted(r.status.value for r in results)
    assert statuses == ["failed", "ranked", "ranked"]
    top = storage.get_top_n(db, job_id, 5)
    assert len(top) == 2
