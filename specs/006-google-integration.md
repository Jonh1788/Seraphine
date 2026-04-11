# 006 — Google Workspace Integration (Calendar + Gmail)

## Context

Seraphine needs read/write access to the user's Google Calendar and Gmail
so she can:

- Answer "qual minha próxima reunião?" / "tenho algo amanhã?"
- Create events: "marca um café com João sexta às 14h"
- Move/cancel events: "remarca a reunião das 15h pra amanhã"
- Read recent emails: "tem algum email novo importante?"
- Triage emails: "esquece os promocionais e me mostra só o que precisa
  de resposta"
- Send emails on demand: "manda um email pro Pedro confirmando o horário"
- Search across both: "achei algum evento com o Pedro essa semana"

The integration is **per-user, local-only OAuth**. Seraphine is a
single-user assistant — credentials live on the local Mac, never leave
the machine, and the OAuth flow happens once on first use.

This is the **first external SaaS integration** with state mutation
(can send emails, create events). The approval gate becomes critical:
**every write operation requires human approval**, every read is
opt-in via `allowed_scopes` config.

## Goals

1. Read Google Calendar (events in next N days, by date range, by query)
2. Create / update / delete Calendar events
3. Read Gmail (unread, by query, by label, full thread)
4. Send Gmail (with optional reply-to threading)
5. OAuth handled locally with refresh-token persistence
6. Approval gate for ALL writes (create event, send email, delete)
7. Audit log of every Google API call (in `tool_audit` table)

## Non-Goals (deferred)

- Other Google services (Drive, Docs, Tasks) — separate spec
- Multi-account support (only the primary signed-in account)
- Calendar invites with external attendees (still works, just no UI flow)
- Server-side push notifications (poll on demand, not subscribed)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ConversationEngine                                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Tools registry (existing)                           │    │
│  │  + GoogleCalendarListTool       (read,  no gate)    │    │
│  │  + GoogleCalendarCreateTool     (write, gated)      │    │
│  │  + GoogleCalendarUpdateTool     (write, gated)      │    │
│  │  + GoogleCalendarDeleteTool     (write, gated)      │    │
│  │  + GmailListTool                (read,  no gate)    │    │
│  │  + GmailReadTool                (read,  no gate)    │    │
│  │  + GmailSendTool                (write, gated)      │    │
│  │  + GoogleAuthStatusTool         (read,  no gate)    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────┬───────────────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────────────┐
│  GoogleClient (new module: backend/seraphine/google/)       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ OAuthFlow    │  │ TokenStore   │  │ ApiClient        │   │
│  │ (one-shot)   │  │ (sqlite/json)│  │ (httpx wrapper)  │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────┬───────────────────────────────────────────────────┘
          │ HTTPS
┌─────────▼───────────────────────────────────────────────────┐
│  Google APIs                                                 │
│  - calendar/v3                                              │
│  - gmail/v1                                                 │
│  - oauth2/v2 (token refresh)                                │
└─────────────────────────────────────────────────────────────┘
```

## Authentication Flow

**One-time setup** (the user does this once):

1. User runs `./scripts/google-auth.sh` (new script)
2. Script calls a new endpoint `POST /google/oauth/start` on the backend
3. Backend opens a local browser to Google's consent screen with the
   requested scopes via `webbrowser.open()`
4. User signs in, approves the requested scopes (Calendar + Gmail)
5. Google redirects to `http://localhost:8765/callback` (local one-shot
   HTTP server bound only during the flow, killed after success)
6. Backend exchanges the auth code for `access_token` + `refresh_token`
7. Tokens stored encrypted at rest in `~/.seraphine/google_tokens.json`
   (via `cryptography.fernet` with key derived from a fixed salt + the
   user's macOS hostname for trivial obfuscation; not Fort Knox but
   keeps random scripts from grepping it)

**On every subsequent call**:

- `GoogleClient` checks if `access_token` is within ~5min of expiry
- If yes, refreshes via `refresh_token` (cached in TokenStore)
- All API calls go through `_authed_request()` which retries once on 401
  by forcing a refresh

**Scopes requested** (minimum viable):

