# Cost & Hardware-Aware Model Routing (OpenJarvis #3) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD. Platform-aware. cliproxy/local KEPT as the flat default; the explicit OpenRouter `chat_model` override always wins.

**Goal:** Replace the binary fast→smart escalation in `_pick_model` with a small, pure, fully-tested `ModelRouter` that picks a model per turn from (a) a cheap turn-complexity classifier and (b) a cost-as-constraint guard that reads the #2 telemetry — so simple turns stay on the cheap/local engine, complex turns escalate to the smart model, and escalation to a *metered* model is refused once a configurable daily cap is hit. The router is honest about the platform: it only escalates to a model the deployment actually has configured (Mac-local stays local; a cloud-configured VPS can escalate).

**Architecture:** New backend module `seraphine/routing/` — a pure `router.py` (no I/O; classifier + tier→model mapping + cost guard, all unit-testable) plus a thin integration in `conversation/engine.py` that feeds the router live signals (think/images/tool_iteration/prompt) + a cached "metered spend today" number sourced once per turn from a new `TelemetryService.metered_cost_since(...)`. cliproxy/local default and the OpenRouter explicit override are untouched chokepoints; only the `_pick_model` body changes.

**Tech:** Python/FastAPI, the existing `settings`, the #2 `TelemetryService`.

**Confirmed anchors:**
- `conversation/engine.py:1414 _pick_model(*, think, has_images, tool_iteration)` → returns a model-id override or None. Called at `:1024` ONLY when `or_model` (explicit OpenRouter) is unset. `_resolve_chat_llm` (`:1382`) picks cliproxy-default vs OpenRouter and is the top-priority path — DO NOT change its precedence.
- `config.py`: `anthropic_model` (cheap/fast default, e.g. claude-haiku), `anthropic_smart_model` (escalation target, "" = disabled), `llm_backend` ("openai"/"ollama" = local; "anthropic"/"claude_max" = cloud/flat), `llm_model` (local model id).
- `telemetry/service.py`: `TelemetryService(store)` with `record(...)` + `summary(*, days=7)` over the `llm_usage` table (cols: ts, backend, model, feature, input_tokens, output_tokens, cost_usd). `pricing.cost_for` returns 0.0 for cliproxy/claude_max (flat). "Metered" = cost_usd > 0 (anthropic/openrouter).
- The turn already resolves `chat_llm, or_model` once at `:1017` (async) before the tool loop — the right place to read+cache the cost number.

---

## Task 1: Pure ModelRouter — complexity classifier + tier mapping + cost guard

**Files:** Create `seraphine/routing/__init__.py`, `seraphine/routing/router.py`; Test `tests/routing/__init__.py`, `tests/routing/test_router.py`.

- [ ] **Step 1: Write failing tests** in `tests/routing/test_router.py`:

```python
from seraphine.routing.router import (
    classify_complexity, RouteInputs, RouterConfig, select_model,
)


def _cfg(**kw):
    base = dict(fast_model="claude-haiku-4-5", smart_model="claude-sonnet-4-6",
               local_backend=False, daily_cap_usd=5.0, metered_spend_today=0.0)
    base.update(kw)
    return RouterConfig(**base)


def test_classify_simple_short_chat():
    assert classify_complexity(RouteInputs(prompt="oi tudo bem?", think=False,
        has_images=False, tool_iteration=0)) == "simple"


def test_classify_complex_on_think():
    assert classify_complexity(RouteInputs(prompt="x", think=True,
        has_images=False, tool_iteration=0)) == "complex"


def test_classify_complex_on_images():
    assert classify_complexity(RouteInputs(prompt="x", think=False,
        has_images=True, tool_iteration=0)) == "complex"


def test_classify_moderate_on_tool_iteration():
    assert classify_complexity(RouteInputs(prompt="x", think=False,
        has_images=False, tool_iteration=1)) == "moderate"


def test_classify_complex_on_long_prompt_with_code():
    p = "```python\n" + ("a = 1\n" * 60) + "```\nrefatora isso pra mim por favor"
    assert classify_complexity(RouteInputs(prompt=p, think=False,
        has_images=False, tool_iteration=0)) == "complex"


def test_select_simple_uses_fast_default_returns_none():
    # simple turn → fast model is the adapter default → None (no override)
    assert select_model("simple", _cfg()) is None


def test_select_complex_escalates_to_smart():
    assert select_model("complex", _cfg()) == "claude-sonnet-4-6"


def test_select_smart_disabled_returns_none():
    # no smart model configured → never escalate
    assert select_model("complex", _cfg(smart_model="")) is None


def test_cost_guard_blocks_metered_escalation_over_cap():
    # over the daily cap → refuse to escalate to the metered smart model
    assert select_model("complex", _cfg(metered_spend_today=6.0)) is None


def test_cost_guard_allows_escalation_under_cap():
    assert select_model("complex", _cfg(metered_spend_today=1.0)) == "claude-sonnet-4-6"


def test_cost_guard_disabled_when_cap_zero():
    # daily_cap_usd <= 0 disables the guard entirely
    assert select_model("complex", _cfg(daily_cap_usd=0.0, metered_spend_today=999.0)) == "claude-sonnet-4-6"


def test_local_backend_never_escalates_to_cloud():
    # a pure-local deployment with no cloud smart model stays on the local default
    assert select_model("complex", _cfg(local_backend=True, smart_model="")) is None
```

