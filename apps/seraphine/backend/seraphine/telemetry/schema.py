from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_usage (
            id            TEXT PRIMARY KEY,
            ts            TEXT NOT NULL,
            backend       TEXT NOT NULL,
            model         TEXT NOT NULL,
            feature       TEXT NOT NULL DEFAULT 'chat',
            input_tokens  INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd      REAL NOT NULL DEFAULT 0.0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts)")
    # Teto mensal de custo. Linha única (`CHECK (id = 1)`): existe um orçamento,
    # não uma lista deles.
    #
    # `monthly_usd` é nullable DE PROPÓSITO. `NULL` = "nunca configurei" (a tela
    # convida a definir um teto); `0.0` = "não quero gastar nada" (qualquer
    # centavo já estourou). São estados diferentes e a tela reage diferente a
    # cada um — um `NOT NULL DEFAULT 0` aqui apagaria a distinção no ponto mais
    # difícil de recuperar.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telemetry_budget (
            id           INTEGER PRIMARY KEY CHECK (id = 1),
            monthly_usd  REAL
        )
        """
    )
    # `OR IGNORE`: `ensure_schema()` roda a cada boot: sem ele, todo restart
    # sobrescreveria o teto do usuário com NULL.
    conn.execute("INSERT OR IGNORE INTO telemetry_budget (id, monthly_usd) VALUES (1, NULL)")
