from pathlib import Path

import pytest

from seraphine.courses.generate import CourseGenerationError
from seraphine.courses import sources

FIX = Path(__file__).parent / "fixtures" / "share_sample.html"


def test_is_url():
    assert sources.is_url("https://chatgpt.com/share/abc")
    assert sources.is_url("  http://x.com ")
    assert not sources.is_url("Redes neurais")
    assert not sources.is_url("ftp://x")


def test_parse_share_extracts_long_strings_in_order():
    out = sources.parse_share_html(FIX.read_text())
    assert out["title"] == "Curso de Teste"
    assert "Capítulo 1" in out["text"]
    assert "Capítulo 2" in out["text"]
    assert out["text"].index("Capítulo 1") < out["text"].index("Capítulo 2")
    assert "loaderData" not in out["text"]  # strings curtas/estruturais fora
    assert "curto" not in out["text"]


def test_parse_share_without_stream_raises():
    with pytest.raises(CourseGenerationError):
        sources.parse_share_html("<html><title>ChatGPT - X</title><body>nada</body></html>")


def test_parse_generic_strips_tags():
    html = ("<html><head><title>Artigo Bom</title><style>.x{}</style></head>"
            "<body><script>var a=1;</script><h1>T</h1><p>" + "conteúdo útil " * 60 + "</p></body></html>")
    out = sources.parse_generic_html(html)
    assert out["title"] == "Artigo Bom"
    assert "conteúdo útil" in out["text"]
    assert "var a=1" not in out["text"]


def test_parse_generic_too_short_raises():
    with pytest.raises(CourseGenerationError):
        sources.parse_generic_html("<html><title>V</title><body>oi</body></html>")


@pytest.mark.asyncio
async def test_resolve_source_topic_uses_engine():
    class Eng:
        async def run(self, q, mode, *, emit):
            return {"status": "done", "report": "relatório sobre " + q, "sources": []}
    out = await sources.resolve_source("Fotossíntese", engine=Eng())
    assert out["source_ref"] is None and out["title"] is None
    assert "Fotossíntese" in out["digest"]


@pytest.mark.asyncio
async def test_resolve_source_share_url_uses_parser(monkeypatch):
    async def fake_get(url):
        return FIX.read_text()
    monkeypatch.setattr(sources, "_get_text", fake_get)
    out = await sources.resolve_source("https://chatgpt.com/share/6a5b", engine=None)
    assert out["title"] == "Curso de Teste"
    assert out["source_ref"] == "https://chatgpt.com/share/6a5b"
    assert "Capítulo 1" in out["digest"]
