# LLM Wiki — chat→wiki (opt-in Q&A) + Task 7 (anexos como fonte)

**Data:** 2026-07-08
**Status:** Aprovado (aguardando review da spec)

## Problema / motivação

A LLM Wiki hoje compõe de **deep search** (noturno + on-demand) e **páginas de pessoa** (fatos/`people`). O **chat/avatar** — a superfície principal de interação — **não alimenta** a wiki. No padrão Karpathy, a conversa com o agente é o principal jeito de o conhecimento entrar na wiki (*"o LLM edita a wiki com base na nossa conversa"*), e o "arquivar o resultado valioso de uma query como página" é on-demand por definição. Além disso, os **anexos** (PDF/imagem) foram projetados como fonte mas o hook de captura (Task 7 da wiki) ficou adiado — `raw/attachments/` fica vazio.

Este incremento fecha os dois: **salvar um Q&A do chat na wiki** (opt-in) e **plugar a captura de anexo** (Task 7).

## Objetivo

1. Um botão **"salvar na wiki"** em cada resposta do assistente no chat → ingere aquele **Q&A** (resposta + a pergunta que a gerou) na wiki **na hora**, com feedback, reaproveitando o builder.
2. **Finalizar a Task 7:** plugar o hook fire-and-forget de captura de anexo em `attachments/content.py` → anexos usados no chat/avatar viram `raw/attachments/` → o noturno ingere.

## Decisões (brainstorm)

1. **Mecanismo chat→wiki:** **opt-in** (botão), não automático. O usuário decide o que vale.
2. **Unidade:** **mensagem (Q&A)** — a resposta do assistente + a pergunta anterior. Não conversa inteira.
3. **Síncrono com feedback:** a ação do usuário aguarda o ingest (1 chamada de LLM, poucos segundos) e retorna as páginas criadas → toast.
4. **Chat-only no v1:** o avatar (voz) não tem mensagem pra clicar; fica pra depois.
5. **Task 7 junto:** o hook de anexo (1 linha) entra neste incremento.

## Contexto do código (na main)

- `seraphine/wiki/builder.py`: `ingest_deepsearch_run(run, store, llm) -> list[str]` — ingest de uma fonte com dedup por raw-marker (raw escrito por último). `build_pages_from_source(source, existing_pages, llm)` + `apply_page_ops(ops, source_ref)`.
- `seraphine/wiki/capture.py`: `deepsearch_ref(run)` (computa ref sem escrever) + `export_deepsearch_run(run)` (escreve raw/research, idempotente).
- `seraphine/wiki/routes.py`: router `/wiki` (só GET hoje — index/page/graph/source).
- `seraphine/wiki/files.py`: `list_pages`, `write_index`, `append_log`, `wiki_root`, `slugify`.
- `seraphine/wiki/capture.py::capture_attachment(att_id, data, meta)` — JÁ EXISTE (Task 2 da wiki), escreve `raw/attachments/<id>.md`; hoje **ninguém chama** (Task 7 adiada).
- `seraphine/attachments/content.py::build_user_content(...)` — processa anexos no turno; ponto onde o hook de captura deve ser chamado.
- `run_once` já ingere `raw/attachments/*.md` no noturno (loop de anexo por mtime).
- Frontend `apps/seraphine/frontend/src/chat/ChatView.tsx` — renderiza mensagens; `src/api.ts` `API_BASE`.

## Arquitetura

```
[resposta do assistente no chat] → botão "salvar na wiki"
   → POST /wiki/ingest/chat { question, answer, title? }        (front já tem os textos)
        → builder.ingest_chat_qa(question, answer, store, llm)
             ├─ ref = chat/<data>-<hash8>.md    (hash8 = sha256(question+answer)[:8] → dedup)
             ├─ se raw já existe → return []  (já salvo)
             ├─ source = {ref, title, text: "Pergunta: …\n\nResposta: …"}
             ├─ ops = await build_pages_from_source(source, files.list_pages(), llm)
             ├─ touched = apply_page_ops(ops, ref)
             ├─ export_chat_qa(...) ESCREVE raw POR ÚLTIMO (marcador) ; files.write_index() ; append_log
             └─ return touched
   → 200 {pages: touched} → toast "Salvo na wiki: X" | "nada digno de página"

[anexo usado no chat/avatar] → build_user_content processa
   → asyncio.create_task(capture_attachment(att_id, data, meta))   (fire-and-forget)  ← Task 7
        → raw/attachments/<id>.md → noturno (run_once) ingere
```

