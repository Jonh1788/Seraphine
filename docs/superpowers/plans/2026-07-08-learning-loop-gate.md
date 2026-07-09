# Learning loop gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O `run_cycle` do learning loop só surfa candidato como `pending` quando ele **supera** o baseline por uma margem real, com mínimo de evidência, sem re-processar traces velhos, e com o score menos ruidoso (K avaliações).

**Architecture:** 4 travas no `run_cycle`, na ordem barato→caro: novidade (SQL) → evidência (contagem) → propose → eval repetido (média de K) → margem. Thresholds em `config.py` (não knob). Um wrapper `evaluate_policy_repeated` reduz o ruído do juiz. Loop segue human-gated.

**Tech Stack:** Python/asyncio, `seraphine/learning` (service/evaluator/optimizer), `config.py` (pydantic BaseSettings), sqlite.

## Global Constraints

- Backend tests de `apps/seraphine/backend` com `uv run pytest` (asyncio_mode=auto; os testes de learning usam `asyncio.run(...)`, não o marker). Um arquivo: `uv run pytest tests/learning/test_service.py -v`.
- **Human-gated preservado:** nada auto-promove; o gate só decide `pending` vs `rejected` vs skip.
- **Thresholds em config, NÃO knob** (o otimizador propõe knobs — não pode tunar o próprio gate). Defaults: `learning_min_margin=0.05`, `learning_min_traces=5`, `learning_min_convs=2`, `learning_eval_repeats=2`.
- **Ordem das travas:** novidade → evidência (ambas antes de qualquer chamada de LLM) → propose → eval repetido → margem.
- **Fail behavior:** novidade/evidência → **skip, sem criar row**; margem → **row `rejected`** (auditoria).
- Os 2 callers (`_tick_learning` cron 03:30, `POST /learning/run`) chamam `run_cycle()` **sem args** — os thresholds vêm de `settings`, então a assinatura fica sem-args.
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Modificar:**
- `apps/seraphine/backend/seraphine/config.py` — 4 campos de config.
- `apps/seraphine/backend/seraphine/learning/evaluator.py` — `evaluate_policy_repeated`.
- `apps/seraphine/backend/seraphine/learning/service.py` — `run_cycle` (4 travas).

**Testes:**
- Criar: `apps/seraphine/backend/tests/learning/test_evaluator_repeated.py`
- Modificar: `apps/seraphine/backend/tests/learning/test_service.py` (novos casos de gate + ajustar os que assumiam o gate antigo).

---

## Task 1: `evaluate_policy_repeated` (redução de ruído)

**Files:**
- Modify: `apps/seraphine/backend/seraphine/learning/evaluator.py`
- Test: `apps/seraphine/backend/tests/learning/test_evaluator_repeated.py`

**Interfaces:**
- Consumes: `evaluate_policy(llm_call, *, behavior_addendum, tool_guidance, eval_cases, base_instruction, concurrency) -> EvalResult`; `EvalResult(score, per_case, n)`.
- Produces: `async evaluate_policy_repeated(llm_call, *, behavior_addendum, tool_guidance, eval_cases, base_instruction="", concurrency=3, repeats=1) -> EvalResult` — média de `repeats` execuções.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/learning/test_evaluator_repeated.py`:

```python
import seraphine.learning.evaluator as ev
from seraphine.learning.evaluator import EvalResult, evaluate_policy_repeated


async def test_repeated_averages_scores(monkeypatch):
    scores = iter([0.8, 0.9])

    async def _fake(llm_call, **kwargs):
        return EvalResult(score=next(scores), per_case=[{"id": "x", "score": 0.0}], n=1)

    monkeypatch.setattr(ev, "evaluate_policy", _fake)
    out = await evaluate_policy_repeated(
        None, behavior_addendum="", tool_guidance="", eval_cases=[{"id": "c"}], repeats=2,
    )
    assert out.score == 0.85  # mean of 0.8 and 0.9


