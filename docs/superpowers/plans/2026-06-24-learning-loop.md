# Local Learning Loop (OpenJarvis #1) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD. Platform-aware (teacher uses the configured LLM / cliproxy — kept). Promotion is HUMAN-GATED (never auto-promotes); optimizes BOTH a behavior-policy addendum AND a whitelist of tunable execution knobs.

**Goal:** Let Seraphine improve her own behavior from real conversations: capture interaction traces, and on a nightly cycle have a frontier "teacher" LLM propose (a) a behavior-policy addendum to the system prompt and (b) values for a bounded whitelist of execution knobs — then score the candidate against a frozen eval set with an LLM judge, accept it through a regression gate (no degradation beyond tolerance), and store it as a **pending** candidate. A human reviews the diff + scores in a panel and promotes (versioned, reversible) or rejects. Nothing reaches production without that click.

**Architecture:** New backend module `seraphine/learning/`: `schema` (traces, eval cases, candidates, versioned active policy), `knobs` (the bounded whitelist + clamp/effective helpers — pure), `traces` (cheap capture + signal derivation), `evaluator` (LLM-judge over the frozen eval set — injectable LLM for tests), `optimizer` (teacher proposes a candidate from low-signal traces), `service` (`run_cycle` = ensure eval set → baseline → propose → score → regression gate → store pending; plus list/promote/reject/rollback), `routes`. The chat engine injects the active policy (addendum + tool-guidance system messages) and applies effective knobs where consumed (`recall_fact_limit`, `smart_escalation_prompt_chars`, `recall_enabled`). A nightly `_tick_learning` scheduler job runs the cycle. A frontend "Aprendizado" panel does the human review. cliproxy/local stays the default LLM; the teacher is just `self.llm`.

**Tech:** Python/FastAPI, SQLite via MemoryStore, the existing `AnthropicClient`/engine, APScheduler (`seraphine/proactive/scheduler.py`), React+TS.

**Confirmed anchors:**
- `conversation/engine.py:507 __init__`; `:520 self.system_prompt = ...`; `:846 messages = [ChatMessage(role="system", content=self.system_prompt)]` (base system msg — inject policy right after); `:550 _build_recall_block` uses `list_facts(limit=30, fresh_only=True)` (→ `recall_fact_limit` knob); `:1024` router call site; `:1323 assistant_turn = await self.store.add_turn(conversation_id, "assistant", final_text)` (→ trace hook); `turn_feedback` table has a `reaction` col (signal source).
- `routing/router.py`: `classify_complexity(inp)` uses module const `_LONG_PROMPT_CHARS = 1500` (→ make it a param for the `smart_escalation_prompt_chars` knob).
- `proactive/scheduler.py:67 ProactiveScheduler`, `start()` adds cron jobs via `self._sched.add_job(self._tick_X, "cron", hour=, minute=, name=)`; `app_state` carries services (e.g. `task_service`); `run_job_now(name)` dispatches manually.
- Per-feature module pattern (telemetry/proactive): `store.register_migrator(name, schema.migrate)` before `ensure_schema`; construct service; `app.state.X = svc`; `app.include_router(router)`. MemoryStore: `with self.store._connect() as conn` in `def _work()` via `asyncio.to_thread`; ts stored as `datetime.now(timezone.utc).isoformat()`; date filters compare against a Python ISO cutoff string (NOT `datetime('now')`).
- LLM: `self.llm` is an `AnthropicClient`; `await llm.complete(messages)` returns text? CONFIRM the non-streaming call (grep `def complete`/`tool_call_json`/`chat` in `packages/llm-adapters/src/llm_adapters/anthropic.py`). If there is no `complete`, use `chat()` and accumulate, or `tool_call_json` for structured. The evaluator/optimizer must use whatever single-shot method exists; mirror how another service (e.g. `memory/profile.py` `rebuild`) calls the LLM for a one-shot completion.

---

## Task 1: schema + pure knobs registry

**Files:** Create `seraphine/learning/__init__.py`, `schema.py`, `knobs.py`; Test `tests/learning/__init__.py`, `tests/learning/test_knobs.py`, `tests/learning/test_schema.py`.

