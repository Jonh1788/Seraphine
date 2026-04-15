# SDD: Monorepo Modularization — Seraphine + Aura + Mac Agent

**Status**: draft, awaiting approval before execution.
**Branch**: `refactor/monorepo`
**Goal**: extract Seraphine's functional modules into stand-alone packages so the same code backs (a) full-local Seraphine, (b) multi-tenant Aura on VPS, and (c) future mac-agent / mobile-agent clients.

---

## 1. Principles

- **No feature loss.** Every existing behaviour must still work after the refactor. Tests green at every commit.
- **Small, reviewable steps.** Each phase is a single commit or tight PR. Rollback = `git revert`.
- **Interfaces before movement.** Define module public API before moving files so callers can be updated mechanically.
- **Shared modules don't know which app they're running in.** They receive `get_current_user` dep + store + llm_client. No `if app == "seraphine"` anywhere.
- **Multi-tenant safety by construction.** Once the user_id column exists in shared modules, every query MUST filter by it. Property tests enforce isolation.
- **Don't extract what doesn't need to be shared yet.** Avatar, realtime, WhatsApp, memory/reflect, profile stay in `apps/seraphine`.

---

## 2. Target layout

```
repo/
  packages/                        # shared libs
    core-db/                       # MemoryStore, migrations, base connection
    core-auth/                     # User model, password hashing, JWT, FastAPI deps
    core-mcp/                      # MCP protocol client + server base
    mod-finance/                   # FinanceService, routes, models, tests
    mod-calendar/                  # CalendarService (google-agnostic interface)
    mod-tasks/                     # TaskService, routes, email_scanner
    mod-vision/                    # PDF + image recognition via LLM
    llm-adapters/                  # LLMClient Protocol + Anthropic/OpenAI impls
    google-integration/            # OAuth flow + Gmail/Calendar client
  apps/
    seraphine/                     # desktop, full-local (current Seraphine)
      backend/                     # current backend/seraphine → moves here
      frontend/                    # current frontend/ → moves here
    aura/                          # multi-tenant, VPS-hosted
      backend/
      frontend/
    mac-agent/                     # (future) Tauri menu-bar app, MCP server for Mac tools
    seraphine-mobile/              # (future) Tauri iOS/Android
  specs/                           # SDDs (kept as-is)
  tooling/                         # shared scripts, docker helpers
  pyproject.toml                   # workspace root (uv workspaces)
  package.json                     # pnpm workspaces root
  README.md
```

---

## 3. Module boundaries (what moves where)

### 3.1 `packages/core-db/`

**From**: `backend/seraphine/memory/store.py` (ONLY the base MemoryStore class + low-level connection + generic migration helpers).

**NOT included** (stays in seraphine app layer, reason: Seraphine-specific semantics):
- `facts`, `event_timeline`, `notifications`, `conversation_summaries`, `turns`, `tool_audit`, `conversations` — these are Seraphine's long-term memory + audit. Aura doesn't use them.
- Reflection / semantic memory logic (`manager.py`, `profile.py`, `routes.py`).

**Included**:
- `MemoryStore.__init__`, `_connect`, `aclose`, `ensure_schema`.
- The `seraphine_tasks`, `push_subscriptions`, `finance_entries`, `finance_recurring`, `calendar_*` table creation moves OUT of ensure_schema and into each module's own schema migrator.

**Public API**:
```python
class Store:
    async def ensure_schema(self): ...  # calls each registered module's migrator
    def register_migrator(self, fn: Callable[[sqlite3.Connection], None]): ...
    async def connect(self) -> sqlite3.Connection: ...
```

Each module calls `store.register_migrator(my_create_schema)` at init time.

### 3.2 `packages/core-auth/`

**New**. Does not exist in Seraphine today.

- `User` dataclass (id, email, password_hash, created_at, metadata JSON)
- password hashing (bcrypt or argon2)
- JWT issue/verify
- FastAPI `Depends` factory: `require_user()` returning `User`

**Seraphine behavior**: provides a `require_user()` that returns a hardcoded single user (id="default"). No login UI.
**Aura behavior**: provides `require_user()` that validates JWT from Authorization header; 401 if absent.

Both apps export a module-level `require_user` dep; shared modules import from the app's namespace (via a small DI container) or receive it as a constructor arg.

