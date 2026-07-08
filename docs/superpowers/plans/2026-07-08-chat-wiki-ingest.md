# Chat→wiki (opt-in Q&A) + Task 7 (anexos) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um botão "salvar na wiki" em cada resposta do assistente ingere aquele Q&A na wiki na hora (opt-in, síncrono); e o hook de captura de anexo (Task 7) passa a popular `raw/attachments/` pro noturno ingerir.

**Architecture:** `builder.ingest_chat_qa` espelha o `ingest_deepsearch_run` (dedup por raw-marker, hash de conteúdo). Uma rota `POST /wiki/ingest/chat` (única rota de escrita da wiki) lê `app.state.llm`/`store` e chama o ingest. O `ChatView` ganha o botão por mensagem. `attachments/content.py` ganha 1 linha fire-and-forget de captura.

**Tech Stack:** Python/FastAPI (uv, asyncio, hashlib), `seraphine/wiki`, `seraphine/attachments`; React+TS (Vite, pnpm), `react-markdown`.

## Global Constraints

- Backend tests de `apps/seraphine/backend` com `uv run pytest` (asyncio_mode=auto). Um arquivo: `uv run pytest tests/test_x.py -v`.
- **Opt-in, síncrono:** o ingest do chat roda dentro do request `POST /wiki/ingest/chat` (1 chamada de LLM) e retorna `{pages, created}`. Sem fire-and-forget aqui.
- **Dedup por marcador:** `raw/chat/<data>-<hash8>.md` escrito POR ÚLTIMO; `hash8 = sha256((question+"\n"+answer))[:8]`. Re-salvar o mesmo Q&A → skip.
- **Read-only preservado:** `POST /wiki/ingest/chat` é a ÚNICA rota de escrita da wiki (ação explícita do usuário). Nada muta facts/people/deepsearch_runs.
- **DRY:** `ingest_chat_qa` espelha `ingest_deepsearch_run`; NÃO refatorar o `ingest_deepsearch_run` (já live) — duplicação mínima aceita.
- **Sem emoji em ícones** (SVG de `src/icons/Icons.tsx`). Sem lib de toast (não existe) — feedback inline via estado local por-turn.
- **Task 7 fire-and-forget:** o hook de anexo nunca bloqueia/quebra o turno.
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Backend (modificar):**
- `apps/seraphine/backend/seraphine/wiki/files.py` — add `raw/chat` ao mkdir de `wiki_root`.
- `apps/seraphine/backend/seraphine/wiki/capture.py` — `chat_qa_ref` + `export_chat_qa`.
- `apps/seraphine/backend/seraphine/wiki/builder.py` — `ingest_chat_qa`.
- `apps/seraphine/backend/seraphine/wiki/routes.py` — `POST /wiki/ingest/chat`.
- `apps/seraphine/backend/seraphine/attachments/content.py` — hook de captura (Task 7).

**Backend (testes):** criar `tests/test_wiki_chat_ingest.py`, `tests/test_wiki_attachment_hook.py`; modificar `tests/test_wiki_routes.py`.

**Frontend (modificar):** `src/wiki/api.ts` (add `ingestChatToWiki`); `src/chat/ChatView.tsx` (botão); `src/chat/obsidian.css` (estilo do botão).

---

## Task 1: Backend — `chat_qa_ref`/`export_chat_qa` + `ingest_chat_qa` + `raw/chat`

**Files:**
- Modify: `apps/seraphine/backend/seraphine/wiki/files.py` (`wiki_root` mkdir)
- Modify: `apps/seraphine/backend/seraphine/wiki/capture.py` (add 2 funcs)
- Modify: `apps/seraphine/backend/seraphine/wiki/builder.py` (add `ingest_chat_qa`)
- Test: `apps/seraphine/backend/tests/test_wiki_chat_ingest.py`

