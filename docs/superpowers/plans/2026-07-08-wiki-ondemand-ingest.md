# Wiki on-demand deepsearch ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda pesquisa Deep concluída ingere na wiki na hora (fire-and-forget), reaproveitando o builder; o job noturno vira rede de segurança + consolidação.

**Architecture:** Extrai `ingest_deepsearch_run(run, store, llm)` do loop do `run_once` (com dedup idempotente: escreve o `raw/` **por último**, como marcador de "ingerido"). O `run_once` passa a chamar essa função. Um hook fire-and-forget em `DeepSearchService._run_task` (onde `mode`/`query`/`status` existem) dispara o ingest quando `mode=="deep"` e `status=="done"`.

**Tech Stack:** Python/FastAPI (uv, asyncio), `seraphine/wiki` (builder/capture/files), `seraphine/deepsearch`.

## Global Constraints

- Backend tests rodam de `apps/seraphine/backend` com `uv run pytest` (pytest `asyncio_mode = "auto"` — testes async sem marcador). Um arquivo: `uv run pytest tests/test_x.py -v`.
- **Deep-only:** só `mode=="deep"` + `status=="done"` dispara o ingest on-demand. Quick nunca.
- **Fire-and-forget:** o ingest roda num `asyncio.create_task` a partir do `_run_task`; nunca bloqueia nem propaga erro pra pesquisa. Guardar referência do task (evitar GC).
- **Dedup por marcador:** um run é ingerido **uma vez**. O arquivo `raw/research/<ref>.md` é o marcador de "ingerido" e é escrito **por último** (depois de montar as páginas), pra que uma falha/queda no meio deixe o run **sem** raw → o noturno reprocessa (rede de segurança).
- **Read-only na memória:** nada escreve em `facts`/`people`/`deepsearch_runs` além do que o deepsearch já faz; a wiki só escreve em `/data/wiki`.
- **Reuso:** on-demand e noturno chamam a MESMA `ingest_deepsearch_run` (DRY).
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Modificar:**
- `apps/seraphine/backend/seraphine/wiki/capture.py` — novo helper `deepsearch_ref(run)`; `export_deepsearch_run` reusa.
- `apps/seraphine/backend/seraphine/wiki/builder.py` — nova `ingest_deepsearch_run`; `run_once` reusa.
- `apps/seraphine/backend/seraphine/deepsearch/service.py` — `__init__` ganha `self._wiki_ingest_tasks`; hook fire-and-forget no fim de `_run_task`.

**Testes:**
- Criar: `apps/seraphine/backend/tests/test_wiki_ingest.py`
- Modificar: `apps/seraphine/backend/tests/deepsearch/test_service.py` (2 casos novos)

---

## Task 1: `ingest_deepsearch_run` + dedup + `run_once` reusa

**Files:**
- Modify: `apps/seraphine/backend/seraphine/wiki/capture.py` (add `deepsearch_ref`; `export_deepsearch_run` reusa)
- Modify: `apps/seraphine/backend/seraphine/wiki/builder.py` (add `ingest_deepsearch_run`; refactor `run_once` deepsearch loop)
- Test: `apps/seraphine/backend/tests/test_wiki_ingest.py`

**Interfaces:**
- Consumes: `capture.export_deepsearch_run` (existente), `build_pages_from_source`, `apply_page_ops`, `files.list_pages`/`append_log`/`wiki_root`/`slugify` (existentes).
- Produces:
  - `capture.deepsearch_ref(run: dict) -> str | None` — o ref `research/<date>-<slug>.md` (ou None se report vazio), SEM escrever.
  - `builder.ingest_deepsearch_run(run: dict, store, llm) -> list[str]` — ingere um run (dedup por raw-existente; escreve raw por último); retorna slugs tocados. `store` é aceito por simetria (não usado hoje).

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_ingest.py`:

```python
import seraphine.wiki.builder as b
import seraphine.wiki.files as f


class _Tok:
    def __init__(self, text): self.text = text


class _CountLLM:
    """Fake LLM that counts chat() calls, so we can assert dedup skips the build."""
    def __init__(self, payload): self._payload = payload; self.calls = 0
    async def chat(self, messages, temperature=0.2):
        self.calls += 1
        yield _Tok(self._payload)


