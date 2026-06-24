"""Learning-loop tables (OpenJarvis #1). All idempotent."""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_trace (
            id TEXT PRIMARY KEY, ts TEXT NOT NULL, conversation_id TEXT,
            turn_id TEXT, user_msg TEXT, assistant_msg TEXT,
            tools_json TEXT, feature TEXT, signal REAL
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_trace_ts ON learning_trace(ts)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_eval_case (
            id TEXT PRIMARY KEY, ts TEXT NOT NULL, input_text TEXT NOT NULL,
            rubric TEXT NOT NULL, source_trace_id TEXT, active INTEGER DEFAULT 1
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_candidate (
            id TEXT PRIMARY KEY, ts TEXT NOT NULL,
            behavior_addendum TEXT, tool_guidance TEXT, knobs_json TEXT,
            baseline_score REAL, candidate_score REAL,
            status TEXT NOT NULL DEFAULT 'pending', rationale TEXT, base_version INTEGER
        )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_learning_candidate_status "
        "ON learning_candidate(status, ts)"
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_policy (
            version INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
            behavior_addendum TEXT, tool_guidance TEXT, knobs_json TEXT,
            from_candidate TEXT, active INTEGER DEFAULT 0
        )"""
    )
