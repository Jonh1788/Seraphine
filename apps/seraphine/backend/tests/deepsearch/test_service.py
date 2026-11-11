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
import time
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


@pytest.mark.asyncio
async def test_list_models_openrouter_is_not_truncated(store, monkeypatch):
    """O catálogo inteiro chega ao picker — sem teto.

    Regressão de 2026-08-02: havia um ``[:80]`` aplicado DEPOIS do sort por
    nome, então o usuário via os 80 primeiros em ordem alfabética e os demais
    ~320 modelos simplesmente não existiam na UI — sem nenhum aviso de que a
    lista estava cortada. A fixture usa nomes ``m000``..``m299`` de propósito:
    com o teto de volta, ``m299`` some e o teste quebra.
    """
    total = 300
    catalogo = [
        {"id": f"vendor/m{i:03d}", "name": f"m{i:03d}"} for i in range(total)
    ]

    class _FakeOR:
        def __init__(self, key):
            self.key = key

        async def list_models(self):
            return catalogo

    monkeypatch.setattr(
        "seraphine.deepsearch.service.OpenRouterClient", _FakeOR
    )
    svc = _make_service(store)
    await svc.set_config(
        fanout_model="cliproxy", synth_model="cliproxy", openrouter_key="sk-or-x"
    )

    models = await svc.list_models()
    assert len(models["openrouter"]) == total

    ids = [m["id"] for m in models["openrouter"]]
    # O primeiro e o ÚLTIMO do alfabeto: o teto antigo levava exatamente o
    # segundo (e tudo depois de "m079").
    assert "openrouter:vendor/m000" in ids
    assert "openrouter:vendor/m299" in ids
    # Ordenado por nome, e todo id sai com um único prefixo `openrouter:`.
    assert ids == sorted(ids)
    assert all(not i.startswith("openrouter:openrouter:") for i in ids)


# ---------------------------------------------------------------------------
# Cache do catálogo do OpenRouter
#
# Sem cache, toda montagem de picker (são quatro no app) baixa os metadados de
# ~400 modelos para extrair id+nome. Estes testes prendem as três propriedades
# que fazem o cache valer a pena e não virar armadilha: ele economiza fetch,
# expira, e não transforma uma falha de rede em "catálogo vazio".
# ---------------------------------------------------------------------------


class _ORContador:
    """Cliente falso que conta requisições — e pode falhar sob comando."""

    chamadas = 0
    falhar = False
    catalogo: list[dict[str, str]] = [{"id": "vendor/a", "name": "A"}]

    def __init__(self, key):
        self.key = key

    async def list_models(self):
        type(self).chamadas += 1
        if type(self).falhar:
            raise RuntimeError("boom")
        return list(type(self).catalogo)


@pytest.fixture
def or_contador(monkeypatch):
    _ORContador.chamadas = 0
    _ORContador.falhar = False
    _ORContador.catalogo = [{"id": "vendor/a", "name": "A"}]
    monkeypatch.setattr(
        "seraphine.deepsearch.service.OpenRouterClient", _ORContador
    )
    return _ORContador


async def _com_chave(svc, key="sk-or-x"):
    await svc.set_config(
        fanout_model="cliproxy", synth_model="cliproxy", openrouter_key=key
    )


@pytest.mark.asyncio
async def test_openrouter_catalog_is_cached_between_calls(store, or_contador):
    svc = _make_service(store)
    await _com_chave(svc)

    primeira = await svc.list_models()
    segunda = await svc.list_models()

    assert or_contador.chamadas == 1
    assert segunda["openrouter"] == primeira["openrouter"]


@pytest.mark.asyncio
async def test_concurrent_pickers_share_a_single_fetch(store, or_contador):
    """Quatro pickers montando juntos = UMA requisição, não quatro.

    É o caso real: abrir os Ajustes monta o picker do chat enquanto a Pesquisa
    já montou fan-out e síntese.
    """
    svc = _make_service(store)
    await _com_chave(svc)

    resultados = await asyncio.gather(*(svc.list_models() for _ in range(4)))

    assert or_contador.chamadas == 1
    assert all(r["openrouter"] == resultados[0]["openrouter"] for r in resultados)


@pytest.mark.asyncio
async def test_cache_expires_and_picks_up_new_models(store, or_contador, monkeypatch):
    svc = _make_service(store)
    await _com_chave(svc)

    assert [m["id"] for m in (await svc.list_models())["openrouter"]] == [
        "openrouter:vendor/a"
    ]

    # Passa o relógio além do TTL e publica um modelo novo: um catálogo que
    # nunca revalida seria pior que a lista truncada que acabamos de remover.
    or_contador.catalogo = [
        {"id": "vendor/a", "name": "A"},
        {"id": "vendor/b", "name": "B"},
    ]
    relogio = time.monotonic() + 601.0
    monkeypatch.setattr(
        "seraphine.deepsearch.service.time.monotonic", lambda: relogio
    )

    ids = [m["id"] for m in (await svc.list_models())["openrouter"]]
    assert or_contador.chamadas == 2
    assert ids == ["openrouter:vendor/a", "openrouter:vendor/b"]


@pytest.mark.asyncio
async def test_changing_the_key_does_not_serve_the_old_catalog(store, or_contador):
    """Contas diferentes veem catálogos diferentes: a chave é parte da identidade."""
    svc = _make_service(store)
    await _com_chave(svc, "sk-or-antiga")
    await svc.list_models()

    or_contador.catalogo = [{"id": "vendor/z", "name": "Z"}]
    await _com_chave(svc, "sk-or-nova")

    ids = [m["id"] for m in (await svc.list_models())["openrouter"]]
    assert or_contador.chamadas == 2
    assert ids == ["openrouter:vendor/z"]


@pytest.mark.asyncio
async def test_network_failure_serves_the_stale_catalog(store, or_contador, monkeypatch):
    """Cair a rede não pode apagar o que já se sabia.

    Devolver `[]` faria a UI afirmar "o catálogo do OpenRouter voltou vazio" —
    mais forte, e errada. Servir o vencido é a resposta honesta.
    """
    svc = _make_service(store)
    await _com_chave(svc)
    await svc.list_models()

    or_contador.falhar = True
    relogio = time.monotonic() + 601.0
    monkeypatch.setattr(
        "seraphine.deepsearch.service.time.monotonic", lambda: relogio
    )

    ids = [m["id"] for m in (await svc.list_models())["openrouter"]]
    assert or_contador.chamadas == 2  # tentou de novo
    assert ids == ["openrouter:vendor/a"]  # e serviu o que tinha


@pytest.mark.asyncio
async def test_failure_without_any_cache_yields_empty_and_never_raises(store, or_contador):
    svc = _make_service(store)
    await _com_chave(svc)
    or_contador.falhar = True

    models = await svc.list_models()
    assert models["openrouter"] == []
    # A lista curada do cliproxy não depende da rede e continua lá.
    assert len(models["cliproxy"]) == 3


@pytest.mark.asyncio
async def test_a_failed_fetch_is_not_cached(store, or_contador):
    """Falha não pode envenenar o cache por 10 minutos."""
    svc = _make_service(store)
    await _com_chave(svc)
    or_contador.falhar = True
    assert (await svc.list_models())["openrouter"] == []

    or_contador.falhar = False
    ids = [m["id"] for m in (await svc.list_models())["openrouter"]]
    assert ids == ["openrouter:vendor/a"]
