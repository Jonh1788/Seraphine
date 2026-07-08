"""Service-level tests for ``DeepSearchService`` background runs.

The engine is monkeypatched with a fake (``_FakeEngine``) so no network /
LLM / tool calls happen — we exercise only the service's background-task
plumbing: ``start_run`` (persist a ``running`` row + spawn a task),
``_run_task`` (await the engine, persist ``done`` + report + sources),
``subscribe`` (snapshot + live drain ending in ``done``), ``get_run`` /
``list_runs``.

Store setup mirrors ``tests/deepsearch/test_registration.py``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from seraphine.deepsearch import schema as deepsearch_schema
from seraphine.deepsearch.service import DeepSearchService
from seraphine.memory.store import MemoryStore


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "deepsearch_svc.sqlite")
    s.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
    await s.ensure_schema()
    return s


class _FakeEngine:
    """Stand-in for ``DeepResearchEngine`` — emits a couple events, returns a
    fixed cited report. Constructed with ``(fanout=, synth=, tools=)``.
    """

    def __init__(self, *, fanout, synth, tools):
        self.fanout = fanout
        self.synth = synth
        self.tools = tools

    async def run(self, question, mode, *, emit):
        await _maybe_await(emit({"type": "query", "q": "q1"}))
        await _maybe_await(
            emit({"type": "source_found", "url": "u", "title": "t"})
        )
        report = "R [1]"
        sources = [{"url": "u", "title": "t", "n": 1}]
        await _maybe_await(
            emit({"type": "report", "markdown": report, "sources": sources})
        )
        await _maybe_await(emit({"type": "done", "status": "done"}))
        return {"report": report, "sources": sources, "status": "done"}


async def _maybe_await(value):
    if asyncio.iscoroutine(value):
        return await value
    return value


def _patch_engine(monkeypatch) -> None:
    monkeypatch.setattr(
        "seraphine.deepsearch.service.DeepResearchEngine", _FakeEngine
    )


def _make_service(store: MemoryStore) -> DeepSearchService:
    # ``llm``/``tools`` are unused by the fake engine; pass a tools object with
    # a ``.get`` so the dict-build line doesn't crash.
    class _Tools:
        def get(self, name):
            return object()

    return DeepSearchService(store, llm=object(), tools=_Tools(), settings=None)


async def _await_run(svc: DeepSearchService, run_id: str) -> None:
    task = svc._tasks.get(run_id)
    if task is not None:
        await task


@pytest.mark.asyncio
async def test_start_run_persists_running_then_done(store, monkeypatch):
    _patch_engine(monkeypatch)
    svc = _make_service(store)

    run_id = await svc.start_run("o que é X?", "quick")
    assert run_id.startswith("ds-")

    # A ``running`` row exists immediately after start.
    row = await svc.get_run(run_id)
    assert row is not None
    assert row["id"] == run_id
    assert row["query"] == "o que é X?"
    assert row["mode"] == "quick"
    assert row["status"] == "running"

    # Let the background task finish.
    await _await_run(svc, run_id)

    done = await svc.get_run(run_id)
    assert done["status"] == "done"
    assert done["report"] == "R [1]"
    assert done["sources"] == [{"url": "u", "title": "t", "n": 1}]
    assert done["finished_at"]


@pytest.mark.asyncio
async def test_subscribe_yields_events_ending_in_done(store, monkeypatch):
    _patch_engine(monkeypatch)
    svc = _make_service(store)

    run_id = await svc.start_run("pergunta?", "quick")

    events = []
    async for evt in svc.subscribe(run_id):
        events.append(evt)

    types = [e["type"] for e in events]
    assert types[0] == "snapshot"
    assert types[-1] == "done"


@pytest.mark.asyncio
async def test_subscribe_after_finish_yields_snapshot_and_done(store, monkeypatch):
    _patch_engine(monkeypatch)
    svc = _make_service(store)

    run_id = await svc.start_run("pergunta?", "quick")
    await _await_run(svc, run_id)
    # Queue removed; subscribe must not hang.

    events = []
    async for evt in svc.subscribe(run_id):
        events.append(evt)

    types = [e["type"] for e in events]
    assert types[0] == "snapshot"
    assert types[-1] == "done"
    snap = events[0]
    assert snap["status"] == "done"
    assert snap["report"] == "R [1]"


@pytest.mark.asyncio
async def test_list_runs_includes_started(store, monkeypatch):
    _patch_engine(monkeypatch)
    svc = _make_service(store)

    run_id = await svc.start_run("pergunta?", "quick")
    await _await_run(svc, run_id)

    runs = await svc.list_runs()
    ids = [r["id"] for r in runs]
    assert run_id in ids


@pytest.mark.asyncio
async def test_set_config_roundtrips(store, monkeypatch):
    svc = _make_service(store)

    await svc.set_config(
        fanout_model="cliproxy:claude-sonnet-4-6",
        synth_model="cliproxy:claude-opus-4-8",
        openrouter_key="sk-or-test",
    )
    cfg = await svc.get_config()
    assert cfg["fanout_model"] == "cliproxy:claude-sonnet-4-6"
    assert cfg["synth_model"] == "cliproxy:claude-opus-4-8"
    assert cfg["openrouter_key_set"] is True
    # Key is never returned.
    assert "openrouter_key" not in cfg

    # Updating without a key keeps the existing key.
    await svc.set_config(
        fanout_model="cliproxy:claude-haiku-4-5-20251001",
        synth_model="cliproxy:claude-opus-4-8",
    )
    cfg2 = await svc.get_config()
    assert cfg2["fanout_model"] == "cliproxy:claude-haiku-4-5-20251001"
    assert cfg2["openrouter_key_set"] is True


@pytest.mark.asyncio
async def test_deep_run_schedules_wiki_ingest(store, monkeypatch, tmp_path):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    _patch_engine(monkeypatch)
    seen = []

    async def _spy(run, s, l):
        seen.append(run.get("mode"))
        return []

    monkeypatch.setattr("seraphine.wiki.builder.ingest_deepsearch_run", _spy)
    svc = _make_service(store)
    run_id = await svc.start_run("q", "deep")
    await _await_run(svc, run_id)
    # drain the fire-and-forget ingest task(s) deterministically
    if svc._wiki_ingest_tasks:
        await asyncio.gather(*list(svc._wiki_ingest_tasks))
    assert seen == ["deep"]


@pytest.mark.asyncio
async def test_quick_run_does_not_schedule_wiki_ingest(store, monkeypatch, tmp_path):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    _patch_engine(monkeypatch)
    seen = []

    async def _spy(run, s, l):
        seen.append(run.get("mode"))
        return []

    monkeypatch.setattr("seraphine.wiki.builder.ingest_deepsearch_run", _spy)
    svc = _make_service(store)
    run_id = await svc.start_run("q", "quick")
    await _await_run(svc, run_id)
    if svc._wiki_ingest_tasks:
        await asyncio.gather(*list(svc._wiki_ingest_tasks))
    assert seen == []


@pytest.mark.asyncio
async def test_list_models_cliproxy_curated_no_key(store, monkeypatch):
    svc = _make_service(store)
    models = await svc.list_models()
    assert "cliproxy" in models and "openrouter" in models
    cliproxy_ids = [m["id"] for m in models["cliproxy"]]
    assert "cliproxy:claude-opus-4-8" in cliproxy_ids
    assert "cliproxy:claude-haiku-4-5-20251001" in cliproxy_ids
    # No OpenRouter key set -> empty list (no network).
    assert models["openrouter"] == []
