import sqlite3

from seraphine.email_urgency import schema


def test_migrate_creates_table_and_is_idempotent():
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    schema.migrate(conn)  # idempotent — must not raise
    cols = {row[1] for row in conn.execute("PRAGMA table_info(email_urgency_seen)")}
    assert cols == {"message_id", "urgency", "reason", "alerted", "created_at"}
    # message_id is the primary key → duplicate insert is ignored
    conn.execute(
        "INSERT OR IGNORE INTO email_urgency_seen"
        "(message_id, urgency, reason, alerted, created_at) VALUES (?,?,?,?,?)",
        ("m1", "high", "x", 1, "t"),
    )
    conn.execute(
        "INSERT OR IGNORE INTO email_urgency_seen"
        "(message_id, urgency, reason, alerted, created_at) VALUES (?,?,?,?,?)",
        ("m1", "low", "y", 0, "t2"),
    )
    rows = conn.execute("SELECT urgency FROM email_urgency_seen WHERE message_id='m1'").fetchall()
    assert rows == [("high",)]
