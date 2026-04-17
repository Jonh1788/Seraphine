# 073 — Long-running Autonomous Tasks

## Context

Usuário diz "pesquisa X e me traz até amanhã". Seraphine spawn um
sub-agente background que opera com seu próprio loop tool-use, e
reporta resultado quando terminar (push + bubble + conversation turn).

## Schema

```sql
CREATE TABLE background_tasks (
  id           TEXT PRIMARY KEY,
  goal         TEXT NOT NULL,
  status       TEXT NOT NULL,      -- pending | running | done | failed | cancelled
  progress     TEXT,               -- short status line
  iterations   INTEGER DEFAULT 0,
  result       TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  max_duration_min INTEGER DEFAULT 30
);
```

## Pipeline

Quando tool `start_background_task(goal, max_duration_min=30)` é
chamado:

1. Cria row com status=pending, retorna task_id imediatamente.
2. `BackgroundRunner` spawna asyncio.Task que:
   - Constrói sub-engine com subset seguro de tools (web_search,
     web_fetch, document_read, sem shell/fs write).
   - Itera: "qual o próximo passo?" → tool call → "próximo?" (max 15
     iterations ou max_duration expirou).
   - A cada iteração update `progress` na tabela.
3. Quando termina (done/failed/timeout), finaliza row.
4. Dispara push + bubble + envia WS event `background_task_finished`.

## Tools

- `start_background_task(goal, max_duration_min?)` — retorna id
- `list_background_tasks(status?)` — query
- `cancel_background_task(id)` — seta status=cancelled, sinaliza
  cancelamento (asyncio.Event)

## Routes

- `GET /background_tasks` — lista
- `GET /background_tasks/:id` — detalhe
- `POST /background_tasks/:id/cancel`

## Surfacing

Quando finaliza:
- Bubble no companion com primeiro resumo
- Push notification "pesquisa X pronta" → abre chat com resultado colado
- Entry no timeline

## Riscos

- **Runaway LLM cost**: hard cap iterations + token budget.
- **Tool misuse**: blacklist shell/fs.write/screen/send_email pra
  background. Só leitura de mundo.
- **Multiple running at once**: max 3 concurrent, senão enfileira.
