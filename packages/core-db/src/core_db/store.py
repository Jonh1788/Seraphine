"""Base SQLite Store with a pluggable migration registry.

Apps and modules register their schema migrators against the same Store
instance; ``ensure_schema()`` runs them in registration order.

Design goals:
- Single connection, lazily opened, reused (sqlite3 with check_same_thread=False).
- Modules don't import each other's tables — each owns its CREATE TABLE.
- Subclasses (e.g., Seraphine's MemoryStore) layer domain-specific CRUD
  on top while sharing the connection lifecycle and migration mechanics.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Callable

#: A migrator is a callable that receives an open sqlite3.Connection and
#: applies whatever DDL its module needs. Migrators must be idempotent —
#: ``CREATE TABLE IF NOT EXISTS`` and ALTER-with-try/except for column
#: additions on legacy DBs.
Migrator = Callable[[sqlite3.Connection], None]


class Store:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._conn: sqlite3.Connection | None = None
        # Insertion-ordered list of (name, migrator) so we can show what
        # ran in logs / debug output.
        self._migrators: list[tuple[str, Migrator]] = []

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.execute("PRAGMA foreign_keys = ON")
        self._conn = conn
        return conn

    async def aclose(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------
    # Migration registry
    # ------------------------------------------------------------------

    def register_migrator(self, name: str, migrator: Migrator) -> None:
        """Add a migrator that ``ensure_schema`` will invoke. Safe to call
        multiple times for the same name (later registration wins, useful
        for tests that swap implementations)."""
        self._migrators = [
            (n, m) for (n, m) in self._migrators if n != name
        ]
        self._migrators.append((name, migrator))

    def registered_migrators(self) -> list[str]:
        return [name for name, _ in self._migrators]

    async def ensure_schema(self) -> None:
        """Run every registered migrator inside one transaction."""

        def _work() -> None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = self._connect()
            with conn:
                for _name, migrator in self._migrators:
                    migrator(conn)

        await asyncio.to_thread(_work)
