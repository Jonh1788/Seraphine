"""Tests for the cv_triage TTL housekeeping job.

Per-status TTL policy:
- done / cancelled: 24h after finished_at
- failed: 7d after finished_at (longer for debug)

Metadata rows in cv_triage_jobs/results are *never* deleted by cleanup —
only the bulky on-disk staging directories are reclaimed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from seraphine.cv_triage import housekeeping, storage
from seraphine.cv_triage.models import JobStatus


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def test_housekeeping_deletes_old_done_dirs(db, tmp_path):
    staging = tmp_path / "old_done"
    staging.mkdir()
    (staging / "a.pdf").write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=_iso(datetime.now(timezone.utc) - timedelta(days=2)),
    )
    storage.update_status(
        db,
        job_id,
        JobStatus.DONE,
        finished_at=_iso(datetime.now(timezone.utc) - timedelta(hours=25)),
    )
    n = housekeeping.cleanup(db, base_dir=tmp_path, done_ttl_h=24, failed_ttl_h=24 * 7)
    assert n == 1
    assert not (staging / "a.pdf").exists()
    assert not staging.exists()


def test_housekeeping_preserves_fresh(db, tmp_path):
    staging = tmp_path / "fresh_done"
    staging.mkdir()
    (staging / "a.pdf").write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=_iso(datetime.now(timezone.utc)),
    )
    storage.update_status(
        db,
        job_id,
        JobStatus.DONE,
        finished_at=_iso(datetime.now(timezone.utc)),
    )
    n = housekeeping.cleanup(db, base_dir=tmp_path, done_ttl_h=24, failed_ttl_h=24 * 7)
    assert n == 0
    assert (staging / "a.pdf").exists()


def test_housekeeping_failed_jobs_longer_ttl(db, tmp_path):
    # Failed job, 3 days old — within 7d failed TTL, should be preserved.
    staging = tmp_path / "failed_recent"
    staging.mkdir()
    (staging / "a.pdf").write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=_iso(datetime.now(timezone.utc) - timedelta(days=3)),
    )
    storage.update_status(
        db,
        job_id,
        JobStatus.FAILED,
        error="x",
        finished_at=_iso(datetime.now(timezone.utc) - timedelta(days=3)),
    )
    n = housekeeping.cleanup(db, base_dir=tmp_path, done_ttl_h=24, failed_ttl_h=24 * 7)
    assert n == 0
    assert (staging / "a.pdf").exists()


def test_housekeeping_failed_jobs_old_enough_deleted(db, tmp_path):
    # Failed job, 8 days old — past 7d failed TTL, should be deleted.
    staging = tmp_path / "failed_old"
    staging.mkdir()
    (staging / "a.pdf").write_bytes(b"%PDF")
    job_id = storage.create_job(
        db,
        conversation_id=1,
        turn_id=1,
        rubric="x" * 40,
        target_chat_id="g@g.us",
        target_label="A",
        staging_dir=str(staging),
        created_at=_iso(datetime.now(timezone.utc) - timedelta(days=8)),
    )
    storage.update_status(
        db,
        job_id,
        JobStatus.FAILED,
        error="x",
        finished_at=_iso(datetime.now(timezone.utc) - timedelta(days=8)),
    )
    n = housekeeping.cleanup(db, base_dir=tmp_path, done_ttl_h=24, failed_ttl_h=24 * 7)
    assert n == 1
    assert not staging.exists()
