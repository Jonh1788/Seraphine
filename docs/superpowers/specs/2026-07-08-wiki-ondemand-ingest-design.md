# LLM Wiki — ingest on-demand de deepsearch (Deep-only)

**Data:** 2026-07-08
**Status:** Aprovado (aguardando review da spec)

## Problema / motivação

O piloto da LLM Wiki (na main) só monta a base no **job noturno**. Isso quebra o coração do padrão do Karpathy — o **loop de composição imediato**: pesquisar algo → vira conhecimento **agora** → a próxima pergunta já usa. Com 24h de latência, você pesquisa e só amanhã entra na wiki. O modo default do Karpathy é **on-demand/interativo** (ingest disparado na hora; o noturno é só a passada periódica de consolidação/lint).

Este upgrade fecha o maior gap com o menor recorte: **toda pesquisa Deep concluída ingere na hora**.

## Objetivo

Quando uma pesquisa **modo Deep** termina, ingerir aquele run na wiki **imediatamente** (fire-and-forget, sem atrasar/quebrar a pesquisa), reaproveitando o `builder` que já existe. O job noturno vira **rede de segurança** (pega o que o on-demand perdeu) + consolidação/lint/person pages. Backend puro, sem frontend.

## Decisões (brainstorm)

1. **Gatilho:** só pesquisas **Deep** concluídas ingerem automaticamente. **Quick não** (matéria rasa não polui a base).
2. **Fire-and-forget:** o ingest roda em background a partir do `_finalize`; nunca bloqueia nem quebra a resposta da pesquisa.
3. **Dedup:** um run é ingerido **exatamente uma vez** — quem chegar primeiro (quase sempre o on-demand) escreve o `raw/` + monta as páginas; o outro caminho vê o `raw` e pula. Sem chamada de LLM duplicada.
4. **Sem frontend:** automático; a página nova aparece ao abrir/atualizar a aba Wiki. Refresh live é futuro.

## Contexto do código (na main)

- `seraphine/wiki/builder.py`: `run_once(store, llm, deepsearch_service)` já ingere runs novos por watermark chamando `export_deepsearch_run` + `build_pages_from_source` + `apply_page_ops`. A lógica por-run está inline no loop.
- `seraphine/wiki/capture.py`: `export_deepsearch_run(run) -> ref|None` — idempotente (se o `raw/research/<ref>.md` existe, retorna o ref sem reescrever).
- `seraphine/deepsearch/service.py`: `DeepSearchService._finalize(...)` grava o run terminal (status/report/sources/finished_at). O serviço tem `self.store` e `self.llm`. Campos do run: `id, query, mode ("quick"|"deep"), status, report, sources, created_at, finished_at`.
- Job noturno: `_wiki_build_loop` em `main.py` chama `run_once`.

## Arquitetura

```
Pesquisa Deep conclui
   └─ DeepSearchService._finalize() grava o run terminal
        └─ if mode=="deep" and status=="done":
             asyncio.create_task( _wiki.ingest_deepsearch_run(run, store, llm) )   # fire-and-forget
                   ├─ export_deepsearch_run(run)  → raw/research/<ref>.md  (idempotente)
                   │     └─ se já existia → SKIP (já ingerido) → return []
                   ├─ build_pages_from_source(source, list_pages(), llm) → apply_page_ops(ops, ref)
                   ├─ files.write_index()  + files.append_log("ingest(on-demand) | <query> -> <páginas>")
                   └─ return touched

Job noturno (run_once)  → reusa ingest_deepsearch_run por run (self-dedup) → rede de segurança
                          + build_person_pages + lint  (inalterados)
```

## Componentes

### 1. `builder.ingest_deepsearch_run(run, store, llm) -> list[str]` (novo, extraído)
- Extrai a lógica por-run que hoje vive inline no loop de deepsearch do `run_once`.
- Passos: `ref = export_deepsearch_run(run)`; se `ref is None` (report vazio) → `[]`. **Dedup:** se o arquivo `raw/research/<ref>` **já existia antes** desta chamada → `[]` (já ingerido). Senão: `ops = await build_pages_from_source({ref, title:query, text:report}, files.list_pages(), llm)`; `touched = apply_page_ops(ops, ref)`; se `touched`: `files.append_log(...)`; retorna `touched`.
  - Como `export_deepsearch_run` já é idempotente mas não sinaliza "já existia", o dedup checa `path.exists()` **antes** de exportar (ou `export_deepsearch_run` passa a retornar `(ref, created: bool)`). Escolha na implementação; o contrato é: **raw já existe → não re-buildar**.
- **Não** escreve `index` (deixa pro caller, pra o noturno escrever uma vez só).

### 2. `run_once` reusa `ingest_deepsearch_run`
- O loop de deepsearch do `run_once` passa a chamar `ingest_deepsearch_run(run, store, llm)` por run (em vez da lógica inline). Continua filtrando por `created_at > watermark` (barato) mas o dedup interno evita re-build do que o on-demand já fez. `write_index` + `lint` + person pages continuam como estão (uma vez no fim).

### 3. Hook no `DeepSearchService._finalize`
- Após gravar o run terminal, se `mode=="deep"` e `status=="done"` e `report` não-vazio: `asyncio.create_task(_ingest())`, onde `_ingest` faz um **lazy import** de `seraphine.wiki.builder` e chama `ingest_deepsearch_run(run_dict, self.store, self.llm)` seguido de `files.write_index()` se algo foi tocado. Tudo em try/except (fire-and-forget — nunca propaga pro `_finalize`).
- O `run_dict` é montado a partir dos dados que o `_finalize` já tem (ou reusa `_run_row_to_dict`).

## Dados

`ingest_deepsearch_run` consome o run como dict `{id, query, report, created_at, status, mode}` — mesmo shape que o `run_once` já usa. Nenhuma tabela nova, nenhum watermark novo.

## Erros / limites

- **Fire-and-forget** engole e loga erro; a pesquisa nunca é afetada. Se o on-demand falhar, o **noturno pega depois** (rede de segurança).
- **Concorrência:** é ferramenta pessoal single-user; escritas de arquivo (`write_page`/`write_index`) não têm lock. Dois ingests simultâneos (raro: duas Deep terminando junto, ou on-demand + noturno) podem interleavar escrita do `index.md` — cosmético e auto-curado na próxima escrita. Sem lock no v1 (anotado).
- Dedup garante zero LLM duplicado entre on-demand e noturno.

## Fora de escopo (v1 deste upgrade)

- Opt-in / botão "salvar na wiki"; ingest a partir do chat.
- Ingestão de Quick.
- Refresh live da aba Wiki.
- Hook de captura de anexo (Task 7 da wiki — segue separada).
- Demote total do noturno (ele continua como rede de segurança + consolidação).

## Testes

- **`ingest_deepsearch_run`:** run com report → cria `raw/research/*` + página + log; 2ª chamada (raw já existe) → `[]` sem re-buildar (LLM stub conta chamadas); report vazio → `[]`.
- **`run_once`:** continua ingerindo runs novos; um run já ingerido on-demand (raw presente) não é re-buildado (dedup); person/lint intactos.
- **Hook `_finalize`:** com um serviço stub, um run `mode="deep"/done` agenda o ingest (mock de `ingest_deepsearch_run` recebe a chamada); um run `mode="quick"` **não** agenda.
