"""TTL cleanup of cv_triage staging directories.

Run daily by the apscheduler. Removes on-disk staging dirs for jobs whose
finished_at is older than the per-status TTL. Metadata rows in
cv_triage_jobs/results stay — only bulky PDF/zip files are reclaimed.

Per-status TTL policy:
- done / cancelled: 24h after finished_at
- failed: 7d after finished_at (longer for debug)
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


def cleanup(
    conn: sqlite3.Connection,
    *,
    base_dir: Path,
    done_ttl_h: int = 24,
    failed_ttl_h: int = 7 * 24,
) -> int:
    """Remove staging dirs for jobs past their TTL.

    Returns the number of staging directories actually removed. Failures
    (permission errors, race conditions) are logged but do not abort the
    sweep — the next daily run will retry whatever still lingers.
    """
    now = datetime.now(timezone.utc)
    rows = conn.execute(
        """SELECT id, status, staging_dir, finished_at
           FROM cv_triage_jobs
           WHERE finished_at IS NOT NULL"""
    ).fetchall()
    removed = 0
    for r in rows:
        # Tolerate both sqlite3.Row and tuple cursors.
        if hasattr(r, "keys"):
            status = r["status"]
            staging_dir = r["staging_dir"]
            finished_str = r["finished_at"]
        else:
            status = r[1]
            staging_dir = r[2]
            finished_str = r[3]
        if not finished_str or not staging_dir:
            continue
        # Tolerate "...Z" and "+00:00" suffixes.
        finished = datetime.fromisoformat(finished_str.replace("Z", "+00:00"))
        if finished.tzinfo is None:
            finished = finished.replace(tzinfo=timezone.utc)
        ttl_h = failed_ttl_h if status == "failed" else done_ttl_h
        if now - finished < timedelta(hours=ttl_h):
            continue
        staging = Path(staging_dir)
        if staging.exists():
            try:
                shutil.rmtree(staging, ignore_errors=False)
                removed += 1
                logger.info("cv_triage.housekeeping removed %s", staging)
            except Exception as e:
                logger.warning(
                    "cv_triage.housekeeping failed to remove %s: %s", staging, e
                )
    return removed
