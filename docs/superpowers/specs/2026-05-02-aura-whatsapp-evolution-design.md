# Spec — WhatsApp Integration for Aura via Evolution API

**Date:** 2026-05-02
**Status:** Approved (design phase)
**Owner:** Aura backend + frontend
**Implementation default model:** `opus` (claude-opus-4-7) for every spawned agent.

---

## 1. Context

Aura today notifies users via Web Push (browser/PWA notifications) for
reminders, and accepts conversational input only via the web chat at
`https://app.minha-aura.com`. There's no surface to talk to Aura outside
the browser, and push notifications are easy to miss on iOS in
particular.

The user owns a single dedicated WhatsApp number (Aura's own number) and
wants to give a small group (5–6 people max) the ability to:

1. Receive reminders/notifications on WhatsApp.
2. Talk to Aura via WhatsApp the same way they talk to her on the web.

Seraphine already uses `whatsapp-web.js` via a `whatsapp-bridge`
container, but that's single-user. Aura is multi-tenant and needs a
backend that can route a given inbound message to the right user.
Evolution API (open-source REST wrapper, also Baileys-based, but
multi-instance and webhook-driven) is the right fit.

## 2. Goals

- Aura sends reminders/lembretes to a verified user via WhatsApp instead
  of (or in addition to) Web Push, with WA-first / push-fallback
  semantics.
- Users can reply to Aura on WhatsApp and trigger the full agentic chat
  loop (same tools as the web chat: `create_task`, `register_transaction`,
  etc.).
- Each Aura user vincula seu telefone uma vez (verificação por código),
  pra Aura saber a quem responder.
- A history flow: each user has one persistent `Conversation` of channel
  `whatsapp`, separate from the web chat conversations.

## 3. Non-goals (v1)

- Inbound media (audio, image). Out of scope; respond with friendly
  "v1 só processa texto" notice. Whisper transcription stays for v2.
- WhatsApp interactive buttons / list messages.
- Multi-conversation per user inside the WhatsApp channel.
- Per-user WhatsApp numbers (each user with their own WA number plugged
  to Aura). Architecture supports it but UX/Evolution config out of
  scope.
- Group chats inbound. Aura ignores group messages even from verified
  users.
- Bridging existing web conversations into WhatsApp.

## 4. Topology

```
                                ┌──────────────────────┐
   ┌────────┐  WA protocol      │ Evolution API        │
   │ User's │ ◄─────────────────┤  (single instance,   │
   │ WhatsApp│                  │   Aura's number)     │
   └────────┘    HTTP + webhook │                      │
                                └─────┬────────────────┘
                                      │
                  internal docker net │
                                      ▼
                         ┌─────────────────────────┐
                         │ aura-backend            │
                         │  /whatsapp/webhook      │
                         │  /whatsapp/send (int.)  │
                         │  /whatsapp/connect/...  │
                         │  /whatsapp/admin/qr     │
                         └─────────────────────────┘
```

- **One Evolution instance** in `apps/aura/docker-compose.yml`, internal
  network only, scoped to Aura's number.
- **Redis sidecar** for Evolution state.
- Backend exposes a single inbound webhook + a small REST surface for
  the user-facing flows.
- No public exposure of Evolution; all reachability via aura-backend.

## 5. Data Model

Two new SQLite tables, owned by Aura.

```sql
-- Verified phone vinculado a um user (1:1).
CREATE TABLE aura_user_whatsapp (
  user_id     TEXT PRIMARY KEY,
  phone_e164  TEXT NOT NULL UNIQUE,    -- always normalized E.164 (+5511...)
  verified_at TEXT NOT NULL,           -- ISO timestamp
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Pending verification codes; row dropped on success/expiry/3 fails.
CREATE TABLE aura_whatsapp_verification (
  user_id     TEXT PRIMARY KEY,
  phone_e164  TEXT NOT NULL,
  code        TEXT NOT NULL,           -- 6 digits
  expires_at  TEXT NOT NULL,           -- ISO; 5 min from issue
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
```

Reuse existing `aura_chat_conversations` and `aura_chat_messages`. The
WhatsApp conversation is identified by storing `metadata = {"channel":
"whatsapp"}` on the row at creation time. The message log piggybacks on
`aura_chat_messages` — one less table, one source of truth for chat
history per user.

The "find or create user's WhatsApp conversation" lookup uses
`SELECT id FROM aura_chat_conversations WHERE user_id = ? AND
json_extract(metadata, '$.channel') = 'whatsapp' LIMIT 1`; on miss,
insert a fresh conversation with the channel metadata and return its
id. Wrapped in a single helper inside `WhatsAppService` so callers
never duplicate the pattern.

## 6. Backend Modules

```
apps/aura/backend/aura/whatsapp/
  __init__.py
  client.py        # EvolutionClient — httpx wrapper
  schema.py        # CREATE TABLE migrations (registered in main.py)
  service.py       # WhatsAppService — verification + routing + send
  routes.py        # FastAPI router (webhook + connect/verify + admin)
  config.py        # Pydantic settings extension (read AURA_EVOLUTION_*)
```

### 6.1 EvolutionClient (`whatsapp/client.py`)

Stateless httpx wrapper. One instance held on `app.state.whatsapp_client`.

```python
class EvolutionClient:
    def __init__(self, base_url: str, api_key: str, instance: str): ...
    async def send_text(self, phone_e164: str, text: str) -> str:  # returns evolution msg id
    async def get_qr(self) -> str | None:        # base64 PNG or None if connected
    async def get_status(self) -> dict:          # {connected: bool, phone: str | None}
    async def aclose(self) -> None: ...
```

Talks to Evolution endpoints (`/message/sendText/{instance}`,
`/instance/connectionState/{instance}`, `/instance/qrcode/{instance}`).
All requests carry the `apikey` header. 4xx/5xx mapped to a clean
exception (`EvolutionError(status, body, reason)`); the routing layer
decides whether to retry or fall back.

### 6.2 WhatsAppService (`whatsapp/service.py`)

Owns the business logic:

- `start_verification(user_id, phone_raw)` — normalize, generate 6-digit
  code, persist with TTL, send `"Aura: seu código de verificação é
  482910 (válido por 5 min)."` via Evolution. Throttled to 1 request /
  60s per user.
- `verify(user_id, code)` — atomic check (expires_at, attempts < 3),
  insert/update `aura_user_whatsapp`, drop verification row.
- `disconnect(user_id)` — drop the `aura_user_whatsapp` row; doesn't
  message the user.
- `get_status(user_id)` — `{verified: bool, phone_masked: str|None}`.
- `route_inbound(payload)` — Evolution → user_id mapping. If unknown
  phone, log + drop. If group chat, drop. Otherwise delegates to
  `process_user_message(user_id, text)`.
- `process_user_message(user_id, text)` — append to user's WA
  conversation, run `_run_agentic_collect()`, send the reply back.
  Enforces 30 msgs/hour per user (sliding window in memory + DB count).
- `send_reminder(user_id, title, due_time)` — used by the dispatcher to
  deliver a lembrete.

Phone normalization is strict E.164 (`^\+\d{10,15}$`). Brazilian numbers
get a 9 inserted on the cell prefix if missing (common UX failure
mode).

### 6.3 Refactor in `aura/chat/routes.py`

Extract the agentic loop body into a reusable, **non-streaming**
`_run_agentic_collect()` that returns
`(reply_text, transactions, tasks, recurring, chips)`. The existing SSE
endpoint becomes a thin wrapper that streams while the same loop runs.
WhatsApp side calls `_run_agentic_collect()` and sends `reply_text`
once via Evolution.

### 6.4 Outbound integration with PushService

`aura/push/service.py::dispatch_due_reminders` gets a tiny extension:

```python
async def _deliver_reminder(user_id, task):
    if await whatsapp_svc.is_verified(user_id):
        try:
            await whatsapp_svc.send_reminder(user_id, task.title, task.due_time)
            return True   # done — do NOT also push
        except EvolutionError:
            logger.warning("WA send failed; falling back to push")
    await self._dispatch_push(user_id, task)
```

Idempotency is preserved because `push_dispatches` is keyed by
`(task_id, dispatched_at_minute)` regardless of channel.

## 7. Routes

```
POST   /whatsapp/webhook                  (public, validates X-Evolution-Webhook-Token)
POST   /whatsapp/connect/start            body: {phone}
POST   /whatsapp/connect/verify           body: {code}
POST   /whatsapp/disconnect
GET    /whatsapp/status                   {verified, phone_masked}

GET    /whatsapp/admin/qr                 (gated by AURA_ADMIN_TOKEN header)
GET    /whatsapp/admin/status             (same gate)
```

The webhook receives Evolution's full payload, checks token first,
extracts phone + text via a small adapter, hands off to
`route_inbound()`. Two response codes matter:

- **401** when the `X-Evolution-Webhook-Token` header is missing or
  wrong — surfaces misconfiguration loudly and fails fast.
- **200 `{ok: true}`** for everything else, including unknown phones,
  group messages, dropped media, and *internal failures after the
  payload is accepted*. We don't want Evolution to retry the same
  message into our backend on transient LLM errors — incidents are
  surfaced via Aura logs, not via webhook back-pressure.

## 8. Frontend

### 8.1 New API client `frontend/src/api/whatsapp.ts`

```ts
getStatus(): Promise<{ verified: boolean; phone_masked: string | null }>
startConnect(phone: string): Promise<{ ok: true }>
verifyCode(code: string): Promise<{ ok: true }>
disconnect(): Promise<{ ok: true }>
```

### 8.2 PerfilPage card

A new "WhatsApp" connect card sits beside the Google Calendar one,
mirroring its visual language (icon + status pill + button). Two
states:

- **Disconnected** — primary button "Conectar". Opens a modal that
  walks the user through:
  1. Telefone (input com máscara `+55 11 9XXXX-XXXX`)
  2. Aguardando código… (countdown 5min, link "Reenviar")
  3. Cole o código (6 inputs estilo OTP)
  4. ✓ Sucesso, fecha
- **Connected** — verde com `+55 11 9••••-XX42` e botão Desconectar
  (usa nosso `ConfirmDialog` com `tone="danger"`).

## 9. Deploy & Config

### 9.1 docker-compose additions

```yaml
services:
  evolution:
    image: atendai/evolution-api:latest        # pin a specific tag in the file
    restart: unless-stopped
    hostname: aura-evolution                    # pin (mirrors the backend hostname fix)
    env_file:
      - path: .env.prod
        required: true
    environment:
      # SQLite + Redis: minimum viable prod stack at our scale (<10
      # users, single number). Avoids the operational weight of a
      # Postgres sidecar; Redis stays for hot connection state because
      # Evolution's docs flag SQLite-only as fragile under reconnects.
      DATABASE_PROVIDER: sqlite
      DATABASE_CONNECTION_URI: file:/evolution/instances/evolution.db
      CACHE_REDIS_ENABLED: "true"
      CACHE_REDIS_URI: redis://evolution-redis:6379/0
      WEBHOOK_GLOBAL_URL: http://backend:8001/whatsapp/webhook
      # Exact env-var name TBR against the pinned Evolution image tag
      # in the implementation plan; intent is a static auth header.
      WEBHOOK_GLOBAL_HEADER_AUTHORIZATION: ${AURA_EVOLUTION_WEBHOOK_TOKEN}
    volumes:
      - evolution-data:/evolution/instances
    networks: [aura-net]
    expose: ["8080"]

  evolution-redis:
    image: redis:7-alpine
    restart: unless-stopped
    hostname: aura-evolution-redis
    volumes: [evolution-redis-data:/data]
    networks: [aura-net]
    expose: ["6379"]

volumes:
  evolution-data:
  evolution-redis-data:
```

(Final image tag pinned in implementation; see plan.)

### 9.2 New `.env.prod` keys

```
AURA_EVOLUTION_BASE_URL=http://evolution:8080
AURA_EVOLUTION_API_KEY=<generated 32-byte hex>
AURA_EVOLUTION_INSTANCE=aura-main
AURA_EVOLUTION_WEBHOOK_TOKEN=<generated 32-byte hex>
AURA_WHATSAPP_FROM_NUMBER=+5511XXXXXXXXX
AURA_ADMIN_TOKEN=<generated 32-byte hex>          # gates /whatsapp/admin/*
```

### 9.3 Boot sequence (one-time, manual)

1. `git push vps main` — Evolution + Redis + backend rebuild.
2. SSH na CassinoAPI, hit `GET /whatsapp/admin/qr` com header
   `X-Aura-Admin-Token`. Backend devolve PNG base64 do QR.
3. Scan no app WhatsApp do número Aura.
4. Status flip pra `connected: true`. Pronto.

QR re-scan needed only if the WhatsApp session is killed (rare;
months-long stability typical).

## 10. Limits & Safety

- **30 msgs/hour cap per user** — sliding window via in-memory
  counter (process-local; OK at this scale). Excess → log + silent
  drop. Prevents tool-call loops from spamming.
- **No outbound to non-verified numbers, ever.** All sends gate on
  `aura_user_whatsapp`.
- **Group messages dropped** even from verified users.
- **Webhook token** validated on every inbound; mismatches → 401 +
  log. No retry storm because Evolution sees 2xx anyway (we always
  return 200 from the route, even on internal failure, after logging).
- **Verification code:** 6 digits, 5min TTL, max 3 attempts, 60s
  cooldown between resends per user.

## 11. Failure Modes

| Failure                              | Behavior                                                  |
|--------------------------------------|-----------------------------------------------------------|
| Evolution down (timeout)             | Outbound: fall back to web push. Inbound: lost (Evolution buffers). |
| WA session expired                   | Outbound fails → push fallback. Admin sees status; re-QR. |
| User unbinds in WhatsApp (blocks)    | Send fails 4xx → log, push fallback. Cleanup manual.      |
| Webhook token mismatch               | 401, no processing.                                       |
| Unknown phone hits webhook           | Logged at INFO, dropped silently.                         |
| Group chat from verified user        | Dropped silently.                                         |
| LLM tool error during inbound        | Reply with friendly error message via WA.                 |
| Reminder dispatcher crashes mid-send | Idempotency key in `push_dispatches` prevents dup.        |

## 12. Testing Strategy

- **Unit (pytest):**
  - `EvolutionClient` with `httpx` mock — happy path + 4xx/5xx mapping.
  - `WhatsAppService.start_verification` — code format, TTL, throttle.
  - `WhatsAppService.verify` — wrong code, expired, exhausted attempts,
    happy path.
  - Phone normalization (E.164 + Brazil 9-prefix injection).
  - Inbound router — unknown phone, group msg, verified user happy path.
  - Outbound dispatcher — WA-first, push fallback on EvolutionError.

- **Integration (pytest, FastAPI TestClient):**
  - Full webhook flow with mocked EvolutionClient and mocked LLM.
  - Connect → verify → status round-trip.

- **Manual E2E (one-shot, post-deploy):**
  - Vincular um telefone real, mandar "oi" pra Aura, ver resposta.
  - Criar lembrete pra "agora + 1 min", confirmar entrega via WA.
  - Disconnect, retentar (deve falhar via WA, cair em push).

## 13. Rollout Plan (high level)

Detalhe nos planos do `/writing-plans`. Ordem geral:

1. Schema + EvolutionClient + WhatsAppService (sem rotas, 100% coberto
   por unit tests).
2. Routes (webhook + connect + admin) com fakes.
3. Frontend connect card no Perfil.
4. Refactor `_run_agentic_collect()` no chat.
5. Outbound integration no PushService.
6. docker-compose Evolution + Redis + env wiring.
7. Boot one-shot na CassinoAPI, smoke E2E.

Cada agente de implementação roda com `model: opus` (Opus 4.7) por
preferência durável do user.

## 14. Out-of-scope reminders (for v2 backlog)

- Inbound áudio (Whisper já está integrado, ~1 dia).
- Inbound imagem (vision já está integrado).
- WhatsApp interactive buttons pra "✅ feito" / "⏰ adiar".
- Multi-instância (caso Aura cresça e cada user queira seu próprio
  número).
- Bridging conversations entre web e WA.