async def test_repeated_one_is_single(monkeypatch):
    calls = {"n": 0}

    async def _fake(llm_call, **kwargs):
        calls["n"] += 1
        return EvalResult(score=0.7, per_case=[], n=0)

    monkeypatch.setattr(ev, "evaluate_policy", _fake)
    out = await evaluate_policy_repeated(
        None, behavior_addendum="", tool_guidance="", eval_cases=[{"id": "c"}], repeats=1,
    )
    assert out.score == 0.7 and calls["n"] == 1


async def test_repeated_clamps_repeats_to_min_one(monkeypatch):
    calls = {"n": 0}

    async def _fake(llm_call, **kwargs):
        calls["n"] += 1
        return EvalResult(score=0.5, per_case=[], n=0)

    monkeypatch.setattr(ev, "evaluate_policy", _fake)
    await evaluate_policy_repeated(
        None, behavior_addendum="", tool_guidance="", eval_cases=[{"id": "c"}], repeats=0,
    )
    assert calls["n"] == 1  # repeats<1 clamped to 1
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/seraphine/backend`): `uv run pytest tests/learning/test_evaluator_repeated.py -v`
Expected: FAIL — `ImportError: cannot import name 'evaluate_policy_repeated'`.

- [ ] **Step 3: Write minimal implementation**

In `apps/seraphine/backend/seraphine/learning/evaluator.py`, add after `evaluate_policy`:

```python
async def evaluate_policy_repeated(
    llm_call: LLMCall,
    *,
    behavior_addendum: str,
    tool_guidance: str,
    eval_cases: list[dict[str, Any]],
    base_instruction: str = "",
    concurrency: int = 3,
    repeats: int = 1,
) -> EvalResult:
    """Run evaluate_policy `repeats` times and average the scores, to damp the
    LLM-judge's run-to-run noise. repeats<1 is clamped to 1."""
    repeats = max(1, int(repeats))
    results: list[EvalResult] = []
    for _ in range(repeats):
        results.append(
            await evaluate_policy(
                llm_call,
                behavior_addendum=behavior_addendum,
                tool_guidance=tool_guidance,
                eval_cases=eval_cases,
                base_instruction=base_instruction,
                concurrency=concurrency,
            )
        )
    mean = sum(r.score for r in results) / len(results)
    last = results[-1]
    return EvalResult(score=mean, per_case=last.per_case, n=last.n)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/learning/test_evaluator_repeated.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/learning/evaluator.py \
        apps/seraphine/backend/tests/learning/test_evaluator_repeated.py
git commit -m "feat(learning): evaluate_policy_repeated (averages K evals to damp judge noise)"
```

---

## Task 2: Config + `run_cycle` — as 4 travas

**Files:**
- Modify: `apps/seraphine/backend/seraphine/config.py` (4 campos)
- Modify: `apps/seraphine/backend/seraphine/learning/service.py` (`run_cycle`)
- Test: `apps/seraphine/backend/tests/learning/test_service.py` (novos + ajustes)

**Interfaces:**
- Consumes: `evaluate_policy_repeated` (Task 1); `propose_candidate`, `recent_traces`, `self.ensure_eval_set`/`list_eval_cases`/`get_active_policy`, `self.store._connect` (existentes); `settings.learning_min_margin`/`learning_min_traces`/`learning_min_convs`/`learning_eval_repeats`.
- Produces: `run_cycle()` retorna dict com `status` ∈ `{"pending","rejected","skipped_no_new","skipped_low_evidence"}`.

- [ ] **Step 1: Add the config fields**

In `apps/seraphine/backend/seraphine/config.py`, near `memory_audit_interval_s`, add:

```python
    # Learning-loop candidate gate. Thresholds live here (NOT in the knob
    # registry) because the optimizer proposes knobs — it must not tune its own
    # gate. A candidate is surfaced as 'pending' only if it BEATS the active
    # policy by learning_min_margin on the (repeated) eval; below that → rejected.
    learning_min_margin: float = 0.05
    learning_min_traces: int = 5
    learning_min_convs: int = 2
    learning_eval_repeats: int = 2
