"""DAO functions for cv_triage jobs and results (raw sqlite3, transactional)."""

from __future__ import annotations

import json
import sqlite3

from .models import (
    Job,
    JobStatus,
    Result,
    ResultStatus,
    TextSource,
    WhatsAppStatus,
)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def create_job(
    conn: sqlite3.Connection,
    *,
    conversation_id: int,
    turn_id: int,
    rubric: str,
    target_chat_id: str,
    target_label: str,
    staging_dir: str,
    created_at: str,
) -> int:
    with conn:
        cur = conn.execute(
            """INSERT INTO cv_triage_jobs
               (conversation_id, turn_id, status, rubric, target_chat_id,
                target_label, staging_dir, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                conversation_id,
                turn_id,
                JobStatus.QUEUED.value,
                rubric,
                target_chat_id,
                target_label,
                staging_dir,
                created_at,
            ),
        )
    return int(cur.lastrowid or 0)


def get_job(conn: sqlite3.Connection, job_id: int) -> Job | None:
    row = conn.execute(
        "SELECT * FROM cv_triage_jobs WHERE id = ?", (job_id,)
    ).fetchone()
    if not row:
        return None
    return _row_to_job(row)


def list_jobs(conn: sqlite3.Connection, limit: int = 100) -> list[Job]:
    rows = conn.execute(
        "SELECT * FROM cv_triage_jobs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [_row_to_job(r) for r in rows]


def update_status(
    conn: sqlite3.Connection,
    job_id: int,
    status: JobStatus,
    *,
    error: str | None = None,
    whatsapp_status: WhatsAppStatus | None = None,
    finished_at: str | None = None,
    top5_json: str | None = None,
) -> None:
    fields: list[str] = ["status=?"]
    values: list = [status.value]
    if error is not None:
        fields.append("error=?")
        values.append(error)
    if whatsapp_status is not None:
        fields.append("whatsapp_status=?")
        values.append(whatsapp_status.value)
    if finished_at is not None:
        fields.append("finished_at=?")
        values.append(finished_at)
    if top5_json is not None:
        fields.append("top5_json=?")
        values.append(top5_json)
    values.append(job_id)
    with conn:
        conn.execute(
            f"UPDATE cv_triage_jobs SET {', '.join(fields)} WHERE id=?",
            values,
        )


def increment_counters(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    processed: int = 0,
    ocr: int = 0,
    vision: int = 0,
    unreadable: int = 0,
) -> None:
    with conn:
        conn.execute(
            """UPDATE cv_triage_jobs SET
               processed_cvs = processed_cvs + ?,
               ocr_used_count = ocr_used_count + ?,
               vision_used_count = vision_used_count + ?,
               unreadable = unreadable + ?
               WHERE id=?""",
            (processed, ocr, vision, unreadable, job_id),
        )


def set_total_cvs(conn: sqlite3.Connection, job_id: int, total: int) -> None:
    with conn:
        conn.execute(
            "UPDATE cv_triage_jobs SET total_cvs=? WHERE id=?",
            (total, job_id),
        )


def mark_active_jobs_failed_on_startup(
    conn: sqlite3.Connection, reason: str
) -> int:
    with conn:
        cur = conn.execute(
            """UPDATE cv_triage_jobs
               SET status='failed', error=?, finished_at=datetime('now')
               WHERE status IN ('queued','extracting','ranking','sending')""",
            (reason,),
        )
    return cur.rowcount


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def upsert_result(
    conn: sqlite3.Connection,
    *,
    job_id: int,
    filename: str,
    text_source: str,
    text_chars: int = 0,
    candidate_name: str | None = None,
    score: float | None = None,
    match_pct: float | None = None,
    justification: str | None = None,
    strengths: list[str] | None = None,
    gaps: list[str] | None = None,
    status: str = "pending",
    error: str | None = None,
    ranked_at: str | None = None,
) -> None:
    with conn:
        conn.execute(
            """INSERT INTO cv_triage_results
               (job_id, filename, candidate_name, text_source, text_chars, score,
                match_pct, justification, strengths, gaps, status, error, ranked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(job_id, filename) DO UPDATE SET
                 candidate_name=excluded.candidate_name,
                 text_source=excluded.text_source,
                 text_chars=excluded.text_chars,
                 score=excluded.score,
                 match_pct=excluded.match_pct,
                 justification=excluded.justification,
                 strengths=excluded.strengths,
                 gaps=excluded.gaps,
                 status=excluded.status,
                 error=excluded.error,
                 ranked_at=excluded.ranked_at""",
            (
                job_id,
                filename,
                candidate_name,
                text_source,
                text_chars,
                score,
                match_pct,
                justification,
                json.dumps(strengths or []),
                json.dumps(gaps or []),
                status,
                error,
                ranked_at,
            ),
        )


def get_top_n(conn: sqlite3.Connection, job_id: int, n: int) -> list[Result]:
    rows = conn.execute(
        """SELECT * FROM cv_triage_results
           WHERE job_id=? AND status='ranked'
           ORDER BY score DESC LIMIT ?""",
        (job_id, n),
    ).fetchall()
    return [_row_to_result(r) for r in rows]


def list_results(conn: sqlite3.Connection, job_id: int) -> list[Result]:
    rows = conn.execute(
        "SELECT * FROM cv_triage_results WHERE job_id=? "
        "ORDER BY score DESC NULLS LAST",
        (job_id,),
    ).fetchall()
    return [_row_to_result(r) for r in rows]


# ---------------------------------------------------------------------------
# Row mappers
# ---------------------------------------------------------------------------

def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        id=row["id"],
        conversation_id=row["conversation_id"],
        turn_id=row["turn_id"],
        status=JobStatus(row["status"]),
        rubric=row["rubric"],
        target_chat_id=row["target_chat_id"],
        target_label=row["target_label"],
        total_cvs=row["total_cvs"],
        processed_cvs=row["processed_cvs"],
        ocr_used_count=row["ocr_used_count"],
        vision_used_count=row["vision_used_count"],
        unreadable=row["unreadable"],
        staging_dir=row["staging_dir"],
        top5_json=row["top5_json"],
        whatsapp_status=(
            WhatsAppStatus(row["whatsapp_status"])
            if row["whatsapp_status"]
            else None
        ),
        error=row["error"],
        created_at=row["created_at"],
        finished_at=row["finished_at"],
    )


def _row_to_result(row: sqlite3.Row) -> Result:
    return Result(
        id=row["id"],
        job_id=row["job_id"],
        filename=row["filename"],
        candidate_name=row["candidate_name"],
        text_source=TextSource(row["text_source"]),
        text_chars=row["text_chars"],
        score=row["score"],
        match_pct=row["match_pct"],
        justification=row["justification"],
        strengths=json.loads(row["strengths"]) if row["strengths"] else [],
        gaps=json.loads(row["gaps"]) if row["gaps"] else [],
        status=ResultStatus(row["status"]),
        error=row["error"],
        ranked_at=row["ranked_at"],
    )
