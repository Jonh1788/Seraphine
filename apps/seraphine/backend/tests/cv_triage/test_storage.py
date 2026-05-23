"""Tests for the cv_triage SQLite storage DAO."""

from __future__ import annotations

from datetime import datetime, timezone

from seraphine.cv_triage import storage
from seraphine.cv_triage.models import JobStatus


def test_create_job_returns_id(db):
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=10,
        rubric="dev backend python",
        target_chat_id="55119@g.us",
        target_label="Time RH",
        staging_dir="/tmp/cv/1",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    assert isinstance(job_id, int) and job_id > 0
    job = storage.get_job(db, job_id)
    assert job.status == JobStatus.QUEUED
    assert job.rubric == "dev backend python"


def test_update_status_transitions(db):
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="1@c.us",
        target_label="A",
        staging_dir="/tmp/x",
        created_at="2026-05-23T10:00:00Z",
    )
    storage.update_status(db, job_id, JobStatus.EXTRACTING)
    assert storage.get_job(db, job_id).status == JobStatus.EXTRACTING


def test_upsert_result_and_top5(db):
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="1@c.us",
        target_label="A",
        staging_dir="/tmp/x",
        created_at="2026-05-23T10:00:00Z",
    )
    for i, score in enumerate([50, 80, 95, 70, 65, 90, 30], start=1):
        storage.upsert_result(
            db,
            job_id=job_id,
            filename=f"cv_{i}.pdf",
            text_source="pdfplumber",
            text_chars=500,
            candidate_name=f"Cand {i}",
            score=score,
            match_pct=score,
            justification="ok",
            strengths=["a"],
            gaps=["b"],
            status="ranked",
        )
    top5 = storage.get_top_n(db, job_id, 5)
    assert [r.score for r in top5] == [95, 90, 80, 70, 65]


def test_get_top_n_with_fewer_than_n_ranked(db):
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="1@c.us",
        target_label="A",
        staging_dir="/tmp/x",
        created_at="2026-05-23T10:00:00Z",
    )
    storage.upsert_result(
        db,
        job_id=job_id,
        filename="a.pdf",
        text_source="pdfplumber",
        text_chars=400,
        candidate_name="A",
        score=80,
        match_pct=80,
        justification="ok",
        strengths=[],
        gaps=[],
        status="ranked",
    )
    storage.upsert_result(
        db,
        job_id=job_id,
        filename="b.pdf",
        text_source="pdfplumber",
        text_chars=400,
        candidate_name="B",
        score=60,
        match_pct=60,
        justification="ok",
        strengths=[],
        gaps=[],
        status="ranked",
    )
    storage.upsert_result(
        db,
        job_id=job_id,
        filename="c.pdf",
        text_source="none",
        text_chars=0,
        status="failed",
        error="extraction failed",
    )
    top = storage.get_top_n(db, job_id, 5)
    assert len(top) == 2
    assert top[0].candidate_name == "A"


def test_mark_active_jobs_failed_on_startup(db):
    a = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="1@c.us",
        target_label="A",
        staging_dir="/tmp/x",
        created_at="2026-05-23T10:00:00Z",
    )
    storage.update_status(db, a, JobStatus.RANKING)
    b = storage.create_job(
        db,
        conversation_id=1,
        turn_id=2,
        rubric="x" * 40,
        target_chat_id="1@c.us",
        target_label="B",
        staging_dir="/tmp/y",
        created_at="2026-05-23T10:00:00Z",
    )
    storage.update_status(db, b, JobStatus.DONE, finished_at="2026-05-23T10:05:00Z")
    n = storage.mark_active_jobs_failed_on_startup(db, "interrupted_by_restart")
    assert n == 1
    job_a = storage.get_job(db, a)
    job_b = storage.get_job(db, b)
    assert job_a.status == JobStatus.FAILED
    assert "interrupted" in (job_a.error or "")
    assert job_b.status == JobStatus.DONE
