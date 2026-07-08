import seraphine.wiki.files as f


def test_slug_and_title_helpers():
    assert f.is_safe_slug("abc-123")
    assert not f.is_safe_slug("../x")
    assert not f.is_safe_slug("")
    assert f.slugify("Olá, Mundo!") == "ola-mundo"
    assert f.norm_title("  Foo Bar ") == "foo bar"


def test_wikilinks_extraction():
    assert f.wikilinks("veja [[Página A]] e [[Outra]] aqui") == ["Página A", "Outra"]


def test_serialize_parse_roundtrip():
    text = f.serialize_page(
        title="Conceito X", category="topic", updated_at="2026-06-29T00:00:00+00:00",
        sources=["research/a.md", "attachments/b.md"], links=["Página A"],
        body="# Corpo\ncom [[Página A]].",
    )
    d = f.parse_page(text)
    assert d["title"] == "Conceito X"
    assert d["category"] == "topic"
    assert d["sources"] == ["research/a.md", "attachments/b.md"]
    assert d["links"] == ["Página A"]
    assert "Corpo" in d["body"]


def test_write_read_page_accumulates_sources(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="x", title="X", category="topic", sources=["research/a.md"], links=[], body="corpo1")
    f.write_page(slug="x", title="X", category="topic", sources=["research/b.md"], links=[], body="corpo2")
    d = f.read_page("x")
    assert d["body"] == "corpo2"
    assert d["sources"] == ["research/a.md", "research/b.md"]  # accumulated, deduped
    assert f.read_page("../etc/passwd") is None


def test_graph_from_links(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="a", title="Página A", category="topic", sources=[], links=["Página B"], body="liga em [[Página B]]")
    f.write_page(slug="b", title="Página B", category="topic", sources=[], links=[], body="folha")
    g = f.graph()
    assert {n["id"] for n in g["nodes"]} == {"a", "b"}
    assert {"source": "a", "target": "b"} in g["edges"]
    assert len(g["edges"]) == 1  # deduped, no self/back edge invented


def test_read_source_confined_to_raw(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    (f.wiki_root() / "raw" / "research" / "s.md").write_text("fonte", encoding="utf-8")
    assert f.read_source("research/s.md") == "fonte"
    assert f.read_source("../../etc/passwd") is None
    assert f.read_source("/etc/passwd") is None


def test_write_index_and_log(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="a", title="Página A", category="topic", sources=[], links=[], body="resumo linha um\nmais")
    f.write_index()
    idx = (f.wiki_root() / "index.md").read_text(encoding="utf-8")
    assert "Página A" in idx and "a.md" in idx
    f.append_log("ingest | fonte X -> a")
    log = (f.wiki_root() / "log.md").read_text(encoding="utf-8")
    assert "ingest | fonte X -> a" in log
