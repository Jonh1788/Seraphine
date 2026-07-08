import seraphine.wiki.builder as b
import seraphine.wiki.files as f


class _Tok:
    def __init__(self, text): self.text = text


class _FakeLLM:
    def __init__(self, payload): self._payload = payload
    async def chat(self, messages, temperature=0.2):
        yield _Tok(self._payload)


class _FakeStore:
    def __init__(self, people=None, mentions=None):
        self._kv = {}
        self._people = people or []
        self._mentions = mentions or {}
    async def get_kv(self, k): return self._kv.get(k)
    async def set_kv(self, k, v): self._kv[k] = v
    async def list_people(self, limit=30): return self._people
    async def list_person_mentions(self, pid, limit=5): return self._mentions.get(pid, [])


class _FakeDeep:
    def __init__(self, runs): self._runs = runs
    async def list_runs(self, limit=100): return self._runs


async def test_run_once_ingests_deepsearch_and_advances_watermark(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore()
    deep = _FakeDeep([
        {"id": "r1", "query": "café", "report": "# Café\nbom", "status": "done", "created_at": "2026-06-29T10:00:00+00:00"},
        {"id": "r0", "query": "velho", "report": "# Velho", "status": "done", "created_at": "2020-01-01T00:00:00+00:00"},
    ])
    llm = _FakeLLM('{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"resumo","links":[]}]}')
    # watermark in the past → r1 is new, r0 stays old only if we set watermark; here none → both new
    await store.set_kv("wiki_last_ingest_at", "2025-01-01T00:00:00+00:00")
    summary = await b.run_once(store, llm, deep)
    assert summary["sources_ingested"] == 1  # only r1 (r0 is before watermark)
    assert f.read_page("cafe") is not None
    assert (await store.get_kv("wiki_last_ingest_at")) > "2025-01-01T00:00:00+00:00"
    # index + log written
    assert (f.wiki_root() / "index.md").exists()
    assert (f.wiki_root() / "log.md").exists()


async def test_run_once_builds_person_page(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    store = _FakeStore(
        people=[{"id": "p1", "name": "Ana", "relation": "amiga", "last_mentioned_at": "2026-06-29T10:00:00+00:00", "tags": ["design"]}],
        mentions={"p1": [{"context": "Ana ama café", "sentiment": "pos", "created_at": "2026-06-29T09:00:00+00:00"}]},
    )
    deep = _FakeDeep([])
    llm = _FakeLLM('{"pages":[{"slug":"ana","title":"Ana","category":"person","body":"amiga designer","links":[]}]}')
    await store.set_kv("wiki_last_ingest_at", "2025-01-01T00:00:00+00:00")
    summary = await b.run_once(store, llm, deep)
    assert summary["people_updated"] == 1
    d = f.read_page("ana")
    assert d["category"] == "person"