### Generalização (DRY)
`ingest_deepsearch_run` e `ingest_chat_qa` são "ingest de uma fonte (ref/title/text) com dedup por raw-marker escrito por último". Extrair um helper genérico:
`ingest_source(*, ref, title, text, write_raw, store, llm) -> list[str]` onde `write_raw()` é o writer específico (deepsearch vs chat). Os dois `ingest_*` viram wrappers finos. (Decisão de fatorar fica na implementação; o comportamento é idêntico ao `ingest_deepsearch_run` atual.)

## Componentes

### 1. `capture.chat_qa_ref` + `capture.export_chat_qa` (novos)
- `chat_qa_ref(question, answer) -> str` — `chat/<YYYY-MM-DD>-<hash8>.md`, `hash8 = sha256((question+"\n"+answer).encode()).hexdigest()[:8]`. Determinístico (mesmo Q&A → mesma ref).
- `export_chat_qa(question, answer) -> str` — escreve `raw/chat/<ref>` (header + "Pergunta:/Resposta:"), idempotente (skip se existe). `wiki_root()` cria `raw/chat/`? Hoje cria `raw/research` e `raw/attachments`; adicionar `raw/chat` ao mkdir de `wiki_root`.

### 2. `builder.ingest_chat_qa(question, answer, store, llm) -> list[str]` (novo)
- Espelha `ingest_deepsearch_run`: dedup por raw-marker; build → apply → escreve raw por último → write_index? (não — deixa o caller/endpoint escrever index) → append_log. Retorna páginas tocadas.
- Nota: on-demand síncrono precisa que a página apareça no index já; então `ingest_chat_qa` (ou o endpoint) chama `files.write_index()` se tocou. (Espelhar o hook do deepsearch: `write_index()` só se `touched`.)

### 3. `POST /wiki/ingest/chat` (novo, em `wiki/routes.py`)
- Body: `{question: str, answer: str, title?: str}`. Valida não-vazio (400 se ambos vazios). Chama `ingest_chat_qa` (via `request.app.state.llm` + `request.app.state.store`), `write_index()` se tocou, retorna `{pages: [slugs], created: bool}`. Erros → 500 com detalhe.
- Esta é a **única rota de escrita** da wiki (ação explícita do usuário). O resto do `/wiki` continua read-only.

### 4. Frontend — botão "salvar na wiki" (`ChatView.tsx`)
- Em cada mensagem do assistente, um botão (ícone SVG de `Icons.tsx`, sem emoji) → pega o texto daquela resposta + a pergunta do usuário imediatamente anterior (do estado de mensagens) → `POST ${API_BASE}/wiki/ingest/chat` → toast de sucesso ("Salvo na wiki: X") / vazio / erro. Spinner no botão enquanto processa.
- `src/wiki/api.ts` ganha `ingestChatToWiki(question, answer, title?) -> {pages, created}`.

### 5. Task 7 — hook de captura de anexo (`attachments/content.py`)
- 1 linha fire-and-forget no `build_user_content`, no ponto onde o anexo carregado (`data`, `meta`, `att_id`) está disponível: `asyncio.create_task(capture_attachment(str(att_id), data, meta))` em try/except (nunca afeta o turno). Popula `raw/attachments/` → noturno ingere.

## Dados / dedup / erros

- Chat Q&A: dedup por hash de conteúdo (re-salvar mesmo Q&A → mesma ref → skip). Raw escrito por último = marcador (falha no meio → sem marcador → o usuário pode re-salvar; não há noturno pra chat, é opt-in).
- Endpoint retorna `created:false`/`pages:[]` quando o LLM não gera página → toast "nada digno de página".
- Task 7: fire-and-forget engole/loga; o noturno é a rede pra anexos.
- Read-only preservado: o único caminho de escrita via API é a ação explícita `POST /wiki/ingest/chat`; nada muta facts/people/deepsearch_runs.

## Fora de escopo (v1)

- Salvar conversa inteira; salvar no avatar/voz; auto-ingest de conversas (noturno varrendo chat); on-demand de anexo (fica no noturno); refresh live da aba Wiki.

## Testes

- **`capture.chat_qa_ref`**: determinístico (mesmo Q&A → mesma ref; Q&A diferente → ref diferente).
- **`builder.ingest_chat_qa`**: cria página + raw/chat; 2ª chamada do mesmo Q&A → `[]` sem re-buildar (LLM call-count); Q&A que gera 0 páginas → `[]`.
- **`POST /wiki/ingest/chat`**: app mínimo → 200 com pages; body vazio → 400; (LLM stub via injeção de `app.state.llm`).
- **Task 7**: `build_user_content` dispara `capture_attachment` (mock) e o conteúdo retornado segue igual (não regride os testes de anexo).
- **Frontend**: build/typecheck.
