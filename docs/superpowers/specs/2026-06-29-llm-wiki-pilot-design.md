# LLM Wiki (padrão Karpathy) — piloto read-only na Seraphine

**Data:** 2026-06-29
**Status:** Aprovado (aguardando review da spec)

## Problema / motivação

A memória da Seraphine hoje é um **fact-store atômico + retrieval com boost RRF por categoria** — exatamente o que Karpathy critica no seu "LLM Wiki": fatos fragmentados, redescobertos a cada pergunta, sem uma camada sintetizada que **componha** ao longo do tempo. Ao mesmo tempo, pesquisas caras do **deepsearch** evaporam (o `report` fica numa linha do banco, nunca vira conhecimento reaproveitável), e o frontend já é um **reskin Obsidian** — ou seja, a Seraphine já tem "os dois lados" (IDE + programador) num app só.

O padrão Karpathy: uma base de conhecimento em **markdown mantida pelo próprio LLM**, em 3 camadas — `raw/` (fontes imutáveis, LLM lê e nunca escreve), `wiki/` (páginas derivadas, dono = LLM), e um `index.md` + `log.md`. Operações: **ingest** (uma fonte toca N páginas: extrai, cruza refs, loga), **query**, **lint**. Tese: o custo real de uma KB é o *bookkeeping*, e "LLM não entedia, não esquece de atualizar um link, toca 15 arquivos numa passada".

## Objetivo (v1 = piloto read-only)

Um **piloto read-only** que valida o padrão sem risco: um job noturno sintetiza `/data/wiki` (markdown) a partir de deepsearches + anexos + fatos existentes, com citações; uma aba "Wiki" no app renderiza as páginas (markdown) e um **grafo** navegável. **Não muta o fact-store nem entra no retrieval do chat.** Se a wiki estragar, apaga `/data/wiki` e reconstrói — o fact-store continua a verdade-fonte.

## Decisões (brainstorm)

1. **Escopo:** piloto **read-only** — sem mutação de memória, sem integração com retrieval do chat.
2. **Fontes:** deepsearch (`deepsearch_runs`) + anexos (via hook de captura) + fatos existentes (`facts`/`people`, leitura only).
3. **UI:** viewer markdown **+ grafo** (estilo Obsidian).
4. **Cadência:** **batch noturno** (sem on-demand no v1).
5. **Grafo:** dep nova **`react-force-graph-2d`** (canvas, leve; app já tem ecossistema three/canvas).
6. **Entidades v1:** só páginas de **pessoa** (tabela `people` existe). Páginas de projeto ficam fora de escopo.
7. **Maintainer:** loop asyncio (espelha `_memory_audit_loop`), com **LLM controlado** (saída estruturada; código aplica os writes), não agente solto.

## Contexto do código (confirmado)