### 3.3 `packages/mod-finance/`

**From**: `backend/seraphine/finance/` (service.py, models.py, parser.py, routes.py)

**Changes**:
- Every dataclass gains optional `user_id: str | None = None`.
- Every SQL query gains `WHERE user_id = ?` when user_id is non-null. If NULL (seraphine), omit the filter.
- `FinanceService.__init__` takes `store` and optional `user_id` (if None → single-tenant mode).
- Route handlers use `Depends(require_user)` to get user_id, pass to service.
- Schema migrator: adds `user_id TEXT NULL` column (SQLite idempotent ALTER).

**Public API**: unchanged signatures on routes (+ authenticated user context).

Tests move alongside.

### 3.4 `packages/mod-tasks/`

**From**: `backend/seraphine/tasks/` (models.py, service.py, routes.py, email_scanner.py)

**Changes**:
- Same user_id additions as finance.
- `email_scanner` depends on `google-integration` package (for `GoogleClient.list_messages` + `download_attachment`) — inject it.
- `finance_import` execution path depends on `mod-finance` — inject via function callback, not direct import, to keep mod-tasks from hard-depending on mod-finance (mod-finance can be absent in Aura v1).

### 3.5 `packages/mod-calendar/`

**From**: pieces of `backend/seraphine/google/` specific to Calendar.

**Changes**:
- Core Calendar service is **provider-agnostic**: `CalendarProvider` Protocol with `list_events`, `create_event`, `update_event`, `delete_event`.
- Google implementation in `google-integration` package.
- Future: iCal provider, CalDAV provider — different package, same protocol.

### 3.6 `packages/mod-vision/`

**New** (currently inline in Seraphine tools and finance).

- `classify_pdf(bytes, context) -> Classification`
- `extract_receipt(bytes) -> ReceiptData`
- `extract_bank_statement(bytes, password?) -> list[Transaction]`
- `describe_image(bytes, prompt) -> str`

All use injected `LLMClient`. No hard Anthropic dep.

### 3.7 `packages/llm-adapters/`

**From**: `backend/seraphine/llm/anthropic.py`

- `LLMClient` Protocol: `complete()`, `stream()`, `tool_use()`, plus counts/tokens
- `AnthropicClient` (current CLIProxy-compatible)
- `OpenAIClient` (new, for Aura on VPS)
- Future: `LocalLLMClient` for MLX

Apps wire their chosen implementation once in lifespan.

### 3.8 `packages/google-integration/`

**From**: `backend/seraphine/google/` (client.py, oauth.py, routes.py)

**Changes**:
- Today: tokens stored single-file on disk. For Aura multi-user: tokens stored per user_id in DB.
- Extract `TokenStore` interface: `FileTokenStore` (seraphine) vs `DBTokenStore` (aura).
- Routes take `require_user` dep → passes user_id → TokenStore resolves correct bundle.

### 3.9 `packages/core-mcp/`

**New**. Future-facing.

