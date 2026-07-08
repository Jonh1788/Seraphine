import seraphine.wiki.builder as b
import seraphine.wiki.files as f


class _Tok:
    def __init__(self, text): self.text = text


class _FakeLLM:
    def __init__(self, payload): self._payload = payload
    async def chat(self, messages, temperature=0.2):
        yield _Tok(self._payload)


def test_parse_page_ops_valid_and_invalid():
    raw = 'prosa {"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"corpo","links":["Arábica"]},{"slug":"../bad","title":"x","body":"y"},{"title":"","body":""}]} fim'
    ops = b._parse_page_ops(raw)
    assert len(ops) == 1
    assert ops[0]["slug"] == "cafe" and ops[0]["links"] == ["Arábica"]


def test_parse_page_ops_bad_json():
    assert b._parse_page_ops("sem json") == []
    assert b._parse_page_ops('{"pages": not json}') == []


async def test_build_pages_from_source():
    llm = _FakeLLM('{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"sobre café","links":[]}]}')
    ops = await b.build_pages_from_source(
        {"ref": "research/x.md", "title": "Café", "text": "café é bom"}, [], llm,
    )
    assert ops == [{"slug": "cafe", "title": "Café", "category": "topic", "body": "sobre café", "links": []}]


async def test_build_pages_from_source_llm_error():
    class _Boom:
        async def chat(self, messages, temperature=0.2):
            raise RuntimeError("down")
            yield  # pragma: no cover
    assert await b.build_pages_from_source({"ref": "r", "title": "t", "text": "x"}, [], _Boom()) == []


def test_apply_page_ops_writes_pages(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    touched = b.apply_page_ops(
        [{"slug": "cafe", "title": "Café", "category": "topic", "body": "corpo", "links": ["Arábica"]}],
        "research/x.md",
    )
    assert touched == ["cafe"]
    d = f.read_page("cafe")
    assert d["title"] == "Café" and d["sources"] == ["research/x.md"]


def test_lint_detects_broken_and_orphan(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="a", title="A", category="topic", sources=[], links=["Inexistente"], body="liga [[Inexistente]]")
    f.write_page(slug="b", title="B", category="topic", sources=[], links=[], body="ninguém liga aqui")
    rep = b.lint()
    assert {"page": "a", "link": "Inexistente"} in rep["broken_links"]
    assert "b" in rep["orphans"] and "a" in rep["orphans"]