- **deepsearch persiste:** `deepsearch_runs` (`deepsearch/schema.py:17`) — colunas `id, query, mode, status, report, sources, created_at (indexado), finished_at`. Read API `DeepSearchService.list_runs()` (`deepsearch/service.py:223`); mora no DB compartilhado do `MemoryStore`.
- **fact-store:** `facts` (`memory/store.py:167` + migrators `category` :432, `pinned` :458), categorias fixas (`_derive_fact_category` :61: METAS/TRABALHO/ROTINA/PESSOAS/LOCAL/PREFERENCIA/OUTROS). Entidade de 1ª classe = **`people`** (`store.py:273`) + `person_mentions` (:284). Read: `list_facts()` (:976), `list_pinned_facts()` (:1026). Projetos NÃO são entidade.
- **anexos são efêmeros** (staging TTL 24h; texto extraído não persiste) → precisam de hook de captura.
- **scheduler:** dois padrões — cron sync no `proactive_scheduler._sched.add_job(...)` (housekeeping) e **loop asyncio** (`_memory_audit_loop`, `main.py:1056`). O nosso chama LLM async → loop asyncio, capturando `app.state.llm` (AnthropicClient/cliproxy) do escopo do lifespan; cancelar no `finally`.
- **data dir:** `Path(settings.sqlite_path).parent` = `/data`; convention `SERAPHINE_DATA_DIR` (cv_triage) e `SERAPHINE_LAB_DATA_DIR` (lab — no VPS DEVE apontar pro volume persistente). Wiki: `Path(settings.sqlite_path).parent / "wiki"`, overridável por novo env `SERAPHINE_WIKI_DATA_DIR`.
- **frontend:** `react-markdown` + `remark-gfm` + `rehype-raw` já presentes/usados (`research/ResearchView.tsx:591`); **sem lib de grafo**; `obsidian.css` já existe. Tabs = switch Zustand `activeView` (3 toques: `stores/uiStore.ts:3`, `navItems` em `AppLayout.tsx:292`, render block :543). `api.ts` espelha `notes/api.ts`.
- **colisão — Notes:** já existe feature **Notes** (markdown CRUD + backlinks `note_links` + grafo) — humano-autoral. A Wiki é distinta (LLM-mantida, derivada, read-only pro humano) → rota/armazenamento **separados** (`wiki`, não `notes`).

## Arquitetura

```
/data/wiki/                (volume persistente no VPS — como o lab)
  raw/                     # fontes imutáveis (LLM lê, nunca escreve)
    research/2026-06-29-<slug>.md      export de deepsearch_runs (status=done)
    attachments/2026-06-29-<nome>.md   texto extraído (via hook)
  wiki/                    # páginas derivadas (dono = LLM)
    <slug>.md
  index.md                 # catálogo: slug, título, resumo 1-linha, categoria
  log.md                   # append-only: [data] ingest | fonte → páginas tocadas
```

**Formato de página** (`wiki/<slug>.md`), frontmatter YAML + corpo markdown:
```
---
title: <Conceito ou Pessoa>
category: topic | person
updated_at: <iso8601>
sources: [raw/research/2026-06-29-x.md, raw/attachments/2026-06-29-y.md]
links: [Outra Página, Mais Uma]
---
<síntese em markdown, com citações inline [^1] apontando pro raw/>
```
Links entre páginas em sintaxe `[[Título]]` no corpo (parseável pro grafo).

## Componentes

### 1. `raw/` capture (backend)
- **deepsearch → raw/research:** o job noturno lê `deepsearch_runs` (status=done, `created_at` > watermark) e escreve cada report em `raw/research/<date>-<slug>.md` (raw/ autocontido). Read-only sobre o deepsearch.
- **anexos → raw/attachments (HOOK):** único toque fora do módulo wiki — em `seraphine/attachments/content.py` (ou no ponto onde a engine processa o anexo), quando um PDF/imagem é processado, persistir o texto extraído/descrição em `raw/attachments/<date>-<nome>.md`. Idempotente (não duplica o mesmo arquivo/turn).
- **facts/people:** NÃO copiados pro raw/ (já são destilados, vivem no DB). O job lê `list_facts()` + `people` read-only e sintetiza páginas de pessoa direto.

### 2. Maintainer job (`seraphine/wiki/builder.py`)
- Loop asyncio no lifespan (espelha `_memory_audit_loop`), intervalo `settings.wiki_build_interval_s` (default 24h). Watermark em KV `wiki_last_ingest_at` (estilo o fingerprint do memory audit).
- Passada: (a) exporta deepsearch novos → raw/; (b) para cada fonte nova (raw/research + raw/attachments desde o watermark), **1 chamada LLM com saída estruturada** propondo `{páginas a criar/atualizar: [{slug, title, category, body, links, source_ref}]}`; **o código aplica** os writes em `wiki/`, atualiza `index.md` e `log.md`; (c) sintetiza/atualiza páginas de pessoa a partir de `people`+facts; (d) **lint leve**: valida integridade do index e links quebrados, loga. Avança watermark no fim.
- Isolamento: funções puras testáveis (`build_pages_from_source(source, existing_index, llm) -> PageOps`, `apply_page_ops(ops, wiki_dir)`, `rebuild_index(wiki_dir)`, `lint(wiki_dir) -> report`). O loop só orquestra.