### schema.py
```python
"""Learning-loop tables (OpenJarvis #1). All idempotent."""
from __future__ import annotations
import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_trace (
            id TEXT PRIMARY KEY, ts TEXT NOT NULL, conversation_id TEXT,
            turn_id TEXT, user_msg TEXT, assistant_msg TEXT,
            tools_json TEXT, feature TEXT, signal REAL
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_trace_ts ON learning_trace(ts)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_eval_case (
            id TEXT PRIMARY KEY, ts TEXT NOT NULL, input_text TEXT NOT NULL,
            rubric TEXT NOT NULL, source_trace_id TEXT, active INTEGER DEFAULT 1
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_candidate (
            id TEXT PRIMARY KEY, ts TEXT NOT NULL,
            behavior_addendum TEXT, tool_guidance TEXT, knobs_json TEXT,
            baseline_score REAL, candidate_score REAL,
            status TEXT NOT NULL DEFAULT 'pending', rationale TEXT, base_version INTEGER
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_candidate_status ON learning_candidate(status, ts)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_policy (
            version INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
            behavior_addendum TEXT, tool_guidance TEXT, knobs_json TEXT,
            from_candidate TEXT, active INTEGER DEFAULT 0
        )"""
    )
```

### knobs.py (PURE — no I/O)
```python
"""The bounded whitelist of execution knobs the learning loop may tune.

Only these knobs can ever be changed by a promoted policy, each clamped to a
safe range. The optimizer is shown this registry; promotion applies clamped
values. This is the *execution-path* half of "both" (behavior addendum is the
other half) — bounded + human-gated so a bad proposal can't run wild.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class Knob:
    name: str
    kind: Literal["int", "bool"]
    default: Any
    lo: Any = None   # int only
    hi: Any = None   # int only
    description: str = ""


TUNABLE_KNOBS: list[Knob] = [
    Knob("recall_fact_limit", "int", 30, 5, 60,
         "How many fresh facts to inject into the recall block per turn."),
    Knob("smart_escalation_prompt_chars", "int", 1500, 400, 4000,
         "Prompt length (chars) above which a turn is treated as complex and may escalate to the smart model."),
    Knob("recall_enabled", "bool", True, None, None,
         "Whether to inject the semantic recall block at all."),
]
_BY_NAME = {k.name: k for k in TUNABLE_KNOBS}


def clamp_knobs(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Drop unknown keys, coerce types, clamp ints to [lo, hi]. Never raises."""
    out: dict[str, Any] = {}
    for name, val in (raw or {}).items():
        k = _BY_NAME.get(name)
        if k is None:
            continue
        try:
            if k.kind == "int":
                iv = int(val)
                out[name] = max(k.lo, min(k.hi, iv))
            elif k.kind == "bool":
                out[name] = bool(val) if not isinstance(val, str) else val.strip().lower() in ("1", "true", "yes")
        except Exception:
            continue
    return out


def effective_knobs(active: dict[str, Any] | None) -> dict[str, Any]:
    """Defaults overlaid with clamped active overrides — the values the engine reads."""
    out = {k.name: k.default for k in TUNABLE_KNOBS}
    out.update(clamp_knobs(active))
    return out


def knob_registry() -> list[dict[str, Any]]:
    """JSON-serializable registry for the optimizer prompt + the UI."""
    return [
        {"name": k.name, "kind": k.kind, "default": k.default,
         "lo": k.lo, "hi": k.hi, "description": k.description}
        for k in TUNABLE_KNOBS
    ]
```

### Tests
`tests/learning/test_knobs.py`: clamp drops unknown keys; clamps `recall_fact_limit=999`→60 and `=1`→5; coerces bool from "true"/"false"; `effective_knobs(None)` == all defaults; `effective_knobs({"recall_fact_limit": 10})` overrides one, keeps rest; `effective_knobs({"bogus": 1})` == defaults.
`tests/learning/test_schema.py`: run `migrate(conn)` twice on an in-memory sqlite (idempotent), then assert the 4 tables exist (`SELECT name FROM sqlite_master WHERE type='table'`).

`__init__.py` exports knobs helpers + schema.

Commit: `feat(learning): schema + bounded tunable-knobs registry`

---

## Task 2: trace capture + signal derivation + engine hook

**Files:** Create `seraphine/learning/traces.py`; Test `tests/learning/test_traces.py`. Modify `seraphine/conversation/engine.py`.

