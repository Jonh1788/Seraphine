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
import threading
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
        # One sqlite3.Connection per thread. Sharing a single connection
        # across the asyncio.to_thread executor pool corrupted result
        # sets — two simultaneous .execute().fetchone() calls would race
        # on the implicit cursor and one would return None. Per-thread
        # connections sidestep the issue entirely; SQLite WAL handles
        # multiple writer threads fine for our scale.
        self._tls = threading.local()
        self._conns: list[sqlite3.Connection] = []
        self._conns_lock = threading.Lock()
        # Insertion-ordered list of (name, migrator) so we can show what
        # ran in logs / debug output.
        self._migrators: list[tuple[str, Migrator]] = []

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        existing = getattr(self._tls, "conn", None)
        if existing is not None:
            return existing
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL lets read threads proceed while a writer holds the file —
        # important now that we open one connection per thread.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        self._tls.conn = conn
        with self._conns_lock:
            self._conns.append(conn)
        return conn

    async def aclose(self) -> None:
        with self._conns_lock:
            conns = list(self._conns)
            self._conns.clear()
        for c in conns:
            try:
                c.close()
            except Exception:
                pass
        # Drop the thread-local on the current thread; other threads'
        # locals will be GC'd with their threads.
        if hasattr(self._tls, "conn"):
            del self._tls.conn

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
