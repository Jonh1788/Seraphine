# Telemetry — Cost & Energy (OpenJarvis #2) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD. Platform-aware (token/cost everywhere; energy = Mac-only). cliproxy/Claude-Max kept (its marginal cost = $0, flat sub).

**Goal:** Make Seraphine's LLM cost (tokens + $) and — on a local Mac backend — energy draw visible: capture every LLM call's token usage at the adapter chokepoint, persist with a computed cost from a per-model price table, and surface a "Custos / Energia" dashboard. This is the foundation that the router (#3) and learning loop (#1) read for cost-as-constraint.

**Architecture:** A new backend module `seraphine/telemetry/` (schema + service + routes + price table). An OPTIONAL telemetry sink injected into the shared `llm_adapters` clients — no-op by default so Aura (which shares the package) is unaffected. The AnthropicClient records usage from its SSE stream (`message_start`/`message_delta` usage) and from `tool_call_json`/`complete` response `usage`. A Rust Tauri `read_power` command samples Apple-Silicon power via `powermetrics` (Mac only; no-op elsewhere). A frontend telemetry panel shows per-model/cumulative tokens + $ + cloud-vs-local savings, and (Mac) current power draw.

**Tech:** Python/FastAPI, SQLite via MemoryStore, the existing `AnthropicClient`/`OpenRouterChatClient`, Rust (Tauri command), React+TS.

**Confirmed anchors:**
- `packages/llm-adapters/src/llm_adapters/anthropic.py` — `AnthropicClient.__init__(api_key, model, base_url, timeout, max_tokens)`; `chat()` (streaming SSE, parses `event:`/`data:` per line ~470-560 — `message_start` carries `usage.input_tokens`, `message_delta` carries `usage.output_tokens`); `tool_call_json` (344) + `complete` return after a non-streaming POST whose JSON has `usage`. **Used by Aura too** (`apps/aura/backend/aura/*`) → telemetry must be optional/no-op.
- `deepsearch/providers.py` — `OpenRouterChatClient` (OpenAI-compatible; response has `usage.{prompt_tokens,completion_tokens}`).
- `main.py` lifespan — `llm = AnthropicClient(api_key=, model=, base_url=)` (~126); `app.state.store`. Per-feature module pattern: `store.register_migrator(name, schema.migrate)` + `await store.ensure_schema()` + construct service + `app.state.X = svc` + `app.include_router`.
- MemoryStore: `with self.store._connect() as conn` in `def _work()` via `asyncio.to_thread`; rows are tuples.
- Tauri: `src-tauri/src/` command pattern (e.g. `mac_tools.rs` shells commands; `agents/observer.rs` reads files). `generate_handler!` in `lib.rs`.

---

## Task 1: Telemetry backend — schema + service + price table

**Files:** `seraphine/telemetry/__init__.py`, `schema.py`, `pricing.py`, `service.py` (new); tests `tests/telemetry/`.

- Schema `llm_usage` table: `id TEXT PK, ts TEXT, backend TEXT, model TEXT, feature TEXT, input_tokens INT, output_tokens INT, cost_usd REAL`. Migrator `migrate(conn)` idempotent.
- `pricing.py`: `PRICES: dict[str, tuple[float, float]]` = model → ($/1M input, $/1M output). cliproxy/claude_max models → (0.0, 0.0) (flat-sub, no marginal cost). Include claude-haiku/sonnet/opus, common OpenRouter ids. `cost_for(model, backend, in_tok, out_tok) -> float`: if backend in {cliproxy, claude_max} → 0.0; else look up PRICES (default a conservative fallback), compute.
- `service.py` `TelemetryService(store)`:
  - `async def record(self, *, backend, model, feature, input_tokens, output_tokens)` → compute cost via pricing, INSERT a row. Never raises into the caller (swallow + log).
  - `async def summary(self, *, days=7) -> dict`: totals (tokens in/out, cost) overall + grouped by model + by feature + by day; plus `cloud_cost` vs `local_calls` (backend cliproxy/claude_max count). Read via `_connect`.
- TDD: pricing math (cliproxy=0, openrouter model computes), record persists + summary aggregates (in-memory MemoryStore).

Commit: `feat(telemetry): llm_usage schema + pricing table + service`

---

## Task 2: Optional telemetry sink in the LLM adapters (capture usage)

**Files:** `packages/llm-adapters/src/llm_adapters/anthropic.py`; `deepsearch/providers.py` (OpenRouterChatClient).

- Define a tiny sink protocol (a callable): `telemetry: Callable[[dict], None] | None`. The dict = `{backend, model, input_tokens, output_tokens}`. Add `telemetry=None` param to `AnthropicClient.__init__` (default None → no-op; Aura passes nothing → unaffected).
- In `chat()`: while parsing SSE, capture `input_tokens` from the `message_start` event's `message.usage.input_tokens` and the latest `message_delta`'s `usage.output_tokens`; on stream end (the final done Token), if `self.telemetry`, call it with `{backend:'cliproxy'|'anthropic', model: body['model'], input_tokens, output_tokens}`. (Derive backend from base_url containing cliproxy/127.0.0.1 → 'cliproxy', else 'anthropic'.) Wrap in try/except so telemetry never breaks the stream.
- In `tool_call_json` + `complete`: after `data = resp.json()`, read `data.get('usage', {})` → `input_tokens`/`output_tokens`; call `self.telemetry` if set.
- `OpenRouterChatClient` (providers.py): same — capture `usage.prompt_tokens`/`completion_tokens` from its responses, call an injected telemetry sink (`backend:'openrouter'`).
- TDD: a fake telemetry sink + a stubbed httpx response with `usage` → assert the sink receives the right tokens; assert no-op when telemetry=None.

Commit: `feat(telemetry): capture token usage in anthropic + openrouter adapters (opt-in sink)`

---

## Task 3: Wire the sink + routes

**Files:** `main.py` (lifespan), `telemetry/routes.py`, `telemetry/__init__.py`.

- In lifespan: construct `telemetry_service = TelemetryService(store)` (after store); build a sink closure `def _sink(rec): asyncio.create_task(telemetry_service.record(..., feature=<current>))` — feature defaults to 'chat'; pass `telemetry=_sink` to the `AnthropicClient(...)` construction. Register migrator + `app.state.telemetry_service`.
- `routes.py`: `GET /telemetry/summary?days=7` → `service.summary(days)`; `GET /telemetry/power` → returns `{supported: false}` on the backend (power is read client-side via Tauri; this endpoint is a placeholder/marker). Include the router.
- Smoke: `import seraphine.main`.

Commit: `feat(telemetry): wire sink into lifespan + summary route`

---

## Task 4: Rust power sampler (Mac, platform-guarded)

**Files:** `src-tauri/src/telemetry.rs` (new), `mod`/`lib.rs` registration.

- `#[tauri::command] pub fn read_power() -> Result<serde_json::Value, String>`: on macOS, run `powermetrics` for a short sample (`powermetrics -n 1 -i 200 --samplers cpu_power,gpu_power` — needs sudo; if it fails, fall back to a no-sudo estimate or return `{supported:false}`). Parse CPU+GPU mW → return `{supported:true, cpu_mw, gpu_mw, package_mw}`. On non-macOS (`#[cfg(not(target_os="macos"))]`) → `{supported:false}`. Wrap so a failure returns `{supported:false, error}` not a hard error.
- Register in `lib.rs` generate_handler. (NOTE: powermetrics typically needs sudo — if it prompts/fails, return supported:false gracefully; the dashboard shows "energia indisponível". Document this; a sudoers entry is a user setup step, out of scope.)

Commit: `feat(telemetry): rust read_power command (powermetrics, mac-only, graceful)`

---

## Task 5: Frontend dashboard

**Files:** `src/telemetry/` (api.ts, TelemetryView.tsx, obsidian.css), `stores/uiStore.ts` (ActiveView 'telemetry'), `AppLayout.tsx` (nav + render), `icons/Icons.tsx` if a new icon needed (reuse an existing chart/coin icon).

- `api.ts`: `fetchTelemetrySummary(days)` → GET `/telemetry/summary`; `readPower()` → Tauri `invoke('read_power')` (try/catch → {supported:false}).
- `TelemetryView`: cards for cloud spend (today/7d) + tokens in/out + per-model breakdown bars + per-feature + a "local (cliproxy = $0) vs cloud" framing; a power widget (Mac) showing current CPU/GPU draw with a "indisponível" state. Reuse the Obsidian dashboard pattern (glass cards, accent sparingly).
- Wire as a nav item in the "Trabalho" or "Sistema" group (it's a system/infra panel). ActiveView 'telemetry'.
- Verify: tsc + build.

Commit: `feat(telemetry): Custos/Energia dashboard panel`

---

## Final
- `cd apps/seraphine/backend && uv run pytest tests/telemetry/ -v`; `import seraphine.main`.
- `cd apps/seraphine/frontend && pnpm tsc --noEmit && pnpm build`; `cargo build` (src-tauri).
- Deploy: backend → `git push vps main` (token/cost works on the VPS); desktop → `pnpm tauri:install` (power widget + dashboard). Confirm with user.

## Notes
- cliproxy/Claude-Max marginal cost = $0 (flat sub) — the dashboard frames this as "local/flat" vs metered cloud (OpenRouter/ElevenLabs). This is the honest cost signal the router (#3) will use.
- Energy is Mac-local only; on the VPS the power widget shows "indisponível" — by design.
- The sink is fire-and-forget (asyncio.create_task) so telemetry never adds latency to a turn.
- Feature attribution v1: default 'chat'; deepsearch/flashcards/etc. can pass their own feature tag later.
