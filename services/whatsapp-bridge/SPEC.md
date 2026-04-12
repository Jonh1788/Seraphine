# WhatsApp Bridge — Build Spec

Self-contained spec for an AI agent to implement the entire bridge
from scratch. See also `specs/008-whatsapp-integration.md` for the
broader Seraphine-side integration context.

## What to build

A standalone Node.js HTTP service that connects to WhatsApp via
`whatsapp-web.js`, exposes a REST API for reading/sending messages,
and pushes incoming messages to the Seraphine backend via webhook.

## Stack

- **Runtime:** Node.js 20+ (already installed on the Mac)
- **Language:** TypeScript (strict mode)
- **WhatsApp lib:** `whatsapp-web.js` ^1.26 (npm)
- **HTTP:** Express 4 (simple, well-known)
- **Auth:** `LocalAuth` strategy from whatsapp-web.js (persists session
  to `.wwebjs_auth/` on disk — survives restart without re-scan)
- **Build:** `tsc` (no bundler needed for a backend service)
- **Package manager:** `npm` (simpler than pnpm for a standalone service)

## Directory structure

```
services/whatsapp-bridge/
├── package.json
├── tsconfig.json
├── .gitignore           # node_modules, dist, .wwebjs_auth, .wwebjs_cache
├── src/
│   ├── index.ts         # Express app, boot WhatsApp client, start server
│   ├── client.ts        # WhatsApp client singleton, event wiring, QR state
│   ├── config.ts        # env-var config (PORT, WEBHOOK_URL, etc.)
│   ├── routes/
│   │   ├── status.ts    # GET /api/status
│   │   ├── qr.ts        # GET /api/qr
│   │   ├── chats.ts     # GET /api/chats
│   │   ├── messages.ts  # GET /api/messages/:chatId
│   │   ├── send.ts      # POST /api/send
│   │   ├── search.ts    # GET /api/search?query=...
│   │   └── contacts.ts  # GET /api/contacts
│   └── webhook.ts       # fire-and-forget POST to Seraphine on new message
└── .wwebjs_auth/        # gitignored — session persistence dir
```

## Config (env vars)

```
PORT=3001                                          # HTTP listen port
WEBHOOK_URL=http://localhost:8000/webhook/whatsapp  # Seraphine backend
LOG_LEVEL=info                                     # debug | info | warn | error
```

Read via `process.env` with sensible defaults. No `.env` loader needed
(the service is started manually or via a script that can export vars).

## Endpoints

Implement ALL of the following exactly as specified. Every endpoint
returns `application/json`. Errors return `{ "error": "message" }` with
the appropriate HTTP status code.

### GET /api/status

```json
{
  "status": "ready",
  "phone": "5573999887766",
  "name": "Jonathan",
  "uptime_s": 3600
}
```

`status` is one of: `"disconnected"`, `"qr_pending"`, `"authenticating"`,
`"ready"`. `phone` and `name` are null when not authenticated.

### GET /api/qr

```json
{
  "qr": "data:image/png;base64,iVBOR...",
  "expires_in_s": 20
}
```

Only available when `status == "qr_pending"`. If already authenticated:
`{ "qr": null, "message": "already authenticated" }` with status 200.

Use the `qrcode` npm package to convert the raw QR string from
whatsapp-web.js's `qr` event into a PNG data URL.

### GET /api/chats?limit=20&unreadOnly=false

Return recent chats sorted by last message timestamp (newest first).

```json
{
  "chats": [
    {
      "id": "5573999887766@c.us",
      "name": "Rodrigo Silva",
      "isGroup": false,
      "unreadCount": 3,
      "lastMessage": {
        "body": "E aí, bora amanhã?",
        "timestamp": 1744400000,
        "fromMe": false
      }
    }
  ]
}
```