**Interfaces:**
- Consumes: `build_pages_from_source`, `apply_page_ops`, `files.list_pages`/`append_log`/`wiki_root`/`slugify` (existentes).
- Produces:
  - `capture.chat_qa_ref(question: str, answer: str) -> str` — `chat/<date>-<hash8>.md`, determinístico.
  - `capture.export_chat_qa(question: str, answer: str) -> str` — escreve `raw/chat/<ref>` (idempotente), retorna ref.
  - `builder.ingest_chat_qa(question: str, answer: str, store, llm) -> list[str]` — ingest de um Q&A (dedup por raw-marker escrito por último). `store` aceito por simetria.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_chat_ingest.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_wiki_chat_ingest.py -v`
Expected: FAIL — `AttributeError: module 'seraphine.wiki.capture' has no attribute 'chat_qa_ref'`.

- [ ] **Step 3: Add `raw/chat` to `files.wiki_root`**

In `apps/seraphine/backend/seraphine/wiki/files.py`, in `wiki_root`, next to the existing mkdir lines, add the `raw/chat` dir:

```python
    (root / "raw" / "research").mkdir(parents=True, exist_ok=True)
    (root / "raw" / "attachments").mkdir(parents=True, exist_ok=True)
    (root / "raw" / "chat").mkdir(parents=True, exist_ok=True)
    (root / "wiki").mkdir(parents=True, exist_ok=True)
```

- [ ] **Step 4: Add `chat_qa_ref` + `export_chat_qa` to capture.py**

In `apps/seraphine/backend/seraphine/wiki/capture.py`, add at the top of the file (with the other imports): `import hashlib` and `from datetime import datetime, timezone`. Then add the two functions (near `deepsearch_ref`):

```python
def chat_qa_ref(question: str, answer: str) -> str:
    """Deterministic raw/ ref for a chat Q&A. Same Q&A → same ref (dedup)."""
    h = hashlib.sha256(((question or "") + "\n" + (answer or "")).encode("utf-8")).hexdigest()[:8]
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"chat/{date}-{h}.md"


def export_chat_qa(question: str, answer: str) -> str:
    """Write a chat Q&A into raw/chat/. Idempotent. Returns the ref."""
    ref = chat_qa_ref(question, answer)
    path = files.wiki_root() / "raw" / ref
    if path.exists():
        return ref
    body = (
        "# Q&A do chat\n\n"
        f"**Pergunta:** {(question or '').strip()}\n\n"
        f"**Resposta:**\n\n{(answer or '').strip()}\n"
    )
    path.write_text(body, encoding="utf-8")
    return ref
```

- [ ] **Step 5: Add `ingest_chat_qa` to builder.py**

In `apps/seraphine/backend/seraphine/wiki/builder.py`, add (near `ingest_deepsearch_run`; `capture`, `files`, `build_pages_from_source`, `apply_page_ops` all already available):

```python
async def ingest_chat_qa(question: str, answer: str, store: Any, llm: Any) -> list[str]:
    """Ingest ONE chat Q&A into the wiki (opt-in, on-demand). Idempotent by
    content hash: the raw/chat marker is written LAST. ``store`` is accepted for
    call-site symmetry (unused today). Returns the slugs of pages touched."""
    q = (question or "").strip()
    a = (answer or "").strip()
    if not a:
        return []
    ref = capture.chat_qa_ref(q, a)
    if (files.wiki_root() / "raw" / ref).exists():
        return []  # already saved (raw marker present)
    source = {"ref": ref, "title": (q[:80] or "Q&A do chat"), "text": f"Pergunta: {q}\n\nResposta: {a}"}
    ops = await build_pages_from_source(source, files.list_pages(), llm)
    touched = apply_page_ops(ops, source_ref=ref)
    capture.export_chat_qa(q, a)  # write raw LAST = mark saved
    if touched:
        files.append_log(f"ingest(chat) | {q[:60]} -> {', '.join(touched)}")
    return touched
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_wiki_chat_ingest.py tests/test_wiki_ingest.py tests/test_wiki_capture.py -v`
Expected: PASS (4 new + existing wiki ingest/capture green — nothing existing changed).

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/files.py \
        apps/seraphine/backend/seraphine/wiki/capture.py \
        apps/seraphine/backend/seraphine/wiki/builder.py \
        apps/seraphine/backend/tests/test_wiki_chat_ingest.py
git commit -m "feat(wiki): ingest_chat_qa (opt-in Q&A, hash dedup) + raw/chat"
```

---

## Task 2: Backend — `POST /wiki/ingest/chat`

**Files:**
- Modify: `apps/seraphine/backend/seraphine/wiki/routes.py`
- Test: `apps/seraphine/backend/tests/test_wiki_routes.py` (add POST cases)

