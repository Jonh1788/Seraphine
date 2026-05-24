# Seraphine Freshness Policy — Design

**Status:** aprovado para implementação
**Data:** 2026-05-23
**Owner:** Jonathan
**Componente:** `apps/seraphine/backend/seraphine/freshness/` (novo módulo)

## 1. Problema

Toda vez que o usuário abre o Seraphine, o opener (primeira mensagem da assistente) referencia coisas obsoletas:

> "oi, voltou. aquela reserva no Cana Brava tá puxando pro final do mês — quer que a gente organize logo?"

ou

> "ainda quer comprar refrigerante? Você tinha falado nas compras."

Esses itens já passaram, foram resolvidos sem o sistema saber, ou nunca eram urgentes a ponto de virar gancho recorrente. O usuário não vê ferramenta no UI pra "calar" o item, então ele só repete eternamente.

O mesmo problema aparece em respostas mid-conversação (a Seraphine "confabula" sobre Cana Brava aleatoriamente) e no `day_review` automático das 21:00.

## 2. Causa raiz (do explorador)

O opener (`openers/service.py:121-217`) e o engine de conversa (`conversation/engine.py:775-913`) puxam contexto de várias fontes — `seraphine_tasks`, `open_loops`, `facts`, `discoveries`, vector recall — e **nenhuma delas tem filtro de recência**. Os DAOs (`memory/store.py`, `mod_tasks/service.py`, etc.) listam tudo "aberto" sem TTL.