For groups, include `"author"` in `lastMessage` (the sender's pushname).

### GET /api/messages/:chatId?limit=30&before=

`:chatId` is the full WhatsApp chat ID (e.g. `5573999887766@c.us` for
individuals, `120363012345@g.us` for groups).

```json
{
  "chatId": "5573999887766@c.us",
  "chatName": "Rodrigo Silva",
  "messages": [
    {
      "id": "true_5573999887766@c.us_ABCDEF",
      "body": "E aí, bora amanhã?",
      "timestamp": 1744400000,
      "fromMe": false,
      "author": "Rodrigo Silva",
      "type": "chat",
      "hasMedia": false,
      "quotedMsg": null
    }
  ]
}
```

`type` is one of: `"chat"`, `"image"`, `"video"`, `"audio"`, `"document"`,
`"sticker"`, `"location"`, `"vcard"`.

If `hasMedia == true`, `body` contains the caption (may be empty).
Do NOT download or return media binary — just metadata.

`quotedMsg` is `{ "body": "...", "author": "..." }` when the message
is a reply, else `null`.

`before` is a Unix timestamp (seconds) for backward pagination. Return
messages with `timestamp < before`, still sorted newest-first.

### POST /api/send

```json
// Request
{
  "chatId": "5573999887766@c.us",
  "message": "Vou chegar atrasado 15 min!",
  "quoteMsgId": null
}

// Response 200
{
  "ok": true,
  "messageId": "true_5573999887766@c.us_GHIJKL",
  "timestamp": 1744400120
}
```

`quoteMsgId` is optional — if set, the message is sent as a reply to
that message ID (WhatsApp renders it as a quoted reply bubble).

Validate: `chatId` and `message` are required strings. Return 400 if
missing. Return 401 if not authenticated. Return 500 on send failure.

### GET /api/search?query=reunião&chatId=&limit=20

Search message history by text content.

```json
{
  "results": [
    {
      "chatId": "120363012345@g.us",
      "chatName": "Grupo Trabalho",
      "message": {
        "id": "...",
        "body": "Reunião confirmada pra sexta às 14h",
        "timestamp": 1744390000,
        "author": "Juliana",
        "fromMe": false
      }
    }
  ]
}
```

`query` is required. `chatId` is optional (restrict to one chat).
`limit` defaults to 20, max 50.

Use whatsapp-web.js's `client.searchMessages(query, options)` if
available, or iterate loaded chats and filter in JS.

### GET /api/contacts?query=rodrigo

```json
{
  "contacts": [
    {
      "id": "5573999887766@c.us",
      "name": "Rodrigo Silva",
      "pushname": "Rod",
      "isMyContact": true,
      "isGroup": false
    }
  ]
}
```

`query` is optional — if set, filter by name/pushname (case-insensitive
substring match).

## Webhook

When a new message arrives (`client.on('message_create', msg)` with
`msg.fromMe === false`), POST to `WEBHOOK_URL`:

```json
{
  "event": "message",
  "chatId": "5573999887766@c.us",
  "chatName": "Rodrigo Silva",
  "message": {
    "id": "...",
    "body": "Eai mano, confirma aí",
    "timestamp": 1744401000,
    "fromMe": false,
    "author": "Rodrigo Silva",
    "type": "chat",
    "hasMedia": false
  }
}
```

Fire-and-forget (don't block on response, don't retry). Log errors
at warn level. If `WEBHOOK_URL` is empty, skip entirely.

## client.ts design

```typescript
import { Client, LocalAuth } from 'whatsapp-web.js';

type BridgeStatus = 'disconnected' | 'qr_pending' | 'authenticating' | 'ready';

let status: BridgeStatus = 'disconnected';
let currentQr: string | null = null;
let qrTimestamp: number = 0;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  status = 'qr_pending';
  currentQr = qr;
  qrTimestamp = Date.now();
  console.log('[whatsapp-bridge] QR received — scan via GET /api/qr');
});

client.on('authenticated', () => {
  status = 'authenticating';
  currentQr = null;
  console.log('[whatsapp-bridge] authenticated, loading session...');
});

client.on('ready', () => {
  status = 'ready';
  currentQr = null;
  const info = client.info;
  console.log(`[whatsapp-bridge] ✓ ready as ${info.pushname} (${info.wid.user})`);
});

client.on('disconnected', (reason) => {
  status = 'disconnected';
  console.log('[whatsapp-bridge] disconnected:', reason);
});

// New incoming message → webhook
client.on('message_create', async (msg) => {
  if (msg.fromMe) return; // only incoming
  // fire webhook (see webhook.ts)
});

export { client, status, currentQr, qrTimestamp };
export type { BridgeStatus };
```

## QR code rendering

Use the `qrcode` npm package (`npm install qrcode`) to convert the raw
QR string from the `qr` event into a PNG data URL:

```typescript
import QRCode from 'qrcode';

export async function qrToDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, { width: 256, margin: 2 });
}
```

The `/api/qr` endpoint calls this and returns the data URL.

## Startup sequence

```
[whatsapp-bridge] starting on :3001
[whatsapp-bridge] initializing WhatsApp client...
[whatsapp-bridge] loading session from .wwebjs_auth/...
   (if session exists):
[whatsapp-bridge] session found — authenticating...
[whatsapp-bridge] ✓ ready as Jonathan (5573999887766)
   (if no session):
[whatsapp-bridge] no saved session — waiting for QR scan
[whatsapp-bridge] QR available at GET /api/qr
[whatsapp-bridge] listening on http://0.0.0.0:3001
```

## Error handling

- All route handlers wrapped in try/catch → 500 with `{ "error": "..." }`
- If `status !== "ready"` on any endpoint except `/api/status` and
  `/api/qr`: return `401 { "error": "not authenticated" }`
- Log all errors at error level with stack trace

## Testing

After implementation, verify:

1. `npm run build` compiles without errors
2. `npm start` boots and prints "listening on :3001"
3. `GET /api/status` returns `"qr_pending"` (first boot, no session)
4. `GET /api/qr` returns a valid PNG data URL
5. After scanning QR with phone: `GET /api/status` returns `"ready"`
6. `GET /api/chats?limit=5` returns recent chats with correct shape
7. `GET /api/messages/<chatId>?limit=5` returns messages
8. `POST /api/send` with a test message (to yourself) works
9. `GET /api/search?query=<known word>` returns results
10. Kill and restart: session persists, no re-scan needed
11. Incoming message fires webhook POST to configured URL

## package.json scripts

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts"
  }
}
```

## Constraints

- Do NOT use any database. All state is in-memory + whatsapp-web.js
  session on disk.
- Do NOT implement authentication on the HTTP endpoints (trusted LAN).
- Do NOT download or cache media files.
- Do NOT auto-reply to any message. The bridge is read/write on command,
  not a bot.
- Keep dependencies minimal: whatsapp-web.js, express, qrcode, and
  their transitive deps. No ORM, no Redis, no database.
