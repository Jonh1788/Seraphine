import seraphine.wiki.builder as b
import seraphine.wiki.capture as cap
import seraphine.wiki.files as f


class _Tok:
    def __init__(self, text): self.text = text


class _CountLLM:
    def __init__(self, payload): self._payload = payload; self.calls = 0
    async def chat(self, messages, temperature=0.2):
        self.calls += 1
        yield _Tok(self._payload)


_PAYLOAD = '{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"resumo","links":[]}]}'
_Q = "o que é café arábica?"
_A = "É uma espécie de café mais fina e aromática."


def test_chat_qa_ref_deterministic(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    r1 = cap.chat_qa_ref(_Q, _A)
    r2 = cap.chat_qa_ref(_Q, _A)
    r3 = cap.chat_qa_ref(_Q, "resposta diferente")
    assert r1 == r2 and r1 != r3
    assert r1.startswith("chat/") and r1.endswith(".md")


async def test_ingest_chat_qa_creates_page_and_raw(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    llm = _CountLLM(_PAYLOAD)
    touched = await b.ingest_chat_qa(_Q, _A, store=None, llm=llm)
    assert touched == ["cafe"]
    assert f.read_page("cafe") is not None
    assert llm.calls == 1
    raws = list((f.wiki_root() / "raw" / "chat").glob("*.md"))
    assert len(raws) == 1  # raw marker written


async def test_ingest_chat_qa_dedups(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    llm = _CountLLM(_PAYLOAD)
    await b.ingest_chat_qa(_Q, _A, store=None, llm=llm)
    touched2 = await b.ingest_chat_qa(_Q, _A, store=None, llm=llm)
    assert touched2 == []
    assert llm.calls == 1  # same Q&A → no second build


async def test_ingest_chat_qa_empty_answer(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    llm = _CountLLM(_PAYLOAD)
    assert await b.ingest_chat_qa(_Q, "   ", store=None, llm=llm) == []
    assert llm.calls == 0