Além disso, o prompt do opener (`openers/service.py:33-63`, regra #5) **força** o LLM a inventar "gancho CONCRETO (tarefa, horário, coisa que ele disse antes...)". Quando o contexto vem cheio de coisa velha, o modelo escolhe a mais saborosa.

Resultado: a UI lista 5 tarefas pendentes que o user esqueceu, e a Seraphine pega a #3 (Cana Brava de 2 meses atrás) como "gancho concreto".

## 3. Decisões de produto (aprovadas)

| Aspecto | Decisão |
|---|---|
| Comportamento quando nada fresco | Cumprimento leve (oi/voltou/bom dia) **sem hook**; LLM proibido de inventar gancho |
| Itens com data | Surface só em duas janelas: **primeira semana após criar** + **N dias antes do evento** + 1 dia pós-evento (recall) |
| Itens sem data, velhos | **Auto-arquivar após ~30 dias** (sumir das queries de "aberto" de toda Seraphine) |
| Escopo | Tudo: opener WS, day_review 21h, per-turn engine context, vector recall |

## 4. Arquitetura

```
                ┌─────────────────────────────────────────────────┐
                │ apps/seraphine/backend/seraphine/freshness/     │
                │                                                 │
                │  ┌───────────────────────────────────────────┐  │
                │  │ policy.py                                 │  │
                │  │   FreshnessPolicy.from_env()              │  │
                │  │   .is_fresh(created_at, event_date?)      │  │
                │  │   .is_stale(created_at, event_date?)      │  │
                │  │   .sql_fresh_filter(created_col, ...)     │  │
                │  └───────────────────────────────────────────┘  │
                │                  │                              │
                │                  │ usado por                    │
                │  ┌───────────────┴───────────────────────────┐  │
                │  │ housekeeping.py                           │  │
                │  │   archive_stale(conn, policy) ─► report   │  │
                │  └───────────────────────────────────────────┘  │
                │                                                 │
                │  ┌───────────────────────────────────────────┐  │
                │  │ schema.py                                 │  │
                │  │   migrate(conn): ALTER facts ADD          │  │
                │  │   archived_at + indexes                   │  │
                │  └───────────────────────────────────────────┘  │
                └─────────────────┬───────────────────────────────┘
                                  │ importa
            ┌─────────────────────┼─────────────────────────────┐
            │                     │                             │
            ▼                     ▼                             ▼
    DAOs (5 fontes)         openers/service.py        proactive/scheduler.py
    ganham fresh_only       call sites usam           cron 04:30 archive_stale
    (Tasks, OpenLoops,      fresh_only=True
    Facts, Discoveries,
    Finance nudges)
                                  ▼
                          conversation/engine.py
                          per-turn context blocks
```

## 5. Política de frescor (`policy.py`)

Fonte única de verdade pra "o que é fresh".

### Regras

| Caso | Regra | Default | Env override |
|---|---|---|---|
| Sem data, recém-criado | `now - created_at ≤ RECENCY_HOURS` | 72h | `FRESHNESS_RECENCY_HOURS` |
| Com data, janela pós-criação | `now - created_at ≤ POST_CREATE_DAYS` | 7d | `FRESHNESS_POST_CREATE_DAYS` |
| Com data, janela pré-evento | `event_date - now ≤ PRE_EVENT_DAYS` E `event_date ≥ now` | 3d | `FRESHNESS_PRE_EVENT_DAYS` |
| Com data, janela pós-evento (recall) | `0 ≤ now - event_date ≤ POST_EVENT_DAYS` | 1d | `FRESHNESS_POST_EVENT_DAYS` |
| Auto-archive (stale) | sem data, `status=pending`, `now - created_at ≥ STALE_DAYS` | 30d | `FRESHNESS_STALE_DAYS` |

Itens com data, FORA das 3 janelas (pós-criação / pré-evento / pós-evento), ficam **silenciosos** — não saem do banco, só não entram nos prompts.

### API

```python
@dataclass(frozen=True)
class FreshnessPolicy:
    recency_hours: int = 72
    post_create_days: int = 7
    pre_event_days: int = 3
    post_event_days: int = 1
    stale_days: int = 30

    @classmethod
    def from_env(cls) -> "FreshnessPolicy":
        """Build from FRESHNESS_* env vars; falls back to defaults with logger.warning on invalid."""

    def is_fresh(
        self, *,
        created_at: datetime,
        event_date: Optional[datetime] = None,
        now: Optional[datetime] = None,
    ) -> bool: ...

    def is_stale(
        self, *,
        created_at: datetime,
        event_date: Optional[datetime] = None,
        now: Optional[datetime] = None,
    ) -> bool: ...

    def sql_fresh_filter(
        self, *,
        created_col: str,
        event_col: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> tuple[str, list]:
        """Returns ('AND (...)', [params]) ready to splice into a WHERE."""

DEFAULT_POLICY = FreshnessPolicy.from_env()
```

`is_fresh` e `is_stale` são **diferentes problemas** — não complementares:
- `is_fresh` → o que entra no opener/recall (positivo)
- `is_stale` → o que vai pro auto-archive (negativo)
- Existe **zona neutra** entre eles (ex: item sem data com 4 dias = nem fresh, nem stale)

`event_date` é opcional. Sem ele, só a regra de recency conta. `now` é injetável pra testes determinísticos.

## 6. Pontos de integração

### 6.1 DAOs que ganham `fresh_only: bool = False`

| Fonte | Arquivo | `created_at` | `event_col` | Notas |
|---|---|---|---|---|
| `seraphine_tasks` | `mod_tasks/service.py:533` (`list_tasks`) | sim | `due_date` | Recency + janela de deadline |
| `open_loops` | `memory/store.py:1269` (`list_open_loops`) | sim | — | Só recency (loops não têm data) |
| `facts` | `memory/store.py:819` (`list_facts`) | sim | — | Só recency |
| `discoveries` | `curiosity/service.py` (`list_pending_discoveries`) | sim | — | Só recency; já têm TTL próprio (mantido) |
| Finance nudges | `proactive/` (criados no dia) | sim | — | Já frescos por construção; flag por consistência |

Cada DAO splica `policy.sql_fresh_filter(...)` no `WHERE` quando `fresh_only=True`. Default `False` preserva compat 100%.

### 6.2 Call sites que passam `fresh_only=True`

| Call site | Arquivo | Mudança |
|---|---|---|
| Opener LLM context | `openers/service.py:121-217` (todas as `_context_*_section`) | Cada seção passa `fresh_only=True`. Se vazia, **omite a linha do prompt** (não escreve "tarefas em aberto: nenhuma") |
| Day-review broadcast | `proactive/scheduler.py:205-232` (`_tick_day_review`) | Caminho LLM separado do opener. Os DAOs chamados dentro do bundle de contexto desse tick recebem `fresh_only=True`; rule do prompt também ganha versão suavizada equivalente à do opener (regra #5) |
| Per-turn engine context | `conversation/engine.py:775-913` | `ambient_block`, `open_loops.prompt_block`, `recall_block`, `UserProfile.get_profile_summary` — todos `fresh_only=True` |
| Vector recall (Chroma + FTS) | `memory/manager.py:337+` | `since` filter equivalente à recency window. Fallback Python pós-fetch se Chroma não suportar. |
| `UserProfile.get_profile_summary` | `engine.py:904-913` | Naturalmente fica fresca via `list_facts(fresh_only=True)` |

### 6.3 Prompt do opener (mudança crítica)

`openers/service.py:33-63`, regra #5:

**Antes:**
> "5. Inicie com gancho CONCRETO (tarefa, horário, coisa que ele disse antes...)"

**Depois:**
> "5. Se houver contexto fresco abaixo, abra com gancho concreto referenciando-o. Se NÃO houver contexto fresco, abra com cumprimento leve (oi/voltou/bom dia) e PARE — não invente hooks de coisas antigas, não confabule."

Isso é o que destrava o comportamento desejado: quando o filtro fresh remove tudo, o LLM gera um "oi, voltou" e cala em vez de fabular.

### 6.4 O que NÃO muda

- Conversation turns (histórico imediato da conversa atual) — sempre injetados, sem filtro
- Reminders ativos (APScheduler trigger-based, não entram no prompt)
- Calendar events (módulo de calendário já filtra por janela de visualização)
- Reminders proper do `reminders/scheduler.py`

### Princípio guia

**Suprimir na origem, não no LLM.** O LLM nunca precisa "decidir não falar sobre Cana Brava" — Cana Brava simplesmente não entra no prompt fora das janelas válidas.

## 7. Auto-archive (`housekeeping.py`)

### Transições

| Tabela | Condição | Após archive |
|---|---|---|
| `seraphine_tasks` | `is_stale()` E `status='pending'` E sem `due_date` | `status='archived'` |
| `open_loops` | `is_stale()` E `resolved_at IS NULL` | `resolved_at=now, resolution='auto_archived'` |
| `facts` | `is_stale()` E `superseded_by IS NULL` | `superseded_by=-1, archived_at=now` |
| `discoveries` | (já tem TTL próprio) | sem mudança |

**Nota sobre tasks**: só arquiva pendentes SEM `due_date`. Tarefa com `due_date` segue ciclo normal mesmo se passou.

### API

```python
def archive_stale(
    conn: sqlite3.Connection,
    policy: FreshnessPolicy,
    *,
    now: Optional[datetime] = None,
) -> ArchiveReport:
    """Marca itens stale como archived. Idempotente. Retorna contagem por tabela."""

@dataclass
class ArchiveReport:
    tasks_archived: int
    loops_archived: int
    facts_archived: int
```

Cada bloco roda em try/except + transação isolada — se um falhar, os outros completam, com `logger.warning`.

### Agendamento

```python
# main.py — junto dos outros add_job
scheduler._sched.add_job(
    lambda: archive_stale(app.state.store._connect(), DEFAULT_POLICY),
    "cron", hour=4, minute=30, id="freshness_archive",
)
```

Diário às 04:30 (depois do `cv_triage_housekeeping` às 04:15, espaça pra evitar lock SQLite).

### Reversibilidade

Auto-archive NÃO deleta. Pra reverter:
- Task: `UPDATE seraphine_tasks SET status='pending' WHERE id=?`
- Loop: `UPDATE open_loops SET resolved_at=NULL, resolution=NULL WHERE id=?`
- Fact: `UPDATE facts SET superseded_by=NULL, archived_at=NULL WHERE id=?`

Sem prazo de purga real — storage trivial.

### Primeira execução

Vai limpar todo o backlog acumulado (potencialmente centenas de itens). Log estruturado: `INFO seraphine.freshness.housekeeping: archive_stale done {tasks: N, loops: M, facts: K}`.

## 8. Schema (`schema.py`)

```sql
-- index pra excluir 'archived' rápido nas queries
CREATE INDEX IF NOT EXISTS idx_tasks_status_due
  ON seraphine_tasks(status, due_date);

-- facts ganha coluna nova (SQLite não suporta ADD COLUMN IF NOT EXISTS;
-- usar try/except sqlite3.OperationalError no migrator pra ignorar "duplicate column")
ALTER TABLE facts ADD COLUMN archived_at TEXT;

-- open_loops: usa 'resolution' string existente; sem schema change
```

Registrado via `MemoryStore.register_migrator('freshness_v1', migrate)` no `__init__.py` do módulo. Mesma convenção do `cv_triage_v1`.

## 9. Testes

Stack: `pytest`. Diretório: `apps/seraphine/backend/tests/freshness/`.

### Unit — `test_policy.py` (~11 testes)

- `test_recency_window_passes` — sem data, 1h → fresh
- `test_recency_window_fails` — sem data, 5d → not fresh
- `test_post_create_window_for_dated_item` — data futura, 3d desde criação → fresh
- `test_pre_event_window` — data daqui 2d, criado há 60d → fresh
- `test_silent_window_for_dated_item` — data daqui 20d, criado há 30d → NOT fresh
- `test_post_event_recall` — data ontem → fresh (1d pós)
- `test_stale_after_30d_no_date` — sem data, 31d → stale
- `test_not_stale_if_has_date` — velho mas com data futura → NOT stale
- `test_sql_filter_recency_only` — fragmento sem event_col
- `test_sql_filter_with_event_col` — fragmento com OR de janelas
- `test_from_env_overrides_defaults` — env vars aplicam

### Integration — `test_housekeeping.py` (~8 testes)

- `test_archives_old_pending_task_no_due`
- `test_preserves_old_task_with_due_date`
- `test_preserves_fresh_task`
- `test_archives_old_open_loop`
- `test_archives_old_active_fact`
- `test_idempotent` — 2x rodar = 2ª vez zera
- `test_report_counts` — seed conhecido → counts corretas
- `test_per_table_isolation_on_failure` — mock 1 tabela raise; outras completam

### Integration — `test_dao_fresh_filter.py` (~4 testes)

- `test_list_tasks_fresh_only_excludes_stale`
- `test_list_open_loops_fresh_only_excludes_old`
- `test_list_facts_fresh_only_excludes_old_facts`
- `test_list_tasks_default_keeps_old` (regression — `fresh_only=False` preserva comportamento)

### Integration — `test_opener_uses_fresh_context.py` (~3 testes)

- `test_opener_omits_empty_section` — 0 tasks fresh → prompt sem linha "tarefas em aberto:"
- `test_opener_includes_fresh_section` — 1 task fresh → prompt inclui
- `test_opener_prompt_softened_rule_5` — snapshot do prompt → rule 5 contém "Se NÃO houver contexto fresco, abra com cumprimento leve"

Total: **~26 testes**.

## 10. Error handling

| Cenário | Comportamento |
|---|---|
| Migração `freshness_v1` falha (`facts.archived_at` já existe) | `try/except sqlite3.OperationalError` no migrator ignora "duplicate column" |
| `archive_stale` falha numa tabela | Bloco isolado em try/except + `logger.warning`; outras tabelas seguem; report parcial |
| `policy.is_fresh()` recebe `created_at=None` | Levanta `ValueError` (programmer error, não esperado) |
| Env var inválido (`FRESHNESS_RECENCY_HOURS=abc`) | `from_env()` cai pro default + `logger.warning("invalid ..., using default 72")` |
| Cron dispara durante write pesado (SQLite lock) | apscheduler reagenda; archive é idempotente |
| Vector recall — Chroma não suporta `since` filter | Fallback Python pós-fetch; mais lento mas funcional |

## 11. Observabilidade

Eventos JSON estruturados (logger existente):

| Evento | Campos |
|---|---|
| `seraphine.freshness.archive_done` | `tasks: int, loops: int, facts: int, duration_ms: float` |
| `seraphine.freshness.archive_failed` | `table: str, error: str` |
| `seraphine.freshness.policy_loaded` | `recency_hours, post_create_days, pre_event_days, post_event_days, stale_days` (no boot) |

Você acompanha quanto está sendo limpo. `tasks: 100` num dia = backlog (esperado na primeira execução).

## 12. Fora de escopo (explícito)

- UI pra ver/editar archived items
- Comando "des-archive" via chat (editar SQL manualmente se raro)
- Política diferente por conversa (ex: modo "trabalho" vs "casa")
- Migração one-shot de dados velhos pra trás (a primeira execução do cron faz isso)
- Reminders parte do `fresh_only` (já são trigger-based)

## 13. Resumo executivo

- 3 arquivos novos: `freshness/{policy,housekeeping,schema}.py`
- 1 modificação de schema: `facts.archived_at` (ALTER TABLE)
- 5 DAOs ganham `fresh_only`: tasks, open_loops, facts, discoveries, finance nudges
- 3 call sites atualizados: opener, day_review, engine per-turn (4 sub-blocos)
- 1 cron diário novo: 04:30 `archive_stale`
- 1 prompt modificado: rule 5 do opener
- ~26 testes (11 unit + ~15 integration)
- 0 mudança de UX visível (exceto Seraphine parar de mencionar coisa velha)