```

- [ ] **Step 2: Write the failing tests (new gate behavior)**

In `apps/seraphine/backend/tests/learning/test_service.py`, add a "candidate beats baseline" scripted LLM helper and the new gate tests. Add this helper next to the existing `make_llm`/`make_echo_llm`:

```python
def make_good_llm(base_score=0.85, cand_score=0.95):
    """Candidate policy carries SENTINEL_GOOD in its addendum; the responder
    echoes the system prompt so the judge sees the sentinel and scores the
    candidate higher than the (sentinel-less) baseline."""

    async def llm(messages):
        first = messages[0]["content"]
        last = messages[-1]["content"]
        if "WHITELISTED KNOBS" in first:
            return (
                '{"behavior_addendum":"SENTINEL_GOOD","tool_guidance":"",'
                '"knobs":{},"rationale":"melhora"}'
            )
        if "RUBRIC" in last:
            return '{"score": %s}' % (cand_score if "SENTINEL_GOOD" in last else base_score)
        return first  # responder echoes the system prompt

    return llm
```

Then add the new tests:

```python
def test_gate_pending_when_beats_margin(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)  # 8 traces / 8 convs — passes evidence
    svc = LearningService(store, make_good_llm(base_score=0.85, cand_score=0.95))

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "pending"
    assert result["candidate_score"] >= result["baseline_score"] + 0.05
    assert len(asyncio.run(svc.list_candidates(status="pending"))) == 1


def test_gate_rejects_on_tie(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    # candidate scores the SAME as baseline (tie) → does not beat the margin
    svc = LearningService(store, make_good_llm(base_score=0.85, cand_score=0.85))

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "rejected"
    assert "below margin" in result["rationale"]
    assert asyncio.run(svc.list_candidates(status="pending")) == []


def test_gate_skips_low_evidence(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 2)  # 2 < learning_min_traces (5)
    svc = LearningService(store, make_good_llm())

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "skipped_low_evidence"
    # no candidate row was created
    assert asyncio.run(svc.list_candidates()) == []


def test_gate_skips_no_new_traces(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm())

    first = asyncio.run(svc.run_cycle())
    assert first["status"] in ("pending", "rejected")  # a candidate row now exists
    # no new traces since that candidate → second cycle is skipped
    second = asyncio.run(svc.run_cycle())
    assert second["status"] == "skipped_no_new"
    assert len(asyncio.run(svc.list_candidates())) == 1  # no extra row
```

- [ ] **Step 3: Update the existing tests that assumed the OLD gate**

Three existing tests assume the pre-gate behavior (tie→pending, 1 trace, "regressed" wording). Replace them:

Replace `test_run_cycle_stores_pending_when_no_regression` (it seeded 1 trace and expected a tie to be pending — both now false) with a version that beats the margin with enough evidence:

```python
def test_run_cycle_stores_pending_when_beats_margin(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm(base_score=0.85, cand_score=0.95))

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "pending"
    assert result["passed"] is True
    pending = asyncio.run(svc.list_candidates(status="pending"))
    assert len(pending) == 1
    assert pending[0]["candidate_score"] is not None
```

In `test_run_cycle_rejects_on_regression`, the candidate (0.3) is far below baseline (0.9) so it still ends `rejected` — but the rationale wording changed. Update the assertion:

```python
    assert result["status"] == "rejected"
    assert result["passed"] is False
    assert result["baseline_score"] == pytest.approx(0.9)
    assert result["candidate_score"] == pytest.approx(0.3)
    assert "below margin" in result["rationale"]
```

In `test_promote_creates_active_version` and `test_promote_then_rollback` (both seed 1 trace and rely on a pending candidate existing), bump the seed to 8 and use `make_good_llm` so a pending candidate is actually produced under the new gate. Concretely, change their setup from:

```python
    store = _make_store(tmp_path)
    _seed_traces(store, 1)
    svc = LearningService(store, make_llm(judge_score=0.9))
```

to:

```python
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm(base_score=0.80, cand_score=0.95))
```

and update `test_promote_creates_active_version`'s assertions that checked the old optimizer output (`behavior_addendum == "Seja conciso."`, `knobs == {"recall_fact_limit": 12}`) to the new good-llm output:

```python
    assert active["behavior_addendum"] == "SENTINEL_GOOD"
    assert active["knobs"] == {}
