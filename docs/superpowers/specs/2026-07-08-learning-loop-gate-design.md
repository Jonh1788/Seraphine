# Learning loop — gate de candidatos

**Data:** 2026-07-08
**Status:** Aprovado (aguardando plano)

## Problema / motivação

O `run_cycle` do learning loop surfou 7 candidatos "fantasma" (variações da mesma lição, de 2 traces velhos). Causas do lado do gate (a causa de sinal — `tools_json=[]` — já foi corrigida e está live):

- **Gate fraco:** o único gate é `candidate_score >= baseline_score − tolerance` (tolerance=0.02). Isso **deixa passar empate e até candidato pior** (até 0,02 abaixo) — não exige **superar** o baseline. Por isso 0,85 vs 0,85 virou `pending`.
- **Sem mínimo de evidência:** `propose_candidate` propõe até de 0 traces.
- **Sem novidade:** roda 1x/dia (03:30) sempre nos mesmos traces low-signal → re-propõe a mesma lição todo dia (os 7 quase-duplicados).
- **Score ruidoso:** eval é LLM-juiz (responder + juiz, temp 0.2, média de ~8 eval cases), **não-determinístico** — margem pequena é engolida pelo ruído.

## Objetivo

4 travas no `run_cycle`, mantendo o loop **human-gated** (nada auto-promove; o humano Promove/Rejeita). Thresholds em **config** (não knob — o otimizador não pode tunar o próprio gate).

## Decisões (brainstorm)

1. **Todas as 4 travas:** margem real + mínimo de evidência + novidade (anti-stale) + redução de ruído do juiz.
2. **Human-gated preservado** — sem auto-promoção.
3. **Thresholds = config** (`config.py`, env-overridable), não knobs.
4. **Ordem barato→caro:** checagens de contagem (SQL) antes do eval de LLM, pra cortar o ciclo antes de gastar chamadas.

## Contexto do código (na main)

- `seraphine/learning/service.py::run_cycle(*, tolerance=0.02, trace_limit=50)` (linhas ~175-258): `ensure_eval_set` → baseline `evaluate_policy` → `recent_traces(limit, prefer_low_signal=True)` → `propose_candidate` → candidate `evaluate_policy` → gate booleans (`non_empty`, `no_regression`) → status pending/rejected → **sempre** INSERT em `learning_candidate`. Os 2 callers (cron `_tick_learning` 03:30; `POST /learning/run`) chamam `run_cycle()` **sem args**.
- `seraphine/learning/evaluator.py::evaluate_policy(...) -> EvalResult` (score = média das notas [0,1] do juiz; `concurrency=3`). LLM-noisy.
- `seraphine/learning/optimizer.py::propose_candidate(...)` — nunca declina; resume até 25 traces.
- `seraphine/learning/knobs.py` — knobs de execução (recall/escalation); **thresholds de gate NÃO entram aqui**.
- `config.py` — `class Settings(BaseSettings)`, `env_prefix="SERAPHINE_"`; campos tipo `memory_audit_interval_s: int = 86400`.
- Testes: `tests/learning/test_service.py` mostra construção do `LearningService(store, llm_call, ...)` com stub.

## Arquitetura

```
run_cycle():
  1. NOVIDADE  — max(learning_trace.ts) > max(learning_candidate.ts) ?
        └─ não → return status="skipped_no_new"   (sem row, sem eval)
  2. EVIDÊNCIA — traces = recent_traces(...); len(traces) >= min_traces
                 AND distinct(conversation_id) >= min_convs ?
        └─ não → return status="skipped_low_evidence"   (sem propose/eval, sem row)
  3. cand = propose_candidate(traces)                         [inalterado]
  4. baseline = evaluate_policy_repeated(active, K)           ← média de K evals
     cand_eval = evaluate_policy_repeated(candidate, K)       ← reduz ruído
  5. MARGEM — non_empty AND cand_eval.score >= baseline.score + min_margin ?
        ├─ sim → status="pending"   (surfa; humano aprova)
        └─ não → status="rejected"  (INSERT como auditoria; UI só mostra pending)
```