**Interfaces:**
- Consumes: `builder.ingest_chat_qa` (Task 1), `files.write_index`, `request.app.state.llm`/`.store`.
- Produces: `POST /wiki/ingest/chat` body `{question?, answer, title?}` → `{pages: list[str], created: bool}`; 400 answer vazio, 503 sem llm/store.

- [ ] **Step 1: Write the failing test**

Add to `apps/seraphine/backend/tests/test_wiki_routes.py` (top of file already imports `FastAPI`, `TestClient`, `files as f`, `router`). Add these stubs + tests:

```python
class _Tok:
    def __init__(self, text): self.text = text


class _CountLLM:
    def __init__(self, payload): self._payload = payload; self.calls = 0
    async def chat(self, messages, temperature=0.2):
        self.calls += 1
        yield _Tok(self._payload)


_CHAT_PAYLOAD = '{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"resumo","links":[]}]}'


def _ingest_client(tmp_path, monkeypatch, *, with_state=True):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    if with_state:
        app.state.llm = _CountLLM(_CHAT_PAYLOAD)
        app.state.store = object()
    return TestClient(app)


def test_ingest_chat_creates_page(tmp_path, monkeypatch):
    c = _ingest_client(tmp_path, monkeypatch)
    r = c.post("/wiki/ingest/chat", json={"question": "o que é café?", "answer": "bebida"})
    assert r.status_code == 200
    body = r.json()
    assert body["created"] is True and body["pages"] == ["cafe"]
    assert f.read_page("cafe") is not None


def test_ingest_chat_empty_answer_400(tmp_path, monkeypatch):
    c = _ingest_client(tmp_path, monkeypatch)
    assert c.post("/wiki/ingest/chat", json={"question": "q", "answer": "   "}).status_code == 400


def test_ingest_chat_no_state_503(tmp_path, monkeypatch):
    c = _ingest_client(tmp_path, monkeypatch, with_state=False)
    assert c.post("/wiki/ingest/chat", json={"answer": "algo"}).status_code == 503
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_routes.py::test_ingest_chat_creates_page -v`
Expected: FAIL — 404/405 (route doesn't exist yet).

- [ ] **Step 3: Add the route**

In `apps/seraphine/backend/seraphine/wiki/routes.py`, change the imports at the top to add `Request` and `BaseModel`:

```python
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
```

Then add the body model + route (after the existing routes):

```python
class ChatIngestBody(BaseModel):
    answer: str
    question: str = ""
    title: str | None = None


@router.post("/ingest/chat")
async def wiki_ingest_chat(body: ChatIngestBody, request: Request) -> dict[str, Any]:
    if not (body.answer or "").strip():
        raise HTTPException(status_code=400, detail="answer vazio")
    llm = getattr(request.app.state, "llm", None)
    store = getattr(request.app.state, "store", None)
    if llm is None or store is None:
        raise HTTPException(status_code=503, detail="wiki ingest não configurado")
    from seraphine.wiki.builder import ingest_chat_qa
    touched = await ingest_chat_qa(body.question, body.answer, store, llm)
    if touched:
        files.write_index()
    return {"pages": touched, "created": bool(touched)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_wiki_routes.py -v`
Expected: PASS (3 new + existing GET route tests green).

- [ ] **Step 5: Verify main import still OK**

Run: `uv run python -c "import seraphine.main"`
Expected: import OK (the wiki router already registered in main.py; only new route added).

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/wiki/routes.py \
        apps/seraphine/backend/tests/test_wiki_routes.py
git commit -m "feat(wiki): POST /wiki/ingest/chat (opt-in chat Q&A ingest)"
```

---

## Task 3: Backend — Task 7 attachment capture hook (`content.py`)

**Files:**
- Modify: `apps/seraphine/backend/seraphine/attachments/content.py`
- Test: `apps/seraphine/backend/tests/test_wiki_attachment_hook.py`

**Interfaces:**
- Consumes: `capture.capture_attachment(att_id, data, meta)` (existente).

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/test_wiki_attachment_hook.py`:

```python
import asyncio

import seraphine.attachments.content as content
import seraphine.attachments.store as store


async def test_build_user_content_fires_capture(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    seen = {}

    async def _spy(att_id, data, meta):
        seen["id"] = att_id
        return None

    monkeypatch.setattr(content, "capture_attachment", _spy)
    meta = store.save_attachment(b"%PDF-1.4 x", filename="d.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "resume", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    await asyncio.sleep(0)  # let the fire-and-forget task run
    assert seen.get("id") == meta["id"]
    # content itself is unchanged (still produces the pdf part)
    assert any(p.get("type") == "pdf" for p in parts)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_wiki_attachment_hook.py -v`
Expected: FAIL — `AttributeError: module 'seraphine.attachments.content' has no attribute 'capture_attachment'`.

- [ ] **Step 3: Add the import + the hook**

In `apps/seraphine/backend/seraphine/attachments/content.py`, add the import at the top (with the other imports — `asyncio` is already imported):

```python
from seraphine.wiki.capture import capture_attachment
```

Inside `build_user_content`, in the `for att in attachments or []:` loop, right after `data, meta = loaded`, add the fire-and-forget capture:

```python
        data, meta = loaded
        # Wiki (Task 7): capture the used attachment as a raw/ source. Fire-and-
        # forget — never blocks or breaks the turn. Nightly run_once ingests it.
        try:
            asyncio.create_task(capture_attachment(str(att_id), data, meta))
        except Exception:
            pass
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_wiki_attachment_hook.py tests/test_attachments_content.py -v`
Expected: PASS (new hook test + the existing content tests stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/attachments/content.py \
        apps/seraphine/backend/tests/test_wiki_attachment_hook.py
git commit -m "feat(wiki): capture used attachments into raw/ (Task 7 hook)"
```

---

## Task 4: Frontend — `ingestChatToWiki` + botão "salvar na wiki" no ChatView

**Files:**
- Modify: `apps/seraphine/frontend/src/wiki/api.ts` (add POST fn)
- Modify: `apps/seraphine/frontend/src/chat/ChatView.tsx` (state + handler + button)
- Modify: `apps/seraphine/frontend/src/chat/obsidian.css` (button style)

**Interfaces:**
- Consumes: backend `POST /wiki/ingest/chat` → `{pages: string[], created: boolean}`.

- [ ] **Step 1: Add the API function**

In `apps/seraphine/frontend/src/wiki/api.ts`, add (below the existing GET functions; `API_BASE` already imported):

```ts
export async function ingestChatToWiki(
  question: string, answer: string, title?: string,
): Promise<{ pages: string[]; created: boolean }> {
  const res = await fetch(`${API_BASE}/wiki/ingest/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answer, title }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  return (await res.json()) as { pages: string[]; created: boolean };
}
```

- [ ] **Step 2: Add state + handler in ChatView**

In `apps/seraphine/frontend/src/chat/ChatView.tsx`, add the imports (merge into the existing `../icons/Icons` import; add the wiki api import):

```ts
import { ingestChatToWiki } from '../wiki/api';
import { BookmarkIcon, CheckIcon } from '../icons/Icons';
```

Near the other `useState` declarations in the component, add the per-turn save state and the handler (`useCallback` is already used in this file):

```ts
  const [wikiSave, setWikiSave] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});

  const saveTurnToWiki = useCallback(async (turnId: string, question: string, answer: string) => {
    setWikiSave((s) => ({ ...s, [turnId]: 'saving' }));
    try {
      const res = await ingestChatToWiki(question, answer);
      setWikiSave((s) => ({ ...s, [turnId]: res.created ? 'saved' : 'error' }));
    } catch {
      setWikiSave((s) => ({ ...s, [turnId]: 'error' }));
    }
  }, []);
```

- [ ] **Step 3: Add the button in the message render**

In `ChatView.tsx`, the turns render is `{turns.map((t) => {`. Change it to `{turns.map((t, i) => {` (to access the previous user turn by index). Then, inside the assistant bubble — right after the assistant-content IIFE `})()` and before the `{t.streaming && <span className="cursor" />}` line — add the save-to-wiki action (only for finished assistant turns):

```tsx
                  {t.role === 'assistant' && !t.streaming && (() => {
                    const answer = parsed ? parsed.response : t.content;
                    const question = [...turns.slice(0, i)].reverse().find((x) => x.role === 'user')?.content ?? '';
                    const st = wikiSave[t.id];
                    return (
                      <div className="bubble__actions">
                        <button
                          type="button"
                          className="btn-wiki-save"
                          title="Salvar esta resposta na wiki"
                          disabled={st === 'saving' || st === 'saved'}
                          onClick={() => void saveTurnToWiki(t.id, question, answer)}
                        >
                          {st === 'saved' ? <CheckIcon size={14} /> : <BookmarkIcon size={14} />}
                          <span>
                            {st === 'saving' ? 'salvando…' : st === 'saved' ? 'salvo na wiki'
                              : st === 'error' ? 'erro ao salvar' : 'salvar na wiki'}
                          </span>
                        </button>
                      </div>
                    );
                  })()}
```

(If the exact anchor `})()` / `{t.streaming && <span className="cursor" />}` differs slightly, place the block inside the assistant `bubble__content`/`bubble__body`, after the rendered content and gated on `t.role === 'assistant' && !t.streaming`. `parsed` is already computed at the top of the map for assistant turns.)

- [ ] **Step 4: Add the button style**

In `apps/seraphine/frontend/src/chat/obsidian.css`, add:

```css
.bubble__actions { margin-top: 6px; }
.btn-wiki-save {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border-radius: 8px;
  background: transparent; border: 1px solid var(--border, #333);
  color: var(--text-dim, #999); font-size: 12px; cursor: pointer;
}
.btn-wiki-save:hover:not(:disabled) { color: var(--accent, #9a93ff); border-color: var(--accent, #9a93ff); }
.btn-wiki-save:disabled { opacity: 0.7; cursor: default; }
```

- [ ] **Step 5: Typecheck / build**

Run (from repo root): `pnpm --filter seraphine-web build`
Expected: build sem erro de tipos. (Se `CheckIcon`/`BookmarkIcon` não existirem com esse nome, use os nomes reais exportados em `src/icons/Icons.tsx` — `BookmarkIcon` e `CheckIcon` foram confirmados presentes.)

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src/wiki/api.ts \
        apps/seraphine/frontend/src/chat/ChatView.tsx \
        apps/seraphine/frontend/src/chat/obsidian.css
git commit -m "feat(chat): 'salvar na wiki' button per assistant message"
```

---

## Task 5: Verificação E2E manual

**Files:** nenhum.

- [ ] **Step 1: Suíte verde**

Run (from `apps/seraphine/backend`): `uv run pytest tests/test_wiki_chat_ingest.py tests/test_wiki_routes.py tests/test_wiki_attachment_hook.py tests/test_attachments_content.py -v`
Expected: tudo verde.

- [ ] **Step 2: Chat → wiki**

Suba o backend local (cliproxy up). No chat, faça uma pergunta e receba uma resposta boa → clique **"salvar na wiki"** → o botão vira "salvo na wiki"; abra a aba **Wiki** e confira a página nova (com `raw/chat/<data>-<hash>.md` como fonte) e a linha `ingest(chat)` no `log.md`. Clique salvar de novo na mesma resposta → dedup (sem página duplicada).

- [ ] **Step 3: Anexo → wiki (Task 7)**

Anexe um PDF numa conversa e mande. Confira que `/data/wiki/raw/attachments/<id>.md` foi criado (captura fire-and-forget). Rode o `run_once` (ou espere o noturno) → o anexo vira página na wiki.

- [ ] **Step 4: Não-regressão do chat**

Confirme que o chat funciona normal (streaming, cards, aprovações MCP) — o botão só aparece em respostas do assistente já concluídas (`!streaming`).

---

## Self-Review (cobertura do spec)

- **Opt-in botão por resposta (Q&A), síncrono:** Task 4 (botão + handler) + Task 2 (rota síncrona). ✓
- **`ingest_chat_qa` espelha deepsearch, dedup por hash/raw-marker:** Task 1. ✓
- **`POST /wiki/ingest/chat` única rota de escrita, lê app.state:** Task 2 (503 guard). ✓
- **Task 7 hook de anexo → raw/attachments → noturno:** Task 3. ✓
- **`raw/chat` criado:** Task 1 (`wiki_root`). ✓
- **Read-only preservado:** só a rota de ingest escreve; nada muta memória. ✓
- **Sem toast infra → feedback inline por-turn:** Task 4. ✓
- **Chat-only v1, sem avatar/voz:** nenhuma task toca avatar. ✓
- **DRY sem refatorar o deepsearch já live:** Task 1 (ingest_chat_qa paralelo). ✓
