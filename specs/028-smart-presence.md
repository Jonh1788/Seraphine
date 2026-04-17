# 028 — Smart Presence

## Context

Três aprendizados sobre o usuário que tornam Seraphine "inteligente" em
como ela se comporta:

- **028-A** — Attention model: deep focus vs casual vs stressed.
- **028-B** — Anticipatory suggestions: padrões recorrentes (ex: "toda
  quarta checa o clima") ela antecipa.
- **028-C** — Meta-learning: ela loga reações do usuário e ajusta
  estilo/tom sozinha (RLHF caseiro leve).

Nada disso cria UI nova — tudo roda como ajustes de prompt e decisões
de scheduler.

## 028-A — Attention Model

### Inferência

`AttentionState` com 3 níveis: `deep_focus` | `casual` | `stressed`.
Deriva de:

- `rate_wpm` (prosody), `rms_avg`: alto + contínuo → stressed
- Turn density (N turns / tempo): alto + técnico → casual
- Turns longos + tool-heavy + poucos turns/min → deep_focus
- Gaps > 5min entre turns → casual default

### Uso

- `deep_focus` → opener rate limit 4h, nudges desligados, mood
  injection suprimida
- `stressed` → "concerned" mood auto, open loops não injetados
- `casual` → comportamento default

Estado vive na `ConversationEngine` (não persiste — re-deriva).

## 028-B — Anticipatory Suggestions

### Detecção

Background job diário analisa o timeline: se ação X ocorre em padrão
(mesmo dia-da-semana ou hora ± 1h, por ≥ 3 semanas), cria
`anticipation_rule`:

```sql
CREATE TABLE IF NOT EXISTS anticipation_rules (
  id           TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL,   -- 'time_pattern'
  schedule     TEXT NOT NULL,   -- cron-ish
  action       TEXT NOT NULL,   -- "weather_check" | "task_list_review"
  confidence   REAL NOT NULL,
  last_fired_at TEXT
);
```

### Ativação

Scheduler checa regras. 15min antes do horário previsto, injeta fato
no prompt para o próximo turno:

```
ANTICIPATION: o usuário geralmente checa clima toda quarta ~14h.
É quarta 13:45. Se couber, antecipe sem ser obvio.
```

Max 1 antecipação/dia pra não ficar auto-predictivo demais.

## 028-C — Meta-learning

### Sinais de feedback

- **Positivo**: usuário agradece, reage com "kkk", "perfeito", "show",
  repete a ação dela.
- **Negativo**: "não, não era isso", "chato", corrige, ignora próximo
  turno, usa interrupt.

Cada turn do assistente ganha um registro:

```sql
CREATE TABLE IF NOT EXISTS turn_feedback (
  turn_id      TEXT PRIMARY KEY,
  tone         TEXT,          -- inferred: formal|casual|playful|...
  length_bucket TEXT,         -- short|medium|long
  tool_used    TEXT,
  reaction     TEXT,          -- positive|negative|neutral
  created_at   TEXT NOT NULL
);
```

Classifier leve (regex + keyword) analisa a resposta do USUÁRIO
subsequente e preenche `reaction`.

### Aplicação

Semanalmente, job agrega: quais combos (tone × length × context)
tiveram mais positivo. Atualiza uma tabela `style_prefs`:

```
prefer: curto em conversas técnicas, playful em casual
avoid: longo em deep_focus
```

Injeta como system prompt:

```
STYLE PREFS (aprendido): {...}
```

Começa vazio, cresce com uso.

## Entregáveis

- [ ] `conversation/attention.py` com AttentionState + derivation.
- [ ] Schema: `anticipation_rules`, `turn_feedback`, `style_prefs`.
- [ ] `anticipation/detector.py` + `anticipation/scheduler.py`.
- [ ] `metalearning/classifier.py` + job semanal agregador.
- [ ] Wire-up no engine + opener service + scheduler.
- [ ] Tests: attention inference, feedback classifier, style agg.

## Riscos

- **Over-fitting**: meta-learning com poucos dados vira viés. Só ativa
  depois de 200 turns coletados.
- **False anticipations**: achar padrão em ruído. Confidence threshold
  ≥ 0.8 + min 3 semanas.
- **Stressed suprimir opener = ela some quando mais precisaria**:
  nope, é proposital. Invadir alguém stressado piora.