class _FakeStore:
    def __init__(self): self._kv = {}
    async def get_kv(self, k): return self._kv.get(k)
    async def set_kv(self, k, v): self._kv[k] = v
    async def list_people(self, limit=30): return []
    async def list_person_mentions(self, pid, limit=5): return []


class _FakeDeep:
    def __init__(self, runs): self._runs = runs
    async def list_runs(self, limit=100): return self._runs


_RUN = {
    "id": "r1", "query": "café", "report": "# Café\nbom",
    "status": "done", "mode": "deep", "created_at": "2026-07-08T10:00:00+00:00",
}
_PAYLOAD = '{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"resumo","links":[]}]}'


async def test_ingest_creates_page_and_raw_marker(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    llm = _CountLLM(_PAYLOAD)
    touched = await b.ingest_deepsearch_run(dict(_RUN), store=None, llm=llm)
    assert touched == ["cafe"]
    assert f.read_page("cafe") is not None
    assert llm.calls == 1
    raws = list((f.wiki_root() / "raw" / "research").glob("*.md"))
    assert len(raws) == 1  # raw written as the done-marker


async def test_ingest_dedups_on_second_call(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    llm = _CountLLM(_PAYLOAD)
    await b.ingest_deepsearch_run(dict(_RUN), store=None, llm=llm)
    touched2 = await b.ingest_deepsearch_run(dict(_RUN), store=None, llm=llm)
    assert touched2 == []
    assert llm.calls == 1  # raw already exists → no second LLM build


async def test_ingest_empty_report_noops(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    llm = _CountLLM(_PAYLOAD)
    run = {"id": "x", "query": "q", "report": "", "created_at": "2026-07-08T10:00:00+00:00"}
    assert await b.ingest_deepsearch_run(run, store=None, llm=llm) == []
    assert llm.calls == 0


async def test_run_once_reuses_ingest_and_dedups(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore()
    await store.set_kv("wiki_last_ingest_at", "2025-01-01T00:00:00+00:00")
    llm = _CountLLM(_PAYLOAD)
    # on-demand ingests first
    await b.ingest_deepsearch_run(dict(_RUN), store=None, llm=llm)
    assert llm.calls == 1
    # nightly sees the same run (created_at > watermark) but raw exists → dedup, no rebuild
    deep = _FakeDeep([dict(_RUN)])
    summary = await b.run_once(store, llm, deep)
    assert summary["sources_ingested"] == 0
    assert llm.calls == 1


async def test_run_once_ingests_fresh_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore()
    await store.set_kv("wiki_last_ingest_at", "2025-01-01T00:00:00+00:00")
    llm = _CountLLM(_PAYLOAD)
    deep = _FakeDeep([dict(_RUN)])
    summary = await b.run_once(store, llm, deep)
    assert summary["sources_ingested"] == 1
    assert f.read_page("cafe") is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_wiki_ingest.py -v`
Expected: FAIL — `AttributeError: module 'seraphine.wiki.builder' has no attribute 'ingest_deepsearch_run'`.

- [ ] **Step 3: Add `deepsearch_ref` to capture.py**

In `apps/seraphine/backend/seraphine/wiki/capture.py`, add the ref helper and make `export_deepsearch_run` reuse it. Replace the current `export_deepsearch_run` with:

```python
def deepsearch_ref(run: dict[str, Any]) -> str | None:
    """Compute the raw/ ref for a deepsearch run WITHOUT writing. None if empty report."""
    report = (run.get("report") or "").strip()
    if not report:
        return None
    created = (run.get("created_at") or "")[:10] or "0000-00-00"
    slug = files.slugify(run.get("query") or run.get("id") or "pesquisa")
    return f"research/{created}-{slug}.md"


def export_deepsearch_run(run: dict[str, Any]) -> str | None:
    """Write a done deepsearch report into raw/research/. Idempotent. Returns the ref."""
    ref = deepsearch_ref(run)
    if ref is None:
        return None
    path = files.wiki_root() / "raw" / ref
    if path.exists():
        return ref
    header = f"# Pesquisa: {run.get('query', '')}\n\n_id: {run.get('id', '')} · {run.get('created_at', '')}_\n\n"
    path.write_text(header + (run.get("report") or "").strip() + "\n", encoding="utf-8")
    return ref
```

(`from typing import Any` is already imported in capture.py; `files` is already imported.)

- [ ] **Step 4: Add `ingest_deepsearch_run` and refactor `run_once` in builder.py**

In `apps/seraphine/backend/seraphine/wiki/builder.py`, add the new function (near the other deepsearch logic; `capture` and `files` are already imported):

```python
async def ingest_deepsearch_run(run: dict[str, Any], store: Any, llm: Any) -> list[str]:
    """Ingest ONE deepsearch run into the wiki. Idempotent: the raw/ file is the
    'already ingested' marker and is written LAST, so a crash mid-build leaves no
    marker and the nightly pass retries. ``store`` is accepted for call-site
    symmetry (unused today). Returns the slugs of pages touched."""
    ref = capture.deepsearch_ref(run)
    if ref is None:
        return []
    if (files.wiki_root() / "raw" / ref).exists():
        return []  # already ingested (raw marker present)
    source = {"ref": ref, "title": run.get("query", ""), "text": run.get("report", "")}
    ops = await build_pages_from_source(source, files.list_pages(), llm)
    touched = apply_page_ops(ops, source_ref=ref)
    capture.export_deepsearch_run(run)  # write raw LAST = mark ingested
    if touched:
        files.append_log(f"ingest | {run.get('query', '')} -> {', '.join(touched)}")
    return touched
```

Then replace the deepsearch loop inside `run_once`. Find this block:

```python
    for run in new_runs:
        ref = capture.export_deepsearch_run(run)
        if not ref:
            continue
        source = {"ref": ref, "title": run.get("query", ""), "text": run.get("report", "")}
        ops = await build_pages_from_source(source, files.list_pages(), llm)
        touched = apply_page_ops(ops, source_ref=ref)
        if touched:
            files.append_log(f"ingest | {run.get('query', '')} -> {', '.join(touched)}")
            sources_ingested += 1
```

Replace it with:

```python
    for run in new_runs:
        touched = await ingest_deepsearch_run(run, store, llm)
        if touched:
            sources_ingested += 1
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_wiki_ingest.py tests/test_wiki_builder_run.py tests/test_wiki_capture.py -v`
Expected: PASS (5 new + the existing run_once/capture tests stay green — `export_deepsearch_run` signature unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/capture.py \
        apps/seraphine/backend/seraphine/wiki/builder.py \
        apps/seraphine/backend/tests/test_wiki_ingest.py
git commit -m "feat(wiki): ingest_deepsearch_run (idempotent) + run_once reuses it"
```

---

## Task 2: On-demand hook in `DeepSearchService._run_task`

**Files:**
- Modify: `apps/seraphine/backend/seraphine/deepsearch/service.py` (`__init__` + end of `_run_task`)
- Test: `apps/seraphine/backend/tests/deepsearch/test_service.py` (2 new cases)

**Interfaces:**
- Consumes: `builder.ingest_deepsearch_run(run, store, llm)` (Task 1), `self.get_run(run_id)`, `files.write_index`.
- Produces: after a Deep run finishes done, a fire-and-forget task ingests it; task refs held in `self._wiki_ingest_tasks`.

- [ ] **Step 1: Write the failing test**

Add to `apps/seraphine/backend/tests/deepsearch/test_service.py` (reuse the existing `store` fixture, `_patch_engine`, `_make_service`, `_await_run` helpers already in that file):

```python
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
```

(If `asyncio` isn't imported at the top of the test file, add `import asyncio`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/deepsearch/test_service.py::test_deep_run_schedules_wiki_ingest -v`
Expected: FAIL — `AttributeError: 'DeepSearchService' object has no attribute '_wiki_ingest_tasks'`.

- [ ] **Step 3: Add the task-ref set in `__init__`**

In `apps/seraphine/backend/seraphine/deepsearch/service.py`, in `DeepSearchService.__init__`, right after `self._tasks: dict[str, asyncio.Task] = {}`, add:

```python
        # Fire-and-forget wiki-ingest tasks (Deep runs). Held here so the event
        # loop keeps a strong ref (create_task results are GC-eligible otherwise);
        # each removes itself on completion.
        self._wiki_ingest_tasks: set[asyncio.Task] = set()
```

- [ ] **Step 4: Add the hook at the end of `_run_task`**

In `_run_task`, the method ends with the normal-path finalize:

```python
        await self._finish(run_id, status, report, sources)
```

Immediately after that line (still inside `_run_task`, where `mode` and `query` are in scope), add:

```python
        # On-demand wiki ingest: a completed Deep run composes into the wiki now
        # (fire-and-forget). Quick runs and non-done outcomes are skipped. The
        # nightly pass is the safety-net for anything missed here.
        if mode == "deep" and status == "done":
            async def _wiki_ingest() -> None:
                try:
                    from seraphine.wiki import files as _wiki_files
                    from seraphine.wiki.builder import ingest_deepsearch_run
                    run = await self.get_run(run_id)
                    if run:
                        touched = await ingest_deepsearch_run(run, self.store, self.llm)
                        if touched:
                            _wiki_files.write_index()
                except Exception:
                    logger.exception("wiki on-demand ingest failed for %s", run_id)

            t = asyncio.create_task(_wiki_ingest())
            self._wiki_ingest_tasks.add(t)
            t.add_done_callback(self._wiki_ingest_tasks.discard)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/deepsearch/test_service.py -v`
Expected: PASS (2 new + all existing deepsearch service tests stay green).

- [ ] **Step 6: Import sanity + no regression**

Run: `uv run python -c "import seraphine.main"` (import OK).
Run: `uv run pytest tests/test_wiki_ingest.py tests/deepsearch/test_service.py -q`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/deepsearch/service.py \
        apps/seraphine/backend/tests/deepsearch/test_service.py
git commit -m "feat(deepsearch): on-demand wiki ingest hook for completed Deep runs"
```

---

## Task 3: Verificação E2E manual

**Files:** nenhum.

- [ ] **Step 1: Suíte verde**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_wiki_ingest.py tests/test_wiki_builder_run.py tests/test_wiki_capture.py tests/deepsearch/test_service.py -v`
Expected: tudo verde.

- [ ] **Step 2: On-demand real**

Suba o backend local (cliproxy:8317 up). Rode uma pesquisa **Deep** na aba Pesquisa. Ao concluir, sem esperar a noite: abra a aba **Wiki** → deve haver uma página nova daquela pesquisa (com citação pro `raw/research/<data>-<slug>.md`), e `/data/wiki/log.md` deve ter uma linha `ingest | <query> -> <páginas>`. Rode uma pesquisa **Quick** → **não** deve criar página.

- [ ] **Step 3: Dedup / rede de segurança**

Rode o `run_once` (ou espere o job): a pesquisa Deep já ingerida on-demand **não** deve ser re-buildada (sem página duplicada, sem nova linha de ingest pra ela no log). Opcional: simule "app fora do ar" ingerindo um run só pelo `run_once` (sem on-demand) e confirme que ele cria a página (rede de segurança).

---

## Self-Review (cobertura do spec)

- **Deep-only automático, fire-and-forget:** Task 2 (hook gated `mode=="deep"` + `status=="done"`, `asyncio.create_task`). ✓
- **Reuso builder / `ingest_deepsearch_run`:** Task 1 (extraída; `run_once` chama a mesma). ✓
- **Dedup uma-vez + rede de segurança:** Task 1 (raw como marcador escrito por último; dedup por raw-existente; `run_once` self-dedup). ✓
- **Não bloqueia/quebra a pesquisa:** Task 2 (create_task + try/except; hook após `_finish`). ✓
- **Sem watermark novo, sem tabela nova:** Task 1 (usa o run dict existente). ✓
- **Read-only na memória:** nenhuma task escreve em facts/people/deepsearch_runs; só `/data/wiki`. ✓
- **GC-safety do task:** Task 2 (`self._wiki_ingest_tasks` + discard callback). ✓
- **Fora de escopo respeitado:** sem opt-in/UI, sem Quick, sem refresh live, sem hook de anexo. ✓