Run: `cd apps/seraphine/backend && uv run pytest tests/routing/test_router.py -v` → FAIL (module missing).

- [ ] **Step 2: Implement `seraphine/routing/router.py`:**

```python
"""Pure, side-effect-free model router (OpenJarvis #3).

Decides a per-turn model-id override from a cheap complexity classifier plus a
cost-as-constraint guard. No I/O, no settings import, no telemetry call — all
inputs are passed in so the whole thing is trivially unit-testable. The engine
adapts live signals into RouteInputs/RouterConfig and applies the result.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Complexity = Literal["simple", "moderate", "complex"]

# Heuristic thresholds — deliberately conservative; tuned to avoid needless
# escalation on ordinary chat. A turn is "complex" when it clearly needs a
# stronger model (explicit thinking, vision, long/code-heavy prompt); "moderate"
# for multi-step tool chains; "simple" otherwise.
_LONG_PROMPT_CHARS = 1500
_CODE_FENCE = "```"


@dataclass(frozen=True)
class RouteInputs:
    prompt: str
    think: bool
    has_images: bool
    tool_iteration: int


@dataclass(frozen=True)
class RouterConfig:
    fast_model: str          # the cheap/default model id (adapter default)
    smart_model: str         # escalation target ("" = escalation disabled)
    local_backend: bool      # True when the deployment's default engine is local
    daily_cap_usd: float     # metered spend cap; <= 0 disables the cost guard
    metered_spend_today: float  # USD of metered (cost>0) spend so far today


def classify_complexity(inp: RouteInputs) -> Complexity:
    if inp.think or inp.has_images:
        return "complex"
    p = inp.prompt or ""
    if len(p) >= _LONG_PROMPT_CHARS or _CODE_FENCE in p:
        return "complex"
    if inp.tool_iteration > 0:
        return "moderate"
    return "simple"


def select_model(complexity: Complexity, cfg: RouterConfig) -> str | None:
    """Return a model-id override, or None to use the adapter's default.

    None means "keep the cheap/local default". A non-None string escalates to
    the smart model. The cost guard can veto an escalation back to None.
    """
    # Only "complex" turns escalate. "moderate"/"simple" keep the default
    # (the default is already the cheap/local engine).
    if complexity != "complex":
        return None
    # No smart model configured (e.g. pure-local Mac) → never escalate.
    if not cfg.smart_model:
        return None
    # Cost guard: if a cap is set and today's metered spend already meets/exceeds
    # it, refuse to escalate to the (metered) smart model. cliproxy/claude_max
    # smart models are flat ($0) — but the router can't tell flat from metered
    # here, so the guard is intentionally applied only when a positive cap is set
    # AND the deployment is NOT purely local/flat. A local_backend deployment's
    # "smart" path is treated as flat and never blocked.
    if cfg.daily_cap_usd > 0 and not cfg.local_backend:
        if cfg.metered_spend_today >= cfg.daily_cap_usd:
            return None
    return cfg.smart_model
```

Run: `uv run pytest tests/routing/test_router.py -v` → PASS (all 11).

- [ ] **Step 3:** `seraphine/routing/__init__.py`:

```python
from seraphine.routing.router import (
    Complexity, RouteInputs, RouterConfig, classify_complexity, select_model,
)