- `https://www.googleapis.com/auth/calendar.readonly` — list events
- `https://www.googleapis.com/auth/calendar.events` — create/update/delete
- `https://www.googleapis.com/auth/gmail.readonly` — list/read emails
- `https://www.googleapis.com/auth/gmail.send` — send emails

User can opt-out of Gmail entirely by removing the gmail scopes via
`SERAPHINE_GOOGLE_SCOPES` env var.

## Contracts

### `GoogleClient` (new)

```python
# backend/seraphine/google/client.py

class GoogleClient:
    """Async client for Google Workspace APIs (Calendar + Gmail).

    Wraps httpx with automatic OAuth token refresh and a single
    retry-on-401 path. Tokens are loaded from TokenStore on first
    use and persisted there after each refresh."""

    def __init__(
        self,
        token_store: TokenStore,
        client_id: str,
        client_secret: str,
        scopes: list[str],
    ) -> None: ...

    async def is_authed(self) -> bool: ...
    async def start_oauth_flow(self) -> str:  # returns local consent URL
    async def complete_oauth_flow(self, code: str) -> None: ...

    # --- Calendar ---
    async def list_events(
        self, *,
        time_min: datetime | None = None,
        time_max: datetime | None = None,
        q: str | None = None,
        max_results: int = 20,
    ) -> list[dict]: ...

    async def create_event(
        self, *,
        summary: str,
        start: datetime,
        end: datetime,
        description: str | None = None,
        location: str | None = None,
        attendees: list[str] | None = None,
    ) -> dict: ...

    async def update_event(self, event_id: str, **fields) -> dict: ...
    async def delete_event(self, event_id: str) -> None: ...

    # --- Gmail ---
    async def list_messages(
        self, *,
        q: str | None = None,         # gmail search syntax
        label_ids: list[str] | None = None,
        max_results: int = 20,
    ) -> list[dict]: ...

    async def get_message(self, message_id: str) -> dict: ...

    async def send_message(
        self, *,
        to: list[str],
        subject: str,
        body: str,
        cc: list[str] | None = None,
        in_reply_to: str | None = None,  # message_id for threading
    ) -> dict: ...
```

### `TokenStore` (new)

```python
# backend/seraphine/google/token_store.py

class TokenStore:
    """Persist OAuth tokens encrypted at rest under ~/.seraphine/.

    Uses cryptography.fernet with a key derived from a fixed app salt
    + the macOS hostname. This is light obfuscation, not real security —
    the threat model is "another script on the same Mac shouldn't
    casually grep tokens", not "nation-state attacker"."""

    async def load(self) -> TokenBundle | None: ...
    async def save(self, bundle: TokenBundle) -> None: ...
    async def clear(self) -> None: ...

class TokenBundle(BaseModel):
    access_token: str
    refresh_token: str
    expires_at: datetime
    scopes: list[str]
```

### Tools (8 new)

All extend the existing `Tool` base from `seraphine/tools/base.py`:

| Tool | requires_confirmation | What it does |
|------|----------------------|--------------|
| `google_auth_status` | false | Returns `{authed: bool, scopes: [...], expires_at: ...}` |
| `calendar_list_events` | false | List events in a range, optional query filter |
| `calendar_create_event` | **true** | Create event — approval shows summary, time, attendees |
| `calendar_update_event` | **true** | Patch event — approval shows old vs new diff |
| `calendar_delete_event` | **true** | Delete event — approval shows full event before delete |
| `gmail_list_messages` | false | List recent messages with optional Gmail search syntax |
| `gmail_read_message` | false | Read full thread (subject, from, body, attachments meta) |
| `gmail_send_message` | **true** | Send email — approval shows full draft (to, subject, body) |

The 4 write operations route through the existing approval gate
(`tool_request` WS message → ApprovalPanel → user clicks Approve/Reject).

### REST endpoints (new router)

```
POST /google/oauth/start   → returns {consent_url, state}
GET  /google/oauth/status  → {authed, scopes, email}
POST /google/oauth/logout  → clears TokenStore
```

The `/callback` is handled by a one-shot local HTTP server bound on
`localhost:8765` only during the OAuth flow, then torn down.

### Config (additions to `config.py`)

```python
google_client_id: str = ""
google_client_secret: str = ""
google_scopes: list[str] = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]
google_token_path: Path = Path.home() / ".seraphine" / "google_tokens.enc"
```

