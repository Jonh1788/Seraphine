import sqlite3

from seraphine.courses.schema import migrate


def test_migrate_creates_tables():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert {"course", "lesson", "exercise", "lesson_progress", "learning_stats"} <= names


def test_migrate_is_idempotent():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    migrate(conn)  # must not raise
    cols = {r[1] for r in conn.execute("PRAGMA table_info(exercise)").fetchall()}
    assert {"id", "lesson_id", "order_idx", "type", "prompt", "payload_json",
            "explanation", "concept_key"} <= cols