- MCP protocol types
- Server base class (expose tools)
- Client for connecting to remote MCP server (e.g., Seraphine-VPS connecting to mac-agent's MCP)

Defined now but empty implementation until mac-agent phase.

### 3.10 Frontend packages

**Deferred**. UI divergence between Seraphine (avatar, realtime, WhatsApp panel) and Aura (minimal) is too large. Share at backend API level only.

Maybe later:
- `packages/frontend-ui` with glass card primitives, form components
- `packages/frontend-finance-ui` with FinanceDashboard + PendingReview + tasks cards

For now: `apps/seraphine/frontend/` = current `frontend/`. `apps/aura/frontend/` = new, built when we get there.

---

## 4. Staying in `apps/seraphine` (NOT extracted)

Everything below keeps single-tenant assumption, doesn't need Aura compat:

- `backend/seraphine/memory/manager.py` — reflect, fact extraction
- `backend/seraphine/memory/profile.py` — user profile aggregation
- `backend/seraphine/memory/routes.py` — facts CRUD, timeline, profile endpoints
- `backend/seraphine/ws/` — WebSocket routes, turn management, TTS streaming
- `backend/seraphine/tts/` — ElevenLabs, local TTS
- `backend/seraphine/stt/` — Whisper, realtime STT
- `backend/seraphine/whatsapp/` — WhatsApp bridge integration
- `backend/seraphine/conversation/engine.py` — the main LLM orchestration loop (very coupled to Seraphine's tool registry)
- `backend/seraphine/tools/` — Seraphine's tool registry (whatsapp_send, financial_import, etc.)
- `backend/seraphine/reminders/` — scheduler + notify
- `backend/seraphine/browser/` — Playwright browser tool
- `backend/seraphine/wise/` — Wise transfers
- `backend/seraphine/push/` — push subscriptions (could be shared, deferred)
- `backend/seraphine/bootstrap.py` — Seraphine-specific startup

If Aura needs any of these later, we revisit.

---

## 5. Phased execution plan

**Every phase ends with a commit. Tests must stay green.**

### Phase 0 — prep (this SDD)
- [x] Create branch `refactor/monorepo`.
- [ ] This SDD in `specs/monorepo-modularization-sdd.md` (approval gate).
- [ ] Smoke test current app boots + frontend builds before starting.

### Phase 1 — workspace skeleton (no code moves yet)
- Create `packages/` and `apps/` directories, empty.
- Add root `pyproject.toml` with `uv` workspace pointing at `packages/*` + `apps/*`.
- Add root `package.json` with pnpm workspaces.
- Create placeholder `packages/core-db/pyproject.toml`, etc., for each planned package (no code, just structure).
- Commit: `chore: workspace skeleton`.

### Phase 2 — move seraphine into `apps/seraphine/` as-is
- `git mv backend apps/seraphine/backend`
- `git mv frontend apps/seraphine/frontend`
- Update any absolute paths in configs (`.env` SQLite path, Vite config, CI, etc.)
- Run pytest + vite build + smoke run the app.
- Commit: `refactor: move seraphine into apps/seraphine/ (no functional changes)`.

### Phase 3 — extract `packages/llm-adapters` (low-risk smallest win)
- Move `apps/seraphine/backend/seraphine/llm/` → `packages/llm-adapters/src/llm_adapters/`
- Define `LLMClient` Protocol
- Update Seraphine imports: `from seraphine.llm.anthropic import AnthropicClient` → `from llm_adapters import AnthropicClient`
- Tests green.
- Commit: `refactor: extract llm-adapters package`.

### Phase 4 — extract `packages/core-db`
- Split `backend/seraphine/memory/store.py` into:
  - `packages/core-db/src/core_db/store.py` (base Store, migrations registry)
  - `apps/seraphine/backend/seraphine/memory/store.py` (Seraphine-specific tables: facts, events, etc.)
- Each module (tasks, finance, push) that had its CREATE TABLE in store.py moves that migration code into its own module's `schema.py`.
- Tests green.
- Commit: `refactor: extract core-db + distribute schema migrators`.

### Phase 5 — extract `packages/mod-tasks`
- Move `backend/seraphine/tasks/` → `packages/mod-tasks/src/mod_tasks/`
- Add `user_id` field (NULL default) to `SeraphineTask` + all SQL.
- Define `TasksConfig` that accepts `user_id_resolver: Callable[[], str | None]`.
- Seraphine wires user_id_resolver to always return None.
- Property test: with two users A and B, user A can't see user B's tasks.
- Commit: `refactor: extract mod-tasks + user_id column`.

### Phase 6 — extract `packages/mod-finance`
- Same playbook as tasks.
- Commit: `refactor: extract mod-finance + user_id column`.

### Phase 7 — extract `packages/google-integration`
- Move `backend/seraphine/google/` → `packages/google-integration/`.
- Refactor `TokenStore` to be pluggable (file vs DB).
- Seraphine keeps using `FileTokenStore`.
- Commit: `refactor: extract google-integration + pluggable TokenStore`.

### Phase 8 — extract `packages/mod-calendar`
- Split calendar logic into mod-calendar (provider-agnostic) + google-integration (provider).
- Commit: `refactor: extract mod-calendar with pluggable provider`.

### Phase 9 — extract `packages/core-auth`
- Build the auth package from scratch (not extracted from existing code).
- Seraphine integrates with a noop `SingleUserAuth` that always returns `user_id="default"`.
- Aura will use the real JWT implementation later.
- Commit: `feat: core-auth package with SingleUser fallback`.

### Phase 10 — extract `packages/mod-vision`
- Pull PDF/image classification logic out of `tools/financial.py` etc.
- Commit: `refactor: extract mod-vision`.

### Phase 11 — `packages/core-mcp` stub
- Define types and protocol shell.
- No implementation — placeholder for mac-agent phase.
- Commit: `feat: core-mcp protocol stub`.

### Phase 12 — Aura skeleton
- Create `apps/aura/backend` — FastAPI app that imports mod-tasks, mod-finance, core-auth, llm-adapters. Hard-codes OpenAI client. SQLite with multi-user.
- Minimal routes: `/auth/register`, `/auth/login`, `/tasks`, `/finance/*`.
- No frontend yet (can test with curl / Postman).
- Commit: `feat: aura backend skeleton — multi-tenant tasks + finance`.

### Phase 13 — Aura frontend
- `apps/aura/frontend` — fresh Vite+React. Can copy FinanceDashboard and TasksView from Seraphine as starting point (explicit copy, not shared package yet).
- Auth pages: login / register.
- Commit: `feat: aura frontend with auth + finance + tasks`.

### Phase 14 — Dockerize Aura
- `apps/aura/Dockerfile` — multi-stage build.
- Docker compose for local dev (aura + postgres optional).
- Commit: `feat: aura dockerfile for VPS deploy`.

### Phase 15 — merge to main
- Run full regression on Seraphine (feature list below).
- Smoke-test Aura locally.
- Merge `refactor/monorepo` → `main`.

---

## 6. Regression checklist (Seraphine, to run before merge)

- [ ] Backend boots via `uv run uvicorn ...`
- [ ] Frontend dev: `pnpm dev` (or `npm run dev`)
- [ ] Frontend build: `pnpm build`
- [ ] Chat WebSocket streams tokens
- [ ] TTS: ElevenLabs stream plays cleanly (Safari + Chrome)
- [ ] Mic + Silero VAD captures speech
- [ ] Avatar renders, lipsync works
- [ ] WhatsApp bridge connects; tasks detected + pushed
- [ ] Finance: import PDF extract, pending review, confirm/reject
- [ ] Calendar: list events, create, filter by source (agenda/financas/tarefas)
- [ ] Kanban: drag-and-drop, create task, password modal on finance_import
- [ ] Memory: facts CRUD, timeline, profile
- [ ] Push: subscription survives restart (IDB), /push/test delivers
- [ ] Google OAuth reconnect flow: POST + GET redirect both work
- [ ] Service Worker: PWA install, offline queue, VRM IndexedDB cache
- [ ] All existing tests pass: `uv run pytest -q` (backend) and `vitest` + `playwright`

---

## 7. Rollback strategy

At any phase, if regression appears:
1. `git revert <bad commit>` restores previous state
2. Or: `git reset --hard <phase N-1 commit>` if we haven't pushed
3. Branch stays isolated from `main` until Phase 15 — zero impact on prod

Every module extraction is designed to be reversible: the module is imported by Seraphine. Revert = undo the move, put code back inline.

---

## 8. Open questions to confirm before starting

1. **Single repo vs split**: monorepo with all apps, or split into multiple repos with shared libs published to GitHub? → Recommend: monorepo for now, split only if collaboration demands it.
2. **Package manager**: `uv` for Python (workspaces), `pnpm` for JS (workspaces). Any objection?
3. **DB target for Aura**: start with SQLite (user_id-scoped) or jump to Postgres? → Recommend: SQLite for first 10 users, then pg-migrate script when needed.
4. **LLM provider for Aura**: Anthropic direct (same code via llm-adapters) or OpenAI? → Probably Anthropic direct (same provider, new API key).
5. **Frontend framework for Aura**: same Vite+React, or try something lighter (SvelteKit, Remix)? → Recommend: same stack, lower learning overhead.
6. **Tauri desktop timing**: before or after the refactor? → **After**. Let Seraphine stabilize post-refactor first.

---

## 9. First action (upon approval)

Phase 0 smoke-test:
- Confirm current Seraphine boots without error
- Record current `git log --oneline -1` as the baseline
- Then: Phase 1 — workspace skeleton
