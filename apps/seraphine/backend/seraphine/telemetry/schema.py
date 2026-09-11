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
    # Cache de prompt. Colunas SEPARADAS de propósito: escrita custa 1,25x do
    # preço de entrada e leitura 0,1x, então somar as duas apagaria justamente
    # a distinção que diz se o cache está pagando ou custando.
    #
    # Não saem de `input_tokens`: na semântica OpenAI que o OpenRouter
    # normaliza, `prompt_tokens` já é o total e o cache é um subconjunto dele.
    #
    # Aditivo em banco existente: `ensure_schema()` roda a cada boot e a
    # tabela já existe em produção. `ALTER TABLE ADD COLUMN` repetido levanta
    # OperationalError de coluna duplicada — engolimos, como em journal/schema.
    for ddl in (
        "ALTER TABLE llm_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE llm_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # coluna já existe
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
