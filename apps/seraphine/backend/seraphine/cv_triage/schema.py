"""Schema migrator for cv_triage jobs/results (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS cv_triage_jobs (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL,
          turn_id         INTEGER NOT NULL,
          status          TEXT    NOT NULL,
          rubric          TEXT    NOT NULL,
          target_chat_id  TEXT    NOT NULL,
          target_label    TEXT    NOT NULL,
          total_cvs       INTEGER NOT NULL DEFAULT 0,
          processed_cvs   INTEGER NOT NULL DEFAULT 0,
          ocr_used_count  INTEGER NOT NULL DEFAULT 0,
          vision_used_count INTEGER NOT NULL DEFAULT 0,
          unreadable      INTEGER NOT NULL DEFAULT 0,
          staging_dir     TEXT    NOT NULL,
          top5_json       TEXT,
          whatsapp_status TEXT,
          error           TEXT,
          created_at      TEXT    NOT NULL,
          finished_at     TEXT
        );
        CREATE TABLE IF NOT EXISTS cv_triage_results (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id        INTEGER NOT NULL REFERENCES cv_triage_jobs(id) ON DELETE CASCADE,
          filename      TEXT    NOT NULL,
          candidate_name TEXT,
          text_source   TEXT    NOT NULL,
          text_chars    INTEGER NOT NULL DEFAULT 0,
          score         REAL,
          match_pct     REAL,
          justification TEXT,
          strengths     TEXT,
          gaps          TEXT,
          status        TEXT    NOT NULL,
          error         TEXT,
          ranked_at     TEXT,
          UNIQUE(job_id, filename)
        );
        CREATE INDEX IF NOT EXISTS idx_results_job_score
          ON cv_triage_results(job_id, score DESC);
        """
    )