```

(Read the actual bodies of those two tests and apply the same seed/llm swap; keep the promote/rollback assertions otherwise intact.)

- [ ] **Step 4: Run the tests to verify they FAIL (gate not implemented yet)**

Run: `uv run pytest tests/learning/test_service.py -v`
Expected: the new `test_gate_*` tests FAIL (skip statuses / margin gate not implemented; today a tie is `pending` and low-evidence still creates a row).

- [ ] **Step 5: Rewrite `run_cycle` with the 4 gates**

In `apps/seraphine/backend/seraphine/learning/service.py`, replace the entire `run_cycle` method with:

```python
    async def run_cycle(self) -> dict[str, Any]:
        from seraphine.config import settings as _s
        from seraphine.learning.evaluator import evaluate_policy_repeated

        min_margin = float(_s.learning_min_margin)
        min_traces = int(_s.learning_min_traces)
        min_convs = int(_s.learning_min_convs)
        repeats = max(1, int(_s.learning_eval_repeats))

        # Gate 1 — novelty: skip if no trace is newer than the last candidate.
        def _watermarks() -> tuple[str | None, str | None]:
            with self.store._connect() as conn:
                t = conn.execute("SELECT MAX(ts) FROM learning_trace").fetchone()[0]
                c = conn.execute("SELECT MAX(ts) FROM learning_candidate").fetchone()[0]
            return t, c

        max_trace_ts, max_cand_ts = await asyncio.to_thread(_watermarks)
        if max_trace_ts is None:
            return {"status": "skipped_no_new", "reason": "no traces"}
        if max_cand_ts is not None and max_trace_ts <= max_cand_ts:
            return {"status": "skipped_no_new", "reason": "no new traces since last candidate"}

        # Gate 2 — evidence: need enough traces / distinct conversations.
        traces = await recent_traces(self.store, limit=50, prefer_low_signal=True)
        n_convs = len({t.get("conversation_id") for t in traces if t.get("conversation_id")})
        if len(traces) < min_traces or n_convs < min_convs:
            return {
                "status": "skipped_low_evidence",
                "traces": len(traces), "convs": n_convs,
            }

        # Expensive path — eval + propose (Gate 4 = repeated eval).
        await self.ensure_eval_set()
        cases = await self.list_eval_cases()
        active = await self.get_active_policy()

        baseline = await evaluate_policy_repeated(
            self._llm_call,
            behavior_addendum=active["behavior_addendum"],
            tool_guidance=active["tool_guidance"],
            eval_cases=cases, base_instruction=self.base, repeats=repeats,
        )
        cand = await propose_candidate(
            self._llm_call, traces=traces,
            active_behavior=active["behavior_addendum"],
            active_tool_guidance=active["tool_guidance"],
            active_knobs=active["knobs"],
        )
        cand_eval = await evaluate_policy_repeated(
            self._llm_call,
            behavior_addendum=cand.behavior_addendum,
            tool_guidance=cand.tool_guidance,
            eval_cases=cases, base_instruction=self.base, repeats=repeats,
        )

        # Gate 3 — margin: must BEAT baseline by min_margin (not just tie).
        non_empty = bool(cand.behavior_addendum or cand.tool_guidance or cand.knobs)
        beats = cand_eval.score >= baseline.score + min_margin
        passed = non_empty and beats
        status = "pending" if passed else "rejected"

        rationale = cand.rationale
        if not passed:
            if not non_empty:
                rationale += " | empty proposal"
            else:
                rationale += (
                    f" | below margin: cand={cand_eval.score:.3f} "
                    f"base={baseline.score:.3f} need>={baseline.score + min_margin:.3f}"
                )

        cid = str(uuid.uuid4())

        def _work() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "INSERT INTO learning_candidate "
                    "(id, ts, behavior_addendum, tool_guidance, knobs_json, "
                    "baseline_score, candidate_score, status, rationale, "
                    "base_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        cid, _now(), cand.behavior_addendum, cand.tool_guidance,
                        json.dumps(cand.knobs), baseline.score, cand_eval.score,
                        status, rationale, active["version"],
                    ),
                )

        await asyncio.to_thread(_work)

        return {
            "candidate_id": cid, "status": status,
            "baseline_score": baseline.score, "candidate_score": cand_eval.score,
            "passed": passed, "rationale": rationale,
        }