### 3. Store/leitura (`seraphine/wiki/store.py`)
- Helpers de filesystem: `wiki_dir()`, `list_pages() -> [meta]`, `read_page(slug) -> (frontmatter, body)`, `read_index()`, `graph() -> {nodes, edges}` (deriva de `links`/`[[..]]`), `read_source(ref)`. Traversal-safe (slug/ref validados).

### 4. API (`seraphine/wiki/routes.py`, prefix `/wiki`)
- `GET /wiki/index` → `[{slug, title, summary, category, updated_at}]`.
- `GET /wiki/page/{slug}` → `{title, category, body, sources, backlinks, updated_at}`.
- `GET /wiki/graph` → `{nodes:[{id,title,category}], edges:[{source,target}]}`.
- `GET /wiki/source/{ref}` → conteúdo do arquivo raw (click da citação). `ref` validado (só dentro de raw/).
- Router registrado em `main.py` (padrão `images_router`).

### 5. Frontend — aba Wiki (`src/wiki/`)
- 3 toques: `stores/uiStore.ts` (add `'wiki'` ao union), `AppLayout.tsx` navItem no grupo "Conhecimento", render block + import.
- `WikiView.tsx`: layout duas colunas — grafo (react-force-graph-2d) + painel de página (react-markdown +gfm/raw, reusa `obsidian.css`). Clique no nó → carrega a página; `[[links]]` e citações `[^n]` clicáveis (citação → `GET /wiki/source/{ref}`).
- `src/wiki/api.ts` espelha `notes/api.ts` (`request<T>` sobre `fetch(${API_BASE}...)`).
- Dep nova: `react-force-graph-2d`.

## Fluxo de dados

```
deepsearch_runs (done, novos) ─┐
attachments (hook) → raw/attachments ─┼─► builder (LLM estruturado + código aplica) ─► wiki/*.md + index.md + log.md
facts + people (read-only) ────┘                                                        │
                                                                                        ▼
                                                          API /wiki/{index,page,graph,source} ─► WikiView (viewer + grafo)
```

## Erros / limites

- Fonte sem conteúdo extraível (PDF escaneado sem texto) → pula, loga no `log.md`.
- LLM devolve JSON inválido → descarta a proposta daquela fonte, loga, não avança watermark daquela fonte (retry na próxima noite). Espelha o `_parse_audit_json` do memory audit.
- Slug/ref com traversal → 400/404 na API; validação estrita.
- VPS: `/data/wiki` DEVE ficar no volume persistente (senão some no rebuild) — documentar como o `lab`.

## Fora de escopo (v1)

- Retrieval da wiki no chat/avatar (injeção de nota inteira).
- Ingest on-demand / botão "ingerir agora".
- Detecção de contradição e dedup avançado (só lint leve).
- Páginas de projeto (clusterizar fatos TRABALHO).
- Chats marcados como fonte.
- Sync com vault Obsidian real do usuário.
- Mutação do fact-store a partir da wiki.

## Testes

- **Backend (unit):** `build_pages_from_source` com LLM stub → `PageOps` esperado; `apply_page_ops` num tmp dir → arquivos/frontmatter certos; `rebuild_index`; `lint` detecta link quebrado/órfão; `graph()` deriva nós/arestas de `[[links]]`; watermark idempotente (rodar 2x não duplica); traversal-safety de slug/ref.
- **Backend (API):** app mínimo com o router → index/page/graph/source (200 + shapes; 404 em slug inexistente; 400 em traversal).
- **Frontend:** build/typecheck.
- **E2E manual:** rodar o builder uma vez com 1 deepsearch + 1 anexo + facts → conferir páginas, citações, index/log, e o grafo na aba.