### traces.py
```python
"""Cheap, fire-and-forget interaction-trace capture for the learning loop."""
from __future__ import annotations
import json, uuid
from datetime import datetime, timezone
from typing import Any
import logging

logger = logging.getLogger(__name__)


def derive_signal(reaction: str | None) -> float | None:
    """Map a user reaction to a quality signal in [0,1]; None when unknown."""
    if not reaction:
        return None
    r = reaction.strip().lower()
    if r in ("up", "thumbs_up", "positive", "good", "👍"):
        return 1.0
    if r in ("down", "thumbs_down", "negative", "bad", "👎"):
        return 0.0
    return None


async def record_trace(store: Any, *, conversation_id: str | None, turn_id: str | None,
                       user_msg: str, assistant_msg: str, tools: list[str] | None = None,
                       feature: str = "chat", signal: float | None = None) -> None:
    """Insert one learning_trace row. Swallows all errors (never breaks a turn)."""
    def _work() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO learning_trace (id, ts, conversation_id, turn_id, "
                "user_msg, assistant_msg, tools_json, feature, signal) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), datetime.now(timezone.utc).isoformat(),
                 conversation_id, turn_id, (user_msg or "")[:4000],
                 (assistant_msg or "")[:8000], json.dumps(tools or []), feature, signal),
            )
    try:
        import asyncio
        await asyncio.to_thread(_work)
    except Exception as e:  # noqa: BLE001
        logger.debug("record_trace failed: %s", e)


async def recent_traces(store: Any, *, limit: int = 50, prefer_low_signal: bool = False) -> list[dict[str, Any]]:
    """Read recent traces as dicts. prefer_low_signal sorts NULL/low signal first."""
    def _work() -> list[dict[str, Any]]:
        with store._connect() as conn:
            order = "signal IS NOT NULL, signal ASC, ts DESC" if prefer_low_signal else "ts DESC"
            rows = conn.execute(
                f"SELECT id, ts, conversation_id, turn_id, user_msg, assistant_msg, "
                f"tools_json, feature, signal FROM learning_trace ORDER BY {order} LIMIT ?",
                (int(limit),),
            ).fetchall()
        cols = ["id", "ts", "conversation_id", "turn_id", "user_msg", "assistant_msg", "tools_json", "feature", "signal"]
        return [dict(zip(cols, r)) for r in rows]
    import asyncio
    return await asyncio.to_thread(_work)
```

