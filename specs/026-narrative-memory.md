# 026 — Narrative Memory

## Context

Hoje Seraphine tem dois tipos de memória:

1. **Facts** (SQLite) — frases isoladas ("Casado com Aline", "Mac M4").
2. **Episodes** (Chroma) — turnos individuais vetorizados.

Falta um terceiro: **narrative** — resumos de histórico contados em
3ª pessoa, com timestamps relativos, conectando acontecimentos ao
longo do tempo. É isso que permite ela falar "faz 3 dias que você
tá nessa fase B" ou "da última vez que vocês foram pra praia…".

## 026-A — Episode Summaries

### Trigger

Depois de uma conversa longa (≥ 20 turns ou ≥ 20min inativa), um
job background:

1. Pega os turns da sessão.
2. LLM (Haiku, temperature 0.3) gera resumo em 3ª pessoa, 3-5 frases.
3. Salva em nova tabela `conversation_narratives`.

### Schema

```sql
CREATE TABLE IF NOT EXISTS conversation_narratives (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  text            TEXT NOT NULL,
  turn_count      INTEGER NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_narratives_created
  ON conversation_narratives(created_at DESC);
```

### Prompt

```
Resume a conversa em PT-BR, 3-5 frases, terceira pessoa.
Foque em:
- o que o usuário estava fazendo/sentindo
- decisões tomadas
- problemas resolvidos
- emoções relevantes

NÃO liste trivialidades. Escreva como uma entrada de diário dela
sobre ele.

Exemplo bom:
"Jonathan passou a manhã debuggando o build iOS e acabou encontrando
o bug no entitlement HealthKit. Ficou satisfeito quando funcionou no
iPhone dele. Também mencionou cansaço — dormiu pouco quarta."
```

### Uso

Narrativa entra no `recall_block` existente quando similaridade ≥ 0.7
com a query do usuário. Exemplo:

User: "o que aconteceu na semana passada com o build iOS?"
→ similarity bate → injeta narrativa → ela responde com contexto.

## 026-B — Temporal Reasoning

### Context

Hoje ela sabe "quando" só pelo timestamp, mas não verbaliza relativo
natural. Queremos:

- "faz 3 dias" (vs "2026-04-13")
- "ontem à noite"
- "na semana passada"
- "há 2 meses"

### Solução

Helper em `seraphine/conversation/temporal.py`:

```python
def humanize(dt: datetime, ref: datetime | None = None) -> str:
    ref = ref or datetime.now(TZ)
    delta = ref - dt
    if delta < timedelta(minutes=5): return "agorinha"
    if delta < timedelta(hours=1): return f"há {int(delta.total_seconds()//60)}min"
    if delta < timedelta(hours=6): return f"há {int(delta.total_seconds()//3600)}h"
    if delta < timedelta(hours=18) and dt.date() == ref.date():
        return "hoje mais cedo"
    if dt.date() == (ref - timedelta(days=1)).date():
        return "ontem"
    if delta < timedelta(days=7): return f"há {delta.days} dias"
    if delta < timedelta(days=14): return "semana passada"
    if delta < timedelta(days=60): return f"há {delta.days // 7} semanas"
    if delta < timedelta(days=365): return f"há {delta.days // 30} meses"
    return f"há {delta.days // 365} anos"
```

Aplica em: open loops created_at, episodes, fact provenance, events
timeline — quando qualquer um vira texto pra prompt/UI.

### Inclusão no prompt

No bloco de open loops (022-C), já tinha só o texto. Passa a ter:

```
OPEN LOOPS:
- Ele (há 3 dias): testar o build do sim
- Você (ontem à noite): lembrar da ligação pro Jefferson
```

Pequena mudança, grande melhora de coerência.

## 026-C — Shared Decisions Log

### Problema

Você diz "vou de A". Dias depois ela não pergunta "deu certo o A?".
Open loops resolve "comprometimentos de fazer", mas não "escolhas
tomadas entre opções".

### Solução

Nova tabela `decisions`:

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,         -- "qual stack pro raspa-bet"
  choice      TEXT NOT NULL,         -- "Laravel + Inertia"
  alternatives TEXT,                 -- "vs Next + tRPC"
  created_at  TEXT NOT NULL,
  followed_up_at TEXT,
  outcome     TEXT                    -- "deu certo"|"abandonei"|"ainda rodando"
);
```

### Extração

Piggybacks no mesmo ciclo do reflect/open_loops. Novo prompt extrator
pede "decisões tomadas na conversa recente: subject + choice +
alternatives". JSON array.

### Follow-up

Uma vez por semana (domingo no weekly scheduler ou trigger ad-hoc),
pega decisões sem `followed_up_at` e com `created_at` entre 3-14 dias
atrás. Adiciona ao backlog do próximo opener:

> "[curious] você decidiu ir de Laravel pro raspa-bet na quinta —
> como tá indo?"

Quando usuário responde, resolver aplica heurística: keywords
"deu certo / rodando / abandonei / mudei" → seta `outcome` +
`followed_up_at`.

## Entregáveis

- [ ] Tabelas `conversation_narratives`, `decisions`.
- [ ] `narrative/summarizer.py` com job + schema.
- [ ] `narrative/extractor.py` pra decisões.
- [ ] `seraphine/conversation/temporal.py` humanize helper.
- [ ] Wire-up no recall_block para narrativa.
- [ ] Wire-up no opener service pra decisions follow-up.
- [ ] Tests: humanize edge cases, narrative idempotency.

## Riscos

- **Narrative token cost**: 1 chamada Haiku por sessão longa. ~$0.01
  cada. Aceitável.
- **Privacidade**: narratives podem conter info sensível. Todo o DB
  já roda no VPS do usuário — escopo é single-tenant. OK.
- **Follow-up nag**: decisão followup pode virar chata. Max 1 por
  semana + só se passaram ≥ 3 dias da escolha.