## Componentes

### 1. Config (`config.py`) — 4 campos novos (defaults)
- `learning_min_margin: float = 0.05` — candidate_score deve superar baseline por isso pra virar `pending`.
- `learning_min_traces: int = 5` — mínimo de traces pra propor.
- `learning_min_convs: int = 2` — mínimo de conversas distintas.
- `learning_eval_repeats: int = 2` — K avaliações por política (média).

### 2. `evaluator.evaluate_policy_repeated(...) -> EvalResult` (novo wrapper)
- Chama `evaluate_policy(...)` K vezes e retorna um `EvalResult` com `score` = média das K médias (e `n` do último, ou soma). K=1 → equivalente ao atual. Reusa a assinatura de `evaluate_policy`.

### 3. `service.run_cycle` (modificar) — as 4 travas + novos status
- Lê os thresholds de `settings` (mantém `run_cycle()` sem-args funcionando; os defaults vêm do config).
- **Trava 1 (novidade):** query `max(ts)` de `learning_trace` e de `learning_candidate`; se não há trace com ts > last_candidate_ts → `return {"status":"skipped_no_new", ...}` (antes de qualquer eval/propose).
- **Trava 2 (evidência):** após `recent_traces`, se `len(traces) < min_traces` OU `len({t["conversation_id"] for t in traces}) < min_convs` → `return {"status":"skipped_low_evidence", ...}` (antes de propose/eval).
- **Trava 4 (ruído):** baseline e candidate via `evaluate_policy_repeated(..., repeats=min(K, ...))`.
- **Trava 3 (margem):** substitui `no_regression` por `beats = cand_eval.score >= baseline.score + min_margin`; `passed = non_empty and beats`; `status = "pending" if passed else "rejected"`. Rationale ganha o motivo (`| below margin: cand=... base=... margin=...`).
- Só cria row (INSERT) quando chega ao passo 5 (proposto+avaliado). Skips (1/2) retornam antes, sem row.
- Return dict ganha os novos status; o scheduler já loga `result["status"]`.

## Fail behavior / erros

- **Novidade/evidência fail → skip, sem row** (senão o loop diário voltaria a spammar rejected duplicado — o oposto do objetivo).
- **Margem fail → row `rejected`** (candidato foi proposto+avaliado; auditoria; UI só mostra `pending`).
- Ruído: se K avaliações falharem (LLM down), cada uma cai no fallback 0.5 do `evaluate_policy` — comportamento existente, média preservada.
- Tudo dentro do `run_cycle` que já é try/except no caller (`_tick_learning`).

## Fora de escopo

- Auto-promoção de candidatos (o loop segue 100% human-gated).
- Knobs de gate (thresholds são config, de propósito).
- Mudança na UI (a aba só mostra `pending`; os novos status `skipped_*` não geram row, `rejected` já é filtrado).
- Dedup semântico de candidatos entre si (a novidade já mata o re-proposto igual).
- Limpar os 7 candidatos fantasma existentes em prod (você rejeita à mão).

## Testes

- **Margem:** stub `evaluate_policy`/`propose_candidate` → baseline 0.85, cand 0.85 → `rejected`; cand 0.92 (>= 0.85+0.05) → `pending`.
- **Evidência:** 2 traces (< min_traces=5) → `skipped_low_evidence`, **sem** row em `learning_candidate`.
- **Novidade:** um candidato existente com ts recente e nenhum trace novo depois → `skipped_no_new`, sem row.
- **Ruído:** `evaluate_policy_repeated` com um fake que retorna scores [0.8, 0.9] em 2 chamadas → média 0.85; asserta 2 chamadas.
- **Não-regressão:** `tests/learning/test_service.py` continua verde (ajustar o(s) teste(s) que assumiam o gate antigo, se houver).