The user provides their own OAuth client ID/secret via the `.env`
(create a free OAuth client in https://console.cloud.google.com/).
We don't ship one — too risky to embed credentials in a public repo.

### Frontend changes

**ApprovalPanel.tsx** — already exists, no changes needed for the
write tools (they use the standard `tool_request` flow).

**New: `frontend/src/google/`** module with:

1. **GoogleAuthPanel.tsx** (sidebar — replaces the placeholder above MemoryPanel)
   - Shows "Conectar Google" button if not authed
   - Shows avatar + email + "Desconectar" if authed
   - Calls `POST /google/oauth/start` → opens consent in new tab
   - Polls `GET /google/oauth/status` until authed
   - Triggers a global "google_authed" event so other panels refresh

2. **CalendarPanel.tsx** (full-screen modal opened from sidebar button)
   - Month grid view with day cells (matches existing dark theme)
   - Each day shows up to 3 event chips, "+N more" if overflow
   - Click on a day → opens DayDetailModal
   - Today highlighted with accent color
   - Navigation: prev/next month, "hoje" button
   - Loads events via `GET /google/calendar/events?from=...&to=...`
   - Caches events for 5 min in component state

3. **DayDetailModal.tsx** (opens when clicking a day cell)
   - Shows all events of that day in a vertical list
   - Each event has: title, time, location, attendees, body
   - **Per-event actions**:
     - "Cancelar" button → opens chat with prefilled "Cancela o evento <title>" → standard approval flow via `calendar_delete_event`
     - "Editar" button → opens chat with "Edita o evento <title>: <user types changes>"
   - **"Novo evento" button at top** → opens chat with prefilled "Cria um evento no dia <date>: <user types details>"
   - All actions go through Seraphine — she calls the appropriate tool, and the user approves via the existing ApprovalPanel
   - Modal closes automatically after a tool execution succeeds (listens for `tool_result` with `ok=true` from calendar tools)

4. **EmailInboxPanel.tsx** (full-screen modal opened from sidebar button)
   - List of "important unread" emails (Gmail's Important label + unread filter)
   - Each row: avatar (first letter of sender), sender, subject, snippet, date
   - Click row → expands to show full body inline
   - **Per-email actions**:
     - "Responder" → opens chat with prefilled "Responde ao email <subject>: <user types reply>"
     - "Marcar como lido" → calls a new lightweight `gmail_mark_read` tool (read-only on the read state, no approval gate since it's not a write to user data per se)
     - "Arquivar" → `gmail_archive` tool (gated)
   - Auto-refresh on `google_authed` event and every 5 min while open
   - Empty state: "Sem emails importantes no momento"

5. **Sidebar additions**:
   - New buttons in the sidebar: 📅 Calendário, ✉️ Inbox, ⚙️ Conectar Google
   - Buttons are disabled (grey) if not authed
   - Badge on Inbox showing unread count
   - Buttons open the respective full-screen modals

**Styles**: extend `frontend/src/styles.css` with:
- `.calendar-modal` / `.calendar-grid` / `.calendar-day` / `.calendar-event-chip`
- `.day-detail-modal` / `.day-event-card` / `.day-event-actions`
- `.email-inbox` / `.email-row` / `.email-row--unread` / `.email-body-expanded`
- `.google-auth-panel` / `.google-avatar`

All matching the existing dark-theme palette (`--bg-1`/`--bg-2`/`--accent`).

### Frontend ↔ Backend (new REST endpoints)

```
GET  /google/calendar/events?from=2026-04-11&to=2026-05-11
     → [{id, summary, start, end, location, attendees, htmlLink}, ...]

GET  /google/gmail/important?limit=20
     → [{id, threadId, from, subject, snippet, date, isUnread}, ...]

GET  /google/gmail/messages/{id}
     → {id, from, to, subject, body, date, attachments: [...]}
```

These endpoints proxy through `GoogleClient` so the frontend doesn't
need its own OAuth — all auth state lives in the backend.

## Security

- **All write operations gated** by the existing approval flow
- **OAuth tokens encrypted at rest** (Fernet, hostname-derived key)
- **Tool audit log** stores: tool name, args (with email body REDACTED
  in the audit summary — full body only in the live request, not
  persisted), approval status, success/error, timestamp
- **Scope minimization** — request only what's needed; user can disable
  Gmail scopes entirely via env var
- **No background polling** — Seraphine only hits Google APIs in
  response to user requests
- **No data forwarded** — emails/events stay between Google ↔ Seraphine
  ↔ user. Never sent to the LLM unless the user asks (and even then,
  only the relevant subset).

## Memory integration

Calendar events and email summaries do NOT auto-feed the long-term
memory (ChromaDB / facts). The user can teach: "lembre que tenho
reunião semanal com o time toda terça às 10h" → Seraphine writes a
fact via `learn_fact`, but events fetched via the API don't get
auto-embedded (privacy + cache invalidation issues).

## Implementation phases

### Phase A — OAuth + read-only (1-2 days)
1. `google/token_store.py` (Fernet + JSON)
2. `google/oauth.py` (one-shot local HTTP callback server)
3. `google/client.py` skeleton with `is_authed()`, `list_events()`, `list_messages()`
4. `google/routes.py` REST router for `/google/oauth/*`
5. Tools: `google_auth_status`, `calendar_list_events`, `gmail_list_messages`, `gmail_read_message`
6. Frontend: `GoogleAuthPanel.tsx`
7. Setup: `scripts/google-auth.sh` + README on creating OAuth client
8. **Acceptance**: user runs auth flow, asks "qual minha próxima
   reunião?", Seraphine answers correctly. Asks "tenho email novo?",
   Seraphine lists unread.

### Phase B — Writes with approval gate (1 day)
1. `client.py`: `create_event`, `update_event`, `delete_event`, `send_message`
2. Tools: `calendar_create_event`, `calendar_update_event`,
   `calendar_delete_event`, `gmail_send_message`
3. Audit log integration (redact email body in summary)
4. **Acceptance**: user says "marca café com João amanhã às 14h",
   approval panel shows draft, user approves, event appears in
   Google Calendar. Same for sending an email.

### Phase C — Polish (0.5 day)
1. Better Gmail body extraction (multipart, attachments meta)
2. Calendar invites with attendees
3. Reply-to threading for `send_message`
4. Cache last 50 events / 20 messages in memory (15 min TTL) so
   common reads don't always hit Google
5. **Acceptance**: full happy path E2E test.

## Verification

After Phase A:
```bash
# Setup
./scripts/google-auth.sh
# Browser opens, user approves
# Console: "Auth OK. Email: jonh@gmail.com"

# Test
curl -X POST http://localhost:8000/ws/conversation \
  ... user_message: "qual minha próxima reunião?"
# Seraphine calls calendar_list_events tool, returns answer.
```

After Phase B:
```bash
# In the chat
"marca café com Pedro amanhã às 15h por 30 minutos"
# → ApprovalPanel shows: "Criar evento 'Café com Pedro' em 12/04 15:00-15:30"
# → User clicks Aprovar
# → Event appears in Google Calendar
# → Seraphine confirms via voice
```

## Risks

| Risk | Mitigation |
|---|---|
| OAuth client setup is friction for the user | Provide step-by-step in README, minimize required scopes |
| Tokens leaked from disk | Fernet encryption + hostname salt; document the threat model honestly |
| Approval fatigue (every write needs a click) | Optional `auto_approve_calendar_create=true` env var for trusted setups; emails ALWAYS gated |
| Gmail body parsing breaks on weird MIME | Use `email.message_from_bytes` from stdlib; fall back to "couldn't parse, here's the raw text" |
| Rate limits (Google's ~250 q/user/sec) | Cache reads with 15 min TTL; back off on 429 |
| User cancels approval mid-conversation | Same as existing tool flow — Seraphine sees `rejected: true` and adapts |

## Open questions

1. **OAuth client distribution**: ship a "demo" client with low quota,
   or require user to create their own? **Current plan: require own.**
   Friction but no shared quota or trust issues.
2. **Audit log of email bodies**: redact in the SQLite audit, or keep
   full? **Current plan: redact subject + first 100 chars of body in
   the audit; live request has full body.**
3. **Voice confirmation for sends**: should "envia o email pra Pedro"
   require both visual approval AND voice confirmation? **Current
   plan: visual only — same as other write tools.** Voice confirm is
   a separate spec.
