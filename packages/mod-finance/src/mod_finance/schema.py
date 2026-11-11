"""Schema migrator for mod-finance.

Owns ``financial_entries``, ``recurring_rules`` and ``card_invoices``
tables. Idempotent: new DBs get the full schema in CREATE TABLE; legacy
DBs get the columns added since they were created (``user_id``,
``invoice_id``, ``source_hash``, ``previous_balance``,
``payments_total``) via ALTER, which is a no-op when the column is
already there. ``card_invoices`` is created before
``financial_entries`` because the latter references it. Indexes are
created last so they can reference newly-added columns.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    # Step 1: create tables if missing — full schema for fresh DBs.
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS recurring_rules (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          amount        REAL NOT NULL,
          category      TEXT NOT NULL,
          description   TEXT NOT NULL,
          day_of_month  INTEGER,
          frequency     TEXT NOT NULL CHECK (frequency IN ('monthly', 'weekly', 'custom')),
          start_date    TEXT NOT NULL,
          end_date      TEXT,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          user_id       TEXT
        );

        CREATE TABLE IF NOT EXISTS card_invoices (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          card          TEXT NOT NULL,
          closing_date  TEXT,
          due_date      TEXT,
          paid_date     TEXT,
          total         REAL,
          status        TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'paid', 'needs_review')),
          -- O saldo que a fatura ja trazia e a soma dos pagamentos do
          -- periodo, LIDOS do PDF. NULL = nao foi possivel ler; 0.0 = leu e
          -- era zero (primeira fatura do cartao). Os dois casos nao podem
          -- ser confundidos: e a diferenca entre "nao sei" e "esta certo".
          previous_balance REAL,
          payments_total   REAL,
          created_at    TEXT NOT NULL,
          user_id       TEXT,
          -- A identidade do arquivo que criou a fatura (sha256 dos bytes do
          -- PDF). É o único campo aqui que não foi LIDO pelo LLM, e por isso
          -- é o único em que o reencontro pode confiar sem testemunha: o
          -- vencimento, o fechamento e o total são leituras, e duas leituras
          -- do mesmo documento discordam. NULL para fatura criada à mão.
          source_hash   TEXT
        );

        CREATE TABLE IF NOT EXISTS financial_entries (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          amount        REAL NOT NULL,
          currency      TEXT NOT NULL DEFAULT 'BRL',
          category      TEXT NOT NULL,
          description   TEXT NOT NULL,
          date          TEXT NOT NULL,
          source        TEXT NOT NULL,
          recurring_id  INTEGER REFERENCES recurring_rules(id),
          status        TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending_review')),
          created_at    TEXT NOT NULL,
          user_id       TEXT,
          invoice_id    INTEGER REFERENCES card_invoices(id)
        );
        """
    )
    # Step 2: idempotent ADD COLUMN for legacy DBs.
    for ddl in (
        "ALTER TABLE financial_entries ADD COLUMN user_id TEXT",
        "ALTER TABLE recurring_rules ADD COLUMN user_id TEXT",
        "ALTER TABLE financial_entries ADD COLUMN invoice_id INTEGER"
        " REFERENCES card_invoices(id)",
        "ALTER TABLE card_invoices ADD COLUMN source_hash TEXT",
        "ALTER TABLE card_invoices ADD COLUMN previous_balance REAL",
        "ALTER TABLE card_invoices ADD COLUMN payments_total REAL",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    # Step 3: indexes — safe now.
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_entries_date
          ON financial_entries(date);
        CREATE INDEX IF NOT EXISTS idx_entries_category
          ON financial_entries(category);
        CREATE INDEX IF NOT EXISTS idx_entries_type
          ON financial_entries(type);
        CREATE INDEX IF NOT EXISTS idx_entries_user
          ON financial_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_recurring_user
          ON recurring_rules(user_id);
        CREATE INDEX IF NOT EXISTS idx_invoices_source_hash
          ON card_invoices(source_hash);
        """
    )
