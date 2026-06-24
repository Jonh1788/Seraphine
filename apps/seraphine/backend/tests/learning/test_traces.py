"""Tests for fire-and-forget interaction-trace capture (learning loop, Task 2)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from core_db import Store

from seraphine.learning import schema as learning_schema
from seraphine.learning.traces import derive_signal, record_trace, recent_traces


def _make_store(tmp_path: Path, name: str = "traces.sqlite") -> Store:
    store = Store(tmp_path / name)
    store.register_migrator("learning", learning_schema.migrate)
    asyncio.run(store.ensure_schema())
    return store


@pytest.mark.parametrize(
    "reaction,expected",
    [
        ("up", 1.0),
        ("thumbs_up", 1.0),
        ("positive", 1.0),
        ("good", 1.0),
        ("\U0001f44d", 1.0),
        ("down", 0.0),
        ("thumbs_down", 0.0),
        ("negative", 0.0),
        ("bad", 0.0),
        ("\U0001f44e", 0.0),
        ("UP", 1.0),  # case-insensitive
        ("  up  ", 1.0),  # whitespace tolerant
        ("weird", None),
        ("", None),
        (None, None),
    ],
)
def test_derive_signal(reaction, expected):
    assert derive_signal(reaction) == expected


def test_record_and_read(tmp_path: Path):
    store = _make_store(tmp_path)
    asyncio.run(
        record_trace(
            store,
            conversation_id="c1",
            turn_id="t1",
            user_msg="oi",
            assistant_msg="olá",
            tools=["recall"],
            signal=1.0,
        )
    )
    rows = asyncio.run(recent_traces(store, limit=10))
    assert len(rows) == 1
    row = rows[0]
    assert row["conversation_id"] == "c1"
    assert row["turn_id"] == "t1"
    assert row["user_msg"] == "oi"
    assert row["assistant_msg"] == "olá"
    assert row["tools_json"] == '["recall"]'
    assert row["feature"] == "chat"
    assert row["signal"] == 1.0


def test_record_swallows_errors():
    class _Broken:
        def _connect(self):
            raise RuntimeError("boom")

    # Must not raise even though the store is broken.
    asyncio.run(
        record_trace(
            _Broken(),
            conversation_id=None,
            turn_id=None,
            user_msg="x",
            assistant_msg="y",
        )
    )


def test_prefer_low_signal_orders(tmp_path: Path):
    store = _make_store(tmp_path)
    asyncio.run(
        record_trace(
            store,
            conversation_id="c0",
            turn_id="t0",
            user_msg="zero",
            assistant_msg="a",
            signal=0.0,
        )
    )
    asyncio.run(
        record_trace(
            store,
            conversation_id="cN",
            turn_id="tN",
            user_msg="none",
            assistant_msg="b",
            signal=None,
        )
    )
    rows = asyncio.run(recent_traces(store, limit=10, prefer_low_signal=True))
    assert len(rows) == 2
    # prefer_low_signal sorts NULL/unknown signal first (lowest-confidence
    # traces are the ones worth labeling), then by signal ASC. Asserting the
    # exact placement proves the custom ORDER BY ran rather than the default
    # ts DESC fallback.
    signals = [r["signal"] for r in rows]
    assert signals == [None, 0.0]