__all__ = ["Complexity", "RouteInputs", "RouterConfig", "classify_complexity", "select_model"]
```
Empty `tests/routing/__init__.py`.

- [ ] **Step 4: Commit**
`git add seraphine/routing tests/routing && git commit -m "feat(routing): pure cost/complexity-aware model router"`

---

## Task 2: Telemetry — `metered_cost_since` fast aggregate

**Files:** Modify `seraphine/telemetry/service.py`; Test `tests/telemetry/test_metered_cost.py`.

- [ ] **Step 1: Failing test** `tests/telemetry/test_metered_cost.py`:

```python
import asyncio
from seraphine.memory.store import MemoryStore
from seraphine.telemetry import schema as telemetry_schema
from seraphine.telemetry.service import TelemetryService


def _svc(tmp_path):
    store = MemoryStore(str(tmp_path / "t.sqlite"))
    store.register_migrator("telemetry", telemetry_schema.migrate)
    asyncio.run(store.ensure_schema())
    return TelemetryService(store)


def test_metered_cost_since_sums_only_metered(tmp_path):
    svc = _svc(tmp_path)

    async def go():
        # metered (cost>0) anthropic call
        await svc.record(backend="anthropic", model="claude-sonnet-4-6",
                         feature="chat", input_tokens=1000, output_tokens=1000)
        # flat cliproxy call (cost 0) — must NOT count
        await svc.record(backend="cliproxy", model="claude-sonnet-4-6",
                         feature="chat", input_tokens=1000, output_tokens=1000)
        return await svc.metered_cost_since(hours=24)

    total = asyncio.run(go())
    assert total > 0.0  # only the anthropic row contributes


def test_metered_cost_since_empty_is_zero(tmp_path):
    svc = _svc(tmp_path)
    assert asyncio.run(svc.metered_cost_since(hours=24)) == 0.0
```

Run: `uv run pytest tests/telemetry/test_metered_cost.py -v` → FAIL (no method).

- [ ] **Step 2: Implement** — add to `TelemetryService`:

```python
async def metered_cost_since(self, *, hours: int = 24) -> float:
    """Sum of cost_usd for metered (cost>0) calls in the last ``hours``.

    Used by the router's cost guard. Cheap single-row aggregate; never raises
    (returns 0.0 on any error) so it can sit on the turn-setup path.
    """
    def _work() -> float:
        try:
            with self.store._connect() as conn:
                cur = conn.execute(
                    "SELECT COALESCE(SUM(cost_usd), 0.0) FROM llm_usage "
                    "WHERE cost_usd > 0 AND ts >= datetime('now', ?)",
                    (f"-{int(hours)} hours",),
                )
                row = cur.fetchone()
                return float(row[0]) if row and row[0] is not None else 0.0
        except Exception:
            return 0.0
    return await asyncio.to_thread(_work)
```
(Confirm `asyncio` is imported in service.py; the `ts` column is written via `datetime('now')`/ISO — match the existing INSERT's timestamp format so the `ts >=` comparison works. If `record` stores `ts` as a Python ISO string, keep the `datetime('now', ...)` comparison which SQLite parses for ISO-8601 text. Verify against the existing `summary` query's date filter and mirror it exactly.)

- [ ] **Step 3:** Run → PASS. Also re-run `uv run pytest tests/telemetry/ -v` (all still green).

- [ ] **Step 4: Commit**
`git add seraphine/telemetry/service.py tests/telemetry/test_metered_cost.py && git commit -m "feat(telemetry): metered_cost_since aggregate for the router cost guard"`

---

## Task 3: Wire the router into the engine

**Files:** Modify `seraphine/conversation/engine.py`; `config.py` (add `routing_daily_cap_usd`); Test `tests/conversation/test_pick_model_router.py`.

- [ ] **Step 1:** Add to `config.py` Settings (near `anthropic_smart_model`):

```python
    # Cost-aware routing: daily USD cap on *metered* (cloud) spend. When the
    # last-24h metered spend reaches this, the router refuses to escalate to the
    # metered smart model and stays on the cheap/local default. <= 0 disables.
    routing_daily_cap_usd: float = 0.0
