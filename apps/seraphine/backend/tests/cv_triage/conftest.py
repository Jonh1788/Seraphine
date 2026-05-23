"""Test fixtures for the cv_triage module."""

from __future__ import annotations

import sqlite3

import pytest

from seraphine.cv_triage.schema import migrate


@pytest.fixture
def db() -> sqlite3.Connection:
    """In-memory SQLite connection with cv_triage schema applied."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    # Enable FK enforcement so ON DELETE CASCADE works as documented.
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    try:
        yield conn
    finally:
        conn.close()