```

(The old `run_cycle(self, *, tolerance=0.02, trace_limit=50)` signature is replaced by the no-arg version — both callers already invoke `run_cycle()` with no args. `uuid`, `json`, `asyncio`, `recent_traces`, `propose_candidate`, `_now` are already imported in service.py.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/learning/test_service.py tests/learning/test_evaluator_repeated.py -v`
Expected: PASS (new gate tests + the updated existing tests + Task 1's tests). Then `uv run python -c "import seraphine.main"` (import OK).

- [ ] **Step 7: Full learning suite + no regression**

Run: `uv run pytest tests/learning/ -q`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/seraphine/backend/seraphine/config.py \
        apps/seraphine/backend/seraphine/learning/service.py \
        apps/seraphine/backend/tests/learning/test_service.py
git commit -m "feat(learning): candidate gate — margin + evidence + novelty + repeated eval"
```

---

## Task 3: Verificação E2E manual

**Files:** nenhum.

- [ ] **Step 1: Suíte verde**

Run (from `apps/seraphine/backend`): `uv run pytest tests/learning/ -v`
Expected: tudo verde.

- [ ] **Step 2: Comportamento real (opcional, precisa cliproxy)**

Suba o backend local. Com a base de traces atual (poucos), dispare `POST /learning/run` — deve retornar `skipped_low_evidence` ou `skipped_no_new` (não cria candidato fantasma). Confirme via `GET /learning/candidates?status=pending` que nenhum novo pending apareceu.

- [ ] **Step 3: Prod (após deploy)**

Depois do deploy, o cron das 03:30 passa a aplicar os gates. Rejeite à mão os 7 candidatos fantasma que já estão em prod (eles são pré-gate). Daqui pra frente: com o fix das tools (já live) + os gates, só sobe candidato que realmente supera o baseline com evidência nova.

---

## Self-Review (cobertura do spec)

- **Margem real (beats baseline + min_margin):** Task 2 (Gate 3). ✓
- **Mínimo de evidência (min_traces/min_convs):** Task 2 (Gate 2, skip sem row). ✓
- **Novidade (anti-stale):** Task 2 (Gate 1, watermark trace vs candidate). ✓
- **Reduzir ruído (K evals média):** Task 1 (`evaluate_policy_repeated`) + Task 2 usa. ✓
- **Thresholds em config, não knob:** Task 2 (config.py). ✓
- **Ordem barato→caro:** Task 2 (novidade/evidência antes do eval). ✓
- **Fail behavior (skip sem row / margem→rejected):** Task 2 (early returns / status). ✓
- **Human-gated preservado:** nenhuma task auto-promove. ✓
- **Callers sem args:** run_cycle sem-args lendo settings. ✓
- **Testes existentes ajustados:** Task 2 Step 3. ✓