```

- [ ] **Step 2: Failing test** `tests/conversation/test_pick_model_router.py` — construct a `ConversationEngine` (mirror the existing engine tests' construction; grep `tests/conversation/` for the fixture/way they build it with a fake llm + store) and assert:
  - with `anthropic_smart_model` set + a simple short prompt → `_pick_model(prompt="oi", think=False, has_images=False, tool_iteration=0)` returns None.
  - with smart set + `think=True` → returns the smart model id.
  - with smart set + a cap of 1.0 and a cached `_metered_spend_today = 5.0` → `think=True` returns None (guard).
  (Set the engine's cached spend field directly in the test. If building a full engine is heavy, instead unit-test a thin extracted method — see Step 3 — that takes the same args. Prefer testing through `_pick_model` if the existing tests show an easy construction.)

Run → FAIL.

- [ ] **Step 3: Implement.** In `engine.py`:
  1. `__init__`: add `self._metered_spend_today: float = 0.0` and `self._telemetry_service = None` (set by main.py wiring in Step 4; tolerate None).
  2. Change `_pick_model` to ALSO accept `prompt: str = ""` and delegate to the router:

```python
    def _pick_model(self, *, think=False, has_images=False, tool_iteration=0, prompt="") -> str | None:
        from seraphine.config import settings
        from seraphine.routing import RouteInputs, RouterConfig, classify_complexity, select_model

        smart = settings.anthropic_smart_model
        if not smart:
            return None  # routing disabled — adapter default
        local = settings.llm_backend in ("openai", "ollama")
        complexity = classify_complexity(RouteInputs(
            prompt=prompt or "", think=think, has_images=has_images,
            tool_iteration=tool_iteration,
        ))
        override = select_model(complexity, RouterConfig(
            fast_model=settings.anthropic_model, smart_model=smart,
            local_backend=local, daily_cap_usd=settings.routing_daily_cap_usd,
            metered_spend_today=self._metered_spend_today,
        ))
        if override:
            logger.debug("router → %s (%s, iter=%d, spend=%.4f/%.2f)", override,
                         complexity, tool_iteration, self._metered_spend_today,
                         settings.routing_daily_cap_usd)
        return override
```
  3. At the call site (`:1024`), pass `prompt=content` into `_pick_model(...)`.
  4. Refresh the cached spend ONCE per turn, cheaply, right after `chat_llm, or_model = await self._resolve_chat_llm()` (`:1017`), guarded so it never breaks a turn:

```python
        # Refresh the cost-guard signal once per turn (cheap aggregate; never
        # raises). Skips entirely when the cap is disabled or no telemetry.
        from seraphine.config import settings as _settings
        if _settings.routing_daily_cap_usd > 0 and self._telemetry_service is not None:
            try:
                self._metered_spend_today = await self._telemetry_service.metered_cost_since(hours=24)
            except Exception:
                pass
```

- [ ] **Step 4: Wire telemetry_service into the engine in `main.py`.** Where the `ConversationEngine`/engine is constructed in the lifespan (grep `ConversationEngine(` or where `app.state` engine is built), after `telemetry_service` exists, set `engine._telemetry_service = telemetry_service` (or pass via constructor if clean). Confirm ordering: `telemetry_service` is built before the engine.

- [ ] **Step 5:** Run `uv run pytest tests/routing/ tests/telemetry/ tests/conversation/test_pick_model_router.py -v` → all PASS. Then `uv run python -c "import seraphine.main; print('ok')"`.

- [ ] **Step 6: Commit**
`git add seraphine/conversation/engine.py seraphine/config.py seraphine/main.py tests/conversation/test_pick_model_router.py && git commit -m "feat(routing): wire cost/complexity router into the chat engine"`

---

## Final
- `cd apps/seraphine/backend && uv run pytest tests/routing/ tests/telemetry/ -v && uv run python -c "import seraphine.main"`.
- Aura-safety: this is Seraphine-only (engine.py, telemetry) — `packages/llm-adapters` untouched here. Confirm `import aura.main` still clean (it imports the shared adapter, unaffected).
- Deploy: backend → `git push vps main` (cost guard works on the VPS where metered cloud is actually used; on Mac-local it's a no-op since cap defaults 0 and backend is local). Confirm with user.

## Notes
- Default `routing_daily_cap_usd=0.0` → the cost guard is OFF by default; behavior is the richer complexity classifier replacing the old `tool_iteration>0`-only escalation. Opt in by setting a cap.
- The router NEVER touches the explicit OpenRouter override (`or_model`) — that path stays first-priority in `_resolve_chat_llm`.
- "Metered today" is last-24h rolling, not calendar-day — simpler and good enough for a spend guard; documented as such.
- cliproxy/claude_max smart models are flat ($0); on those deployments set the cap to 0 (default) so escalation is never blocked. The `local_backend` flag also exempts local/flat deployments from the guard.
