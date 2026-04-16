"""Tests for FocusMusicService — taste heuristic + play_music delegation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.music.service import (
    DEFAULT_FOCUS_QUERY,
    FocusMusicService,
)
from seraphine.tools.base import ToolResult


class _StubRegistry:
    def __init__(self, tool: Any) -> None:
        self._tool = tool

    def get(self, name: str) -> Any:
        if name == "play_music":
            return self._tool
        return None


class _RecordingPlayTool:
    """Captures ``execute`` args and returns a canned ToolResult."""

    def __init__(self, result: ToolResult | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._result = result or ToolResult(
            ok=True,
            output="Tocando 'x'.",
            metadata={"query": "x", "url": "https://music.youtube.com/watch?v=abc"},
        )

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        self.calls.append(args)
        return self._result


@pytest.mark.asyncio
async def test_default_query_when_no_taste_facts(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music1.sqlite")
    await store.ensure_schema()
    tool = _RecordingPlayTool()
    svc = FocusMusicService(store=store, registry=_StubRegistry(tool))

    query = await svc.suggest_focus_query()
    assert query == DEFAULT_FOCUS_QUERY


@pytest.mark.asyncio
async def test_artist_fact_drives_query(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music2.sqlite")
    await store.ensure_schema()
    await store.add_fact(
        text="Usuário gosta do artista Djavan.",
        source="user_taught",
        confidence=0.9,
    )
    svc = FocusMusicService(store=store, registry=_StubRegistry(_RecordingPlayTool()))

    query = await svc.suggest_focus_query()
    assert "Djavan" in query
    assert "focus" in query.lower()


@pytest.mark.asyncio
async def test_song_artist_fact_drives_query(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music3.sqlite")
    await store.ensure_schema()
    await store.add_fact(
        text="Usuário gosta de 'Evidências' de Chitãozinho e Xororó.",
        source="user_taught",
        confidence=0.9,
    )
    svc = FocusMusicService(store=store, registry=_StubRegistry(_RecordingPlayTool()))

    query = await svc.suggest_focus_query()
    assert "Chitãozinho" in query or "Xororó" in query


@pytest.mark.asyncio
async def test_genre_fact_drives_query(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music4.sqlite")
    await store.ensure_schema()
    await store.add_fact(
        text="Usuário curte bossa nova.",
        source="user_taught",
        confidence=0.9,
    )
    svc = FocusMusicService(store=store, registry=_StubRegistry(_RecordingPlayTool()))

    query = await svc.suggest_focus_query()
    assert "bossa nova" in query.lower()
    assert "playlist" in query.lower() or "focus" in query.lower()


@pytest.mark.asyncio
async def test_dislike_facts_are_skipped(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music5.sqlite")
    await store.ensure_schema()
    # Newest-first: dislike lands on top, positive fact below.
    await store.add_fact(
        text="Usuário curte jazz.",
        source="user_taught",
        confidence=0.9,
    )
    await store.add_fact(
        text="Usuário não curte funk",
        source="user_taught",
        confidence=0.9,
    )
    svc = FocusMusicService(store=store, registry=_StubRegistry(_RecordingPlayTool()))

    query = await svc.suggest_focus_query()
    assert "funk" not in query.lower()
    assert "jazz" in query.lower()


@pytest.mark.asyncio
async def test_non_taste_source_ignored(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music6.sqlite")
    await store.ensure_schema()
    # Different source must be filtered out even if it contains "gosta".
    await store.add_fact(
        text="Usuário gosta do artista FakeBand.",
        source="reflection",
        confidence=0.9,
    )
    svc = FocusMusicService(store=store, registry=_StubRegistry(_RecordingPlayTool()))
    query = await svc.suggest_focus_query()
    assert "FakeBand" not in query
    assert query == DEFAULT_FOCUS_QUERY


@pytest.mark.asyncio
async def test_start_focus_music_invokes_play_tool(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music7.sqlite")
    await store.ensure_schema()
    await store.add_fact(
        text="Usuário curte lofi",
        source="user_taught",
        confidence=0.9,
    )
    tool = _RecordingPlayTool(
        ToolResult(
            ok=True,
            output="ok",
            metadata={"music_card": {"title": "t", "artist": "", "album_art": "", "is_playing": True, "url": "u"}},
        )
    )
    svc = FocusMusicService(store=store, registry=_StubRegistry(tool))

    result = await svc.start_focus_music()
    assert len(tool.calls) == 1
    assert "lofi" in tool.calls[0]["query"].lower()
    assert result["ok"] is True
    assert result["query"] == tool.calls[0]["query"]
    assert "music_card" in result["metadata"]


@pytest.mark.asyncio
async def test_start_focus_music_missing_tool_returns_soft_failure(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "music8.sqlite")
    await store.ensure_schema()

    class _EmptyRegistry:
        def get(self, name: str) -> Any:
            return None

    svc = FocusMusicService(store=store, registry=_EmptyRegistry())
    result = await svc.start_focus_music()
    assert result["ok"] is False
    assert result["query"]  # still returns a sensible default
