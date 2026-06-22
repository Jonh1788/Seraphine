import sqlite3
from seraphine.memory.store import _seraphine_flashcards_v2_migrator


def _base(conn):
    conn.execute(
        "CREATE TABLE flashcards (id TEXT PRIMARY KEY, topic TEXT, front TEXT,"
        " back TEXT, interval_days INTEGER, ease REAL, reps INTEGER,"
        " last_reviewed_at TEXT, next_due_at TEXT, created_at TEXT)"
    )


def test_migrator_adds_columns_idempotently():
    conn = sqlite3.connect(":memory:")
    _base(conn)
    _seraphine_flashcards_v2_migrator(conn)
    _seraphine_flashcards_v2_migrator(conn)  # idempotent — must not raise
    cols = {r[1] for r in conn.execute("PRAGMA table_info(flashcards)")}
    assert {"tags", "source_url", "source_title", "image_url"} <= cols


def test_existing_rows_get_defaults():
    conn = sqlite3.connect(":memory:")
    _base(conn)
    conn.execute(
        "INSERT INTO flashcards (id, topic, front, back, interval_days, ease,"
        " reps, next_due_at, created_at) VALUES ('c1','t','f','b',1,2.5,0,'n','n')"
    )
    _seraphine_flashcards_v2_migrator(conn)
    row = conn.execute("SELECT tags, source_url, image_url FROM flashcards WHERE id='c1'").fetchone()
    assert row == ("[]", None, None)
