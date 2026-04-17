# 030 — Ambient Watchers

## Context

Jobs em background que monitoram sinais externos e ocasionalmente
surfaceiam algo interessante para o usuário, sem ele pedir. Dois
watchers:

- **030-A** — Curiosity Engine (descobertas em interesses do perfil)
- **030-B** — Finance Awareness (anomalias Wise/Nubank)

## 030-A — Curiosity Engine

### Ideia

1x/dia, Seraphine usa `web_search` em tópicos dos interests do perfil
(de 029: tech stack, bands, projetos, etc.) e procura novidades
relevantes das últimas 48h. Classifica: vale mencionar?

### Schema

```sql
CREATE TABLE IF NOT EXISTS discoveries (
  id           TEXT PRIMARY KEY,
  topic        TEXT NOT NULL,       -- "Bonobo", "Laravel 12"
  headline     TEXT NOT NULL,
  url          TEXT NOT NULL,
  summary      TEXT,
  mentioned    INTEGER DEFAULT 0,   -- 0|1
  mentioned_at TEXT,
  created_at   TEXT NOT NULL,
  score        REAL                  -- relevance 0..1
);
```

### Pipeline diário

```python
async def curiosity_tick():
    interests = await profile.get_interests()  # top 10
    for topic in interests:
        results = await web_search(f"{topic} novidade 48h", site=None)
        scored = await llm_score_relevance(topic, results)
        for r in scored:
            if r.score > 0.7 and not await already_stored(r.url):
                await store.add_discovery(r)
```

### Ativação

- Hook em `openers/service.py`: se tem discovery com score > 0.8 e
  mentioned=0, adiciona como `opener_extras`.
- Uma menção por sessão. "[curious] vi que o Bonobo lançou EP ontem —
  escutou?"
- Após menção, `mentioned=1`. Se usuário reage positivo, score de
  "Bonobo" sobe (aprende no style_prefs).

### Aba "Descobertas"

UI simples: lista de discoveries não-mencionadas com link. Usuário
pode curtir/descartar pra dar feedback explícito.

## 030-B — Finance Awareness

### Fonte

`seraphine/tools/wise.py` + extratos Nubank (se já integrados). Hoje
só faz transações sob comando. Adicionar fetch periódico de últimos
gastos:

```python
async def finance_ambient_tick():
    recent = await wise.get_transactions(days=7)
    categorized = await categorize_transactions(recent)
    await store.save_finance_snapshot(categorized)
    anomalies = detect_anomalies(categorized, history=30)
    for a in anomalies:
        await store.add_finance_nudge(a)
```

### Anomaly detection

Compara média móvel 30d por categoria vs week atual:

- > 2× média e > R$100 delta → anomalia
- gastos inéditos em categoria (primeira vez em 60d)
- queda brusca (pode ser bug ou intencional — silencia)

### Nudge

`finance_nudges` table. Injeta no prompt em turno apropriado ou
opener se contexto permite.

> "[curious] vi que gastou 2x mais em delivery essa semana — algo
> especial?"

Nunca julga ("você gastou demais"). Sempre pergunta.

## Entregáveis

- [ ] Schema: `discoveries`, `finance_snapshots`, `finance_nudges`.
- [ ] `seraphine/curiosity/engine.py` + scheduler.
- [ ] `seraphine/finance/ambient.py` + anomaly detector.
- [ ] Routes: `GET /discoveries`, `POST /discoveries/:id/react`.
- [ ] Hook em opener_service para ambos.
- [ ] UI: aba "Descobertas" em chat sidebar.
- [ ] Tests: anomaly detection, dedup.

## Riscos

- **Web search noise**: topic="Mac" retorna milhões de hits
  irrelevantes. LLM scorer com threshold alto (0.7+). Tópicos do
  profile precisam ser específicos ("Mac M4 Pro Max" vs "Mac").
- **Privacidade financeira**: se VPS comprometido, dados sensíveis.
  Mesmo ponto do 023 — single-tenant + encrypted at rest (SQLite
  cipher opcional).
- **Anomaly false positives**: sexta-feira gasto em delivery é normal,
  não vira nudge toda semana. Dedup por categoria/semana.
