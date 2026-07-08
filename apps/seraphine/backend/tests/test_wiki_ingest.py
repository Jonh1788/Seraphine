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


async def test_run_once_safety_net_ingests_old_run_without_raw_marker(tmp_path, monkeypatch):
    """Safety-net: a done run created well BEFORE the watermark, whose on-demand
    ingest never wrote a raw marker, must still be ingested by the nightly pass.
    The deepsearch loop no longer pre-filters by watermark; raw-marker dedup is
    the sole gate."""
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore()
    # watermark is recent; the run is ancient → old pre-filter would have skipped it
    await store.set_kv("wiki_last_ingest_at", "2026-07-01T00:00:00+00:00")
    old_run = dict(_RUN)
    old_run["created_at"] = "2020-01-01T00:00:00+00:00"
    # no pre-existing raw marker for this run
    ref = b.capture.deepsearch_ref(old_run)
    assert not (f.wiki_root() / "raw" / ref).exists()
    llm = _CountLLM(_PAYLOAD)
    deep = _FakeDeep([old_run])
    summary = await b.run_once(store, llm, deep)
    assert summary["sources_ingested"] == 1  # ingested despite predating watermark
    assert f.read_page("cafe") is not None
    assert llm.calls == 1
