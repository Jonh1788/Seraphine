import sqlite3

from seraphine.deepsearch.schema import migrate


def test_migrate_creates_tables() -> None:
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    assert "deepsearch_runs" in tables
    assert "deepsearch_config" in tables
    # config seeded with a single row
    row = conn.execute(
        "SELECT fanout_model, synth_model FROM deepsearch_config WHERE id=1"
    ).fetchone()
    assert row is not None
    # idempotent
    migrate(conn)
