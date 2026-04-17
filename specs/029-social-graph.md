# 029 — Social Graph & Day Review

## Context

Hoje Seraphine trata "Aline", "Jefferson", "Pedro" como strings soltas
em facts. Falta estrutura pra lembrar threads sobre cada pessoa e
fechar o dia com reflexão.

## 029-A — Social Graph

### Schema

```sql
CREATE TABLE IF NOT EXISTS people (
  id              TEXT PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,
  relation        TEXT,             -- esposa, amigo, cliente, irmão
  first_seen_at   TEXT NOT NULL,
  last_mentioned_at TEXT NOT NULL,
  mention_count   INTEGER DEFAULT 1,
  tags            TEXT              -- JSON array: ["trabalho", "família"]
);

CREATE TABLE IF NOT EXISTS person_mentions (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id),
  turn_id      TEXT,
  context      TEXT NOT NULL,      -- 1-2 frases do que foi dito
  sentiment    TEXT,               -- positive|negative|neutral|worry
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mentions_person ON person_mentions(person_id, created_at DESC);
```

### Extração

Piggyback no mesmo ciclo do reflect: um prompt adicional extrai
"pessoas mencionadas + contexto + sentimento". NER simples (nomes
próprios capitalizados) + LLM refine.

Resolution: matching por nome (case-insensitive); se próximo, update
existing. Se novo, cria.

### Uso

1. Quando usuário menciona nome, recall block adiciona histórico:

```
SOBRE ALINE (última menção há 5 dias, 23 menções totais):
- "Aline tava com enxaqueca" (há 5 dias, worry)
- "Aniversário de namoro 12/06" (há 2 semanas, positive)
```

2. Proactive follow-up: depois de 7 dias sem menção de pessoa com
   tag=família ou context=worry:
   "[curious] faz uma semana que não fala da Aline, tá tudo bem com ela?"

3. UI nova em Memórias: tab "Pessoas" lista top N mencionadas.

## 029-B — Day in Review

### Trigger

APScheduler cron 21:00 diário (configurável via
`SERAPHINE_DAY_REVIEW_HOUR=21`). Só dispara se ≥ 3 turns no dia.

### Conteúdo

LLM Haiku monta reflexão:

- tarefas fechadas hoje
- tarefas abertas
- health signal (sono/passos) se disponível
- 1-2 pessoas que apareceram (social graph)
- mood predominante do dia
- 1-2 decisões tomadas (via 026-C)

Formato: 3-5 frases PT-BR + 1 pergunta de reflexão.

### Exemplo

> [soft] Dia pesado em deploys — 4 fechados. Você mencionou a
> Aline 2x, parece que ela tá cansada. Focou bem mas comeu menos
> do que ontem. Como você tá se sentindo agora?

### Entrega

Via `assistant_opener` se WS conectada. Senão via push notification
(silent priority — não acorda). Ou salva como `daily_reflection` que
usuário lê quando abrir.

```sql
CREATE TABLE IF NOT EXISTS daily_reflections (
  id         TEXT PRIMARY KEY,
  date       TEXT UNIQUE NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_response TEXT,              -- se ele respondeu, captura
  responded_at TEXT
);
```

### Continuity

Se usuário responde, a resposta vira fact + alimenta mood/emo tracker.
Se não responde em 12h, esquece (não cobra).

## Entregáveis

- [ ] Schemas: `people`, `person_mentions`, `daily_reflections`.
- [ ] `seraphine/social/extractor.py` — NER + sentiment.
- [ ] `seraphine/social/service.py` — upsert, history query.
- [ ] Recall block injeta histórico de pessoa quando mencionada.
- [ ] Routes: `GET /memory/people`, `GET /memory/reflections`.
- [ ] Frontend: aba "Pessoas" em MemoryView.
- [ ] Scheduler job Day in Review.
- [ ] Tests: extraction, resolution, reflection idempotency.

## Riscos

- **Ambiguidade de nome**: "Pedro" pode ser 3 Pedros diferentes.
  MVP: user é único Jonathan, raro ter colisão. Segunda fase: adiciona
  desambiguação por contexto.
- **Sentiment wrong**: às vezes neutro vira positivo. Tolerável —
  afeta só follow-up timing.
- **Reflection redundante com weekly**: dia = micro, semana = macro.
  OK por enquanto. Podem ser silenciados separadamente.
