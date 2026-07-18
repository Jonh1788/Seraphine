"""Trilhas (gamified learning) tables. All idempotent."""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS course (
            id TEXT PRIMARY KEY, topic TEXT NOT NULL, title TEXT, description TEXT,
            status TEXT NOT NULL DEFAULT 'generating', source_ref TEXT,
            created_ts TEXT NOT NULL, meta_json TEXT
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS lesson (
            id TEXT PRIMARY KEY, course_id TEXT NOT NULL, order_idx INTEGER NOT NULL,
            title TEXT NOT NULL, concept_md TEXT, status TEXT NOT NULL DEFAULT 'ok'
        )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_lesson_course ON lesson(course_id, order_idx)"
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS exercise (
            id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, order_idx INTEGER NOT NULL,
            type TEXT NOT NULL, prompt TEXT NOT NULL, payload_json TEXT NOT NULL,
            explanation TEXT, concept_key TEXT
        )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_exercise_lesson ON exercise(lesson_id, order_idx)"
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS lesson_progress (
            lesson_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unlocked',
            best_score INTEGER DEFAULT 0, completed_ts TEXT
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_stats (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            xp_total INTEGER NOT NULL DEFAULT 0,
            streak_count INTEGER NOT NULL DEFAULT 0,
            streak_last_day TEXT
        )"""
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(course)").fetchall()}
    if "tutor_model" not in cols:
        conn.execute("ALTER TABLE course ADD COLUMN tutor_model TEXT")
    conn.commit()
