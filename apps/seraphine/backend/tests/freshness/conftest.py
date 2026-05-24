"""Pytest fixtures for freshness tests.

Provides an in-memory sqlite3 connection with:
 - Minimal seeds of the production tables freshness touches
   (seraphine_tasks, open_loops, facts) — just enough columns
 - The freshness migrator applied

Production schemas have MORE columns; the test seeds only need the
columns the freshness module reads/writes.
"""

import sqlite3
import pytest

from seraphine.freshness.schema import migrate as freshness_migrate


def _seed_reference_tables(conn: sqlite3.Connection) -> None:
    with conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS seraphine_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              due_date TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS open_loops (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              text TEXT NOT NULL,
              created_at TEXT NOT NULL,
              resolved_at TEXT,
              resolution TEXT,
              injection_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS facts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              statement TEXT NOT NULL,
              created_at TEXT NOT NULL,
              superseded_by INTEGER
            );
            """
        )


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    _seed_reference_tables(conn)
    freshness_migrate(conn)
    yield conn
    conn.close()