### Engine hook
In `engine.py`, right after `assistant_turn = await self.store.add_turn(conversation_id, "assistant", final_text)` (~:1323), add a fire-and-forget trace (guarded; only when the learning module is available):
```python
        try:
            import asyncio as _aio
            from seraphine.learning.traces import record_trace
            _aio.create_task(record_trace(
                self.store, conversation_id=conversation_id, turn_id=turn_id,
                user_msg=content, assistant_msg=final_text,
                tools=list(getattr(self, "_turn_tools_used", []) or []), feature="chat",
            ))
        except Exception:
            pass
```
(If there's already a per-turn list of tool names used, pass it; otherwise pass `[]` — find whether the turn loop collects tool names. If not trivially available, pass `[]` and note it; tools_json can be enriched later.)

### Tests
`tests/learning/test_traces.py`: `derive_signal("up")==1.0`, `("down")==0.0`, `(None) is None`, `("weird") is None`. With an in-memory MemoryStore (register learning migrator + ensure_schema): `record_trace(...)` then `recent_traces(limit=10)` returns the row with the right fields; `record_trace` with a store whose `_connect` raises does NOT raise (swallow). `recent_traces(prefer_low_signal=True)` orders a signal=0.0 row before a signal=None... (just assert it returns without error + count).

Commit: `feat(learning): interaction-trace capture + engine hook`

---

## Task 3: evaluator (LLM-judge over the frozen eval set)

**Files:** Create `seraphine/learning/evaluator.py`; Test `tests/learning/test_evaluator.py`.

Design for testability: the evaluator takes an injected async `llm_call(messages: list[dict]) -> str`. It does, per eval case: (1) ask the responder to answer `case.input_text` under the policy; (2) ask a judge to score the answer vs `case.rubric`, returning strict JSON `{"score": <0..1>}`. Parse robustly; on any error score the case `0.5` (neutral) so one bad case can't tank/inflate the run. Concurrency-bounded with a small semaphore. Return mean + per-case list.

```python
from __future__ import annotations
import asyncio, json, re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
import logging

logger = logging.getLogger(__name__)
LLMCall = Callable[[list[dict[str, str]]], Awaitable[str]]


@dataclass
class EvalResult:
    score: float
    per_case: list[dict[str, Any]] = field(default_factory=list)
    n: int = 0


def _parse_score(text: str) -> float:
    try:
        m = re.search(r'\{.*\}', text or "", re.S)
        if m:
            v = float(json.loads(m.group(0)).get("score"))
            return max(0.0, min(1.0, v))
    except Exception:
        pass
    m = re.search(r'(\d+(?:\.\d+)?)', text or "")
    if m:
        v = float(m.group(1))
        if v > 1.0:
            v = v / 10.0 if v <= 10 else 1.0
        return max(0.0, min(1.0, v))
    return 0.5


async def evaluate_policy(llm_call: LLMCall, *, behavior_addendum: str, tool_guidance: str,
                          eval_cases: list[dict[str, Any]], base_instruction: str = "",
                          concurrency: int = 3) -> EvalResult:
    if not eval_cases:
        return EvalResult(score=0.5, per_case=[], n=0)
    sem = asyncio.Semaphore(concurrency)

    async def _one(case: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            sys = "\n\n".join(p for p in [base_instruction, behavior_addendum, tool_guidance] if p)
            try:
                answer = await llm_call([
                    {"role": "system", "content": sys or "You are Seraphine."},
                    {"role": "user", "content": case.get("input_text", "")},
                ])
            except Exception as e:  # noqa: BLE001
                logger.debug("eval responder failed: %s", e)
                return {"id": case.get("id"), "score": 0.5, "error": "responder"}
            judge_prompt = (
                "Score how well the ASSISTANT_ANSWER satisfies the RUBRIC, from 0.0 to 1.0. "
                'Reply with ONLY JSON: {"score": <number>}.\n\n'
                f"RUBRIC:\n{case.get('rubric','')}\n\nASSISTANT_ANSWER:\n{answer}"
            )
            try:
                verdict = await llm_call([{"role": "user", "content": judge_prompt}])
                score = _parse_score(verdict)
            except Exception as e:  # noqa: BLE001
                logger.debug("eval judge failed: %s", e)
                score = 0.5
            return {"id": case.get("id"), "score": score}

    per_case = await asyncio.gather(*[_one(c) for c in eval_cases])
    mean = sum(c["score"] for c in per_case) / len(per_case)
    return EvalResult(score=mean, per_case=list(per_case), n=len(per_case))
```

### Tests
`tests/learning/test_evaluator.py` with a scripted `llm_call`:
- `test_parse_score` variants (`'{"score":0.8}'`→0.8, `'7/10'`→0.7, `'0.95'`→0.95, garbage→0.5, clamps >1).
- `test_empty_cases_neutral`: no cases → score 0.5, n 0.
- `test_mean_of_scores`: a fake `llm_call` that returns a fixed answer for responder turns and `'{"score": 1.0}'` for judge turns → mean 1.0 over 2 cases. (Disambiguate responder vs judge by inspecting the message content: judge messages contain "RUBRIC".)
- `test_responder_error_scores_neutral`: `llm_call` raising on the responder → that case 0.5, no crash.

Commit: `feat(learning): regression-eval harness (LLM judge over frozen set)`

---

## Task 4: optimizer (teacher proposes a candidate)

**Files:** Create `seraphine/learning/optimizer.py`; Test `tests/learning/test_optimizer.py`.

```python
from __future__ import annotations
import json, re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
import logging
from seraphine.learning.knobs import clamp_knobs, knob_registry

logger = logging.getLogger(__name__)
LLMCall = Callable[[list[dict[str, str]]], Awaitable[str]]


@dataclass
class Candidate:
    behavior_addendum: str = ""
    tool_guidance: str = ""
    knobs: dict[str, Any] = field(default_factory=dict)
    rationale: str = ""


def _extract_json(text: str) -> dict[str, Any]:
    try:
        m = re.search(r'\{.*\}', text or "", re.S)
        return json.loads(m.group(0)) if m else {}
    except Exception:
        return {}


def _summarize_traces(traces: list[dict[str, Any]], limit: int = 25) -> str:
    out = []
    for t in traces[:limit]:
        sig = t.get("signal")
        tag = "" if sig is None else f" [signal={sig}]"
        out.append(f"- U: {(t.get('user_msg') or '')[:200]}\n  A: {(t.get('assistant_msg') or '')[:200]}{tag}")
    return "\n".join(out)


async def propose_candidate(llm_call: LLMCall, *, traces: list[dict[str, Any]],
                            active_behavior: str, active_tool_guidance: str,
                            active_knobs: dict[str, Any]) -> Candidate:
    """Ask the teacher for an improved policy. Robust to malformed output."""
    prompt = (
        "You are improving the assistant 'Seraphine' from real conversation traces. "
        "Propose a SMALL, SAFE refinement. Output ONLY JSON with keys: "
        '"behavior_addendum" (concise guidance appended to the system prompt), '
        '"tool_guidance" (concise guidance on WHEN to use tools like memory recall, calendar, search), '
        '"knobs" (object; ONLY the whitelisted knobs below, within bounds), '
        '"rationale" (1-2 sentences).\n\n'
        f"WHITELISTED KNOBS:\n{json.dumps(knob_registry(), ensure_ascii=False)}\n\n"
        f"CURRENT behavior_addendum:\n{active_behavior or '(none)'}\n\n"
        f"CURRENT tool_guidance:\n{active_tool_guidance or '(none)'}\n\n"
        f"CURRENT knobs:\n{json.dumps(active_knobs)}\n\n"
        f"RECENT TRACES (prioritize fixing low-signal ones):\n{_summarize_traces(traces)}"
    )
    try:
        raw = await llm_call([{"role": "user", "content": prompt}])
    except Exception as e:  # noqa: BLE001
        logger.warning("optimizer LLM failed: %s", e)
        return Candidate(rationale="optimizer-llm-error")
    data = _extract_json(raw)
    return Candidate(
        behavior_addendum=str(data.get("behavior_addendum", "") or "")[:2000],
        tool_guidance=str(data.get("tool_guidance", "") or "")[:2000],
        knobs=clamp_knobs(data.get("knobs") if isinstance(data.get("knobs"), dict) else {}),
        rationale=str(data.get("rationale", "") or "")[:500],
    )
```

### Tests
`tests/learning/test_optimizer.py`: a scripted `llm_call` returning a JSON blob (with an out-of-bounds knob + an unknown knob) → assert `behavior_addendum`/`tool_guidance` captured, knobs clamped + unknown dropped, rationale captured. A `llm_call` returning garbage → empty Candidate, no crash. A raising `llm_call` → `rationale=="optimizer-llm-error"`.

Commit: `feat(learning): teacher optimizer proposing policy candidates`

---

## Task 5: LearningService — run_cycle (regression gate) + promote/reject/rollback

**Files:** Create `seraphine/learning/service.py`; Test `tests/learning/test_service.py`.

`LearningService(store, llm_call, *, default_base_instruction="")`. `llm_call` is the injected async function (in prod, a thin wrapper over `self.llm`; in tests, scripted).

Methods:
- `async def get_active_policy() -> dict` → latest `learning_policy WHERE active=1` as `{version, behavior_addendum, tool_guidance, knobs}` or `{version:0, "": "", knobs:{}}` default.
- `async def ensure_eval_set(self, *, min_cases=8) -> int`: count active eval cases; if `< min_cases`, sample recent traces (via `recent_traces`) lacking a case and insert `learning_eval_case` rows with `input_text=trace.user_msg`, a default `rubric` ("A resposta é útil, condizente com o estilo do usuário, e usa ferramentas apropriadamente quando necessário."). Return total active cases. (No LLM needed — keeps the cycle cheap and deterministic.)
- `async def list_eval_cases() -> list[dict]`.
- `async def run_cycle(self, *, tolerance=0.02, trace_limit=50) -> dict`:
  1. `await self.ensure_eval_set()`; load active cases (as dicts with id/input_text/rubric).
  2. `active = await self.get_active_policy()`.
  3. `baseline = await evaluate_policy(llm_call, behavior_addendum=active["behavior_addendum"], tool_guidance=active["tool_guidance"], eval_cases=cases, base_instruction=self.base)`.
  4. `traces = await recent_traces(store, limit=trace_limit, prefer_low_signal=True)`.
  5. `cand = await propose_candidate(llm_call, traces=traces, active_behavior=..., active_tool_guidance=..., active_knobs=active["knobs"])`.
  6. `cand_eval = await evaluate_policy(llm_call, behavior_addendum=cand.behavior_addendum, tool_guidance=cand.tool_guidance, eval_cases=cases, base_instruction=self.base)`.
  7. `passed = cand_eval.score >= baseline.score - tolerance` AND `(cand.behavior_addendum or cand.tool_guidance or cand.knobs)` (non-empty proposal). Insert a `learning_candidate` row: status `'pending'` if passed else `'rejected'`, with baseline/candidate scores + rationale (append "regressed: cand<base" when failing). Return a summary dict `{candidate_id, status, baseline_score, candidate_score, passed, rationale}`.
  NEVER writes to `learning_policy` (no auto-promote).
- `async def list_candidates(self, *, status=None, limit=50) -> list[dict]`.
- `async def get_candidate(self, candidate_id) -> dict | None`.
- `async def promote(self, candidate_id) -> int`: load the pending candidate; in one connection, `UPDATE learning_policy SET active=0 WHERE active=1`, `INSERT INTO learning_policy (ts, behavior_addendum, tool_guidance, knobs_json, from_candidate, active) VALUES (?,?,?,?,?,1)`, set candidate status `'promoted'`. Return the new `version` (lastrowid). Idempotent-ish: promoting a non-pending candidate raises ValueError.
- `async def reject(self, candidate_id) -> None`: set status `'rejected'`.
- `async def rollback(self, version) -> None`: `UPDATE learning_policy SET active=0 WHERE active=1` then `SET active=1 WHERE version=?`.

### Tests (`tests/learning/test_service.py`) — scripted `llm_call`
Drive `llm_call` deterministically by branching on message content (judge messages contain "RUBRIC"; optimizer messages contain "WHITELISTED KNOBS"; responder otherwise):
- `test_run_cycle_stores_pending_when_no_regression`: judge always returns `{"score":0.9}` (so baseline==candidate==0.9, passes gate), optimizer returns a valid candidate. After `run_cycle`, `list_candidates(status="pending")` has 1, status pending, candidate_score≈0.9.
- `test_run_cycle_rejects_on_regression`: make the judge score the CANDIDATE lower than baseline beyond tolerance (branch on whether the answer reflects the candidate addendum — simplest: have the optimizer return an addendum containing a sentinel, and the judge return 0.3 when the responder's system prompt contained that sentinel, else 0.9). Assert the stored candidate status is `'rejected'`.
- `test_promote_creates_active_version`: seed a pending candidate (via run_cycle or direct insert), `promote(id)` → returns version ≥1; `get_active_policy()` reflects its addendum/knobs; candidate status `'promoted'`.
- `test_promote_then_rollback`: promote candidate A (v1), promote candidate B (v2) → active is v2; `rollback(1)` → active is v1.
- `test_reject_sets_status` and `test_promote_non_pending_raises`.
- `test_ensure_eval_set_samples_traces`: insert 10 traces, `ensure_eval_set(min_cases=8)` → ≥8 active eval cases.

Commit: `feat(learning): run_cycle regression gate + human-gated promote/reject/rollback`

---

## Task 6: routes

**Files:** Create `seraphine/learning/routes.py`; Test `tests/learning/test_routes.py`.

`router = APIRouter(prefix="/learning", tags=["learning"])`, all reading `request.app.state.learning_service` (503 if None):
- `GET /learning/active` → `get_active_policy()`.
- `GET /learning/candidates?status=&limit=` → `list_candidates(...)`.
- `GET /learning/candidates/{cid}` → `get_candidate` (404 if None).
- `POST /learning/candidates/{cid}/promote` → `{version}` (400 on ValueError).
- `POST /learning/candidates/{cid}/reject` → `{ok:true}`.
- `GET /learning/traces?limit=` → `recent_traces`.
- `GET /learning/knobs` → `knob_registry()`.
- `POST /learning/run` → `run_cycle()` (manual trigger; returns the summary). Guard with a simple in-flight flag is optional.

### Tests
`tests/learning/test_routes.py`: TestClient with the router + an in-memory store + a real `LearningService` using a scripted `llm_call`. `GET /learning/knobs` → 200 list. `GET /learning/active` → 200 default (version 0). `POST /learning/run` → 200 summary. `GET /learning/candidates?status=pending` → reflects the run. Promote → 200 `{version}`; active now reflects it. No-service fallback → 503.

Commit: `feat(learning): REST routes for candidates/policy/run`

---

## Task 7: engine wiring — inject active policy + apply knobs

**Files:** Modify `seraphine/conversation/engine.py`, `seraphine/routing/router.py`, `seraphine/main.py`; Test `tests/learning/test_engine_policy.py`.

- `routing/router.py`: change `classify_complexity(inp, *, long_prompt_chars=_LONG_PROMPT_CHARS)` to accept the threshold; use it instead of the constant. (Keep the module const as the default.)
- `engine.py`:
  - `__init__`: `self._learning_service = None`; `self._active_policy_cache = None`; `self._active_policy_loaded_turn = -1`.
  - A helper `async def _load_active_policy(self) -> dict` that calls `self._learning_service.get_active_policy()` if set (guarded; returns the empty default on None/error). Cache per turn (refresh in the same once-per-turn spot as the #3 cost refresh, ~:1017).
  - At `:846` after the base system message, if the active policy has `behavior_addendum`/`tool_guidance`, append them as system messages:
    ```python
    pol = self._active_policy_cache or {}
    if pol.get("behavior_addendum"):
        messages.append(ChatMessage(role="system", content=pol["behavior_addendum"]))
    if pol.get("tool_guidance"):
        messages.append(ChatMessage(role="system", content=pol["tool_guidance"]))
    ```
  - Apply knobs via `effective_knobs(pol.get("knobs"))`: in `_build_recall_block`, use `recall_fact_limit` for the `list_facts(limit=...)` and skip the block entirely when `recall_enabled` is False; pass `smart_escalation_prompt_chars` into the router call (`classify_complexity(..., long_prompt_chars=knobs["smart_escalation_prompt_chars"])` — thread it through `_pick_model` as a param read from the cached knobs).
  - Mind: `_build_recall_block` is sync-ish/async — read the cached knobs from `self`. Compute `self._effective_knobs` once per turn alongside the policy load.
- `main.py`: construct `LearningService(store, llm_call=<wrapper>, default_base_instruction=engine.system_prompt[:500])` after the engine + telemetry exist; register the learning migrator (before ensure_schema, with the others); `app.state.learning_service = learning_service`; `engine._learning_service = learning_service`; `app.include_router(learning_router)`. The `llm_call` wrapper adapts `self.llm` to `async def llm_call(messages) -> str` (mirror an existing one-shot call; convert dict messages → ChatMessage; accumulate a `chat()` stream or use the non-streaming method).

### Tests
`tests/learning/test_engine_policy.py`: build a ConversationEngine (mirror `tests/test_engine_unit.py`), set `engine._active_policy_cache = {"behavior_addendum":"SEMPRE responda em PT-BR.", "tool_guidance":"", "knobs":{"recall_fact_limit":7,"recall_enabled":True}}` and assert `effective_knobs` resolves recall_fact_limit to 7; and a focused test that `classify_complexity(RouteInputs(prompt="x"*500, ...), long_prompt_chars=400)=="complex"` while default 1500 keeps "x"*500 as "simple". (Keep engine assertions light — the policy-injection is hard to unit-test through the full stream; assert the helper + knob threading instead.)

Commit: `feat(learning): inject active policy + apply knobs in the chat engine`

---

## Task 8: nightly scheduler job

**Files:** Modify `seraphine/proactive/scheduler.py`; Test `tests/learning/test_scheduler_job.py`.

- In `ProactiveScheduler.start()`, add:
  ```python
  self._sched.add_job(self._tick_learning, "cron", hour=3, minute=30, name="learning_cycle")
  ```
- Add the method:
  ```python
  async def _tick_learning(self) -> None:
      try:
          svc = getattr(self.app_state, "learning_service", None)
          if svc is None:
              return
          result = await svc.run_cycle()
          logger.info("learning cycle: %s", result.get("status"))
      except Exception as e:
          logger.warning("learning cycle failed: %s", e)
  ```

### Test
`tests/learning/test_scheduler_job.py`: a fake `app_state` (object with a `learning_service` attr whose `run_cycle` is an AsyncMock returning `{"status":"pending"}`); construct `ProactiveScheduler(app_state, enabled=False)` and `await sched._tick_learning()` → asserts `run_cycle` awaited once. And with `learning_service=None` → no raise.

Commit: `feat(learning): nightly learning-cycle scheduler job`

---

## Task 9: frontend "Aprendizado" panel

**Files:** Create `src/learning/api.ts`, `src/learning/LearningView.tsx`, `src/learning/obsidian.css`; Modify `src/stores/uiStore.ts` (ActiveView 'learning'), `src/AppLayout.tsx`, `src/icons/Icons.tsx` (a `BrainIcon` if none fits).

- `api.ts`: `fetchActivePolicy()`, `fetchCandidates(status?)`, `promoteCandidate(id)`, `rejectCandidate(id)`, `fetchLearningTraces(limit)`, `runLearningCycle()`, `fetchKnobs()` against `${API_BASE}/learning/*`. Types for Candidate/Policy/Knob.
- `LearningView({onBack})`: header (mirror focus/telemetry: back + BrainIcon + "Aprendizado" + a "Rodar ciclo agora" button calling `runLearningCycle` then refetch). Sections:
  - **Candidatos pendentes**: each card shows score delta (baseline→candidate with a colored arrow), the proposed `behavior_addendum` + `tool_guidance` (as readable blocks), proposed knob changes (name: old→new), rationale, and **Promover** / **Rejeitar** buttons (confirm on promote). On promote, toast + refetch.
  - **Política ativa**: current version + addendum/guidance/knobs.
  - **Traces recentes** (collapsible): last N user→assistant pairs with the signal.
  - Loading/empty/error states; reuse the Obsidian glass-card pattern + `lrn-*` classes.
- Nav: add `'learning'` to `ActiveView`; AppLayout nav item `{id:'learning', label:'Aprendizado', group:'Sistema', icon:<BrainIcon size={22}/>, ...}` near telemetry/system; render branch `{activeView==='learning' && <LearningView onBack={()=>setActiveView('chat')} />}`.
- `pnpm tsc --noEmit` + `pnpm build`. A light vitest for `api.ts` (mocked fetch) asserting the candidate/promote URLs.

Commit: `feat(learning): Aprendizado review panel (promote/reject candidates)`

---

## Final
- `cd apps/seraphine/backend && uv run pytest tests/learning/ -v` (all green) + `uv run python -c "import seraphine.main"`.
- `cd apps/seraphine/frontend && pnpm tsc --noEmit && pnpm build`.
- Aura-safety: Seraphine-only (no `packages/llm-adapters` change) — `import aura.main` still clean.
- Deploy: backend → `git push vps main` (traces + nightly cycle run on the VPS where real chat happens); desktop → `pnpm tauri:install` (the Aprendizado panel). Confirm with user.

## Notes
- Promotion is the ONLY path to production; `run_cycle` only ever writes `pending`/`rejected` candidates. Rollback re-activates any prior version — fully reversible.
- The eval set is sampled from real traces (v1 uses a fixed rubric — no LLM needed to build it), frozen until cases are added; the regression gate compares candidate vs baseline on the SAME frozen set, so the comparison is apples-to-apples.
- Knobs are a hard whitelist with clamping — the optimizer literally cannot propose a value outside the safe range (clamp drops/limits), and even a promoted knob is bounded. This is the bounded "tool-use heuristics" half of "both".
- Teacher = `self.llm` (cliproxy/local/cloud per deploy). On a flat/cliproxy deploy the whole cycle is $0; on a metered deploy the nightly cycle is a handful of calls — bounded by eval-set size.
- The trace signal v1 is derived from explicit reactions (👍/👎) when present, else NULL; the optimizer prioritizes low-signal traces. Richer signals (corrections, regen) can enrich `derive_signal` later.
