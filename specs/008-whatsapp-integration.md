# Spec 008 — WhatsApp Integration via whatsapp-web.js Bridge

## Contexto

A Seraphine hoje acessa Google Calendar, Gmail, MCP Supertasks, web search,
filesystem e shell — mas não toca no WhatsApp, que é onde 90% da comunicação
pessoal do usuário acontece. O objetivo é dar à Seraphine acesso de leitura
e envio (com approval gate) ao WhatsApp pessoal do usuário, para que ela
possa responder perguntas como *"quem me mandou mensagem?"*, *"o que a
Juliana falou?"*, ou executar comandos como *"manda pro Rodrigo que vou
chegar atrasado"*.

## Arquitetura

Dois componentes novos:

1. **whatsapp-bridge** — micro-service Node.js standalone que roda na mesma
   máquina do backend (Mac M4 Max). Usa `whatsapp-web.js` pra falar o
   protocolo do WhatsApp Web, expõe REST + webhook. Persistência de sessão
   em disco (não precisa re-escanear QR a cada boot). Porta **3001**.

2. **Seraphine tools** — 5 tools no backend Python que chamam o bridge
   via httpx e são expostas ao LLM. Envio de mensagem passa pelo
   approval gate (`requires_confirmation=True`).

```
┌──────────────────────────────────────────┐
│ Seraphine backend (Python :8000)         │
│  ├─ whatsapp_auth_status                 │
│  ├─ whatsapp_list_chats                  │
│  ├─ whatsapp_read_messages               │
│  ├─ whatsapp_send_message (approval)     │
│  ├─ whatsapp_search_messages             │
│  └─ POST/GET → http://localhost:3001/api │
└──────────────────┬───────────────────────┘
                   │ REST
┌──────────────────▼───────────────────────┐
│ whatsapp-bridge (Node.js :3001)          │
│  ├─ whatsapp-web.js Client               │
│  ├─ GET  /api/status                     │
│  ├─ GET  /api/qr                         │
│  ├─ GET  /api/chats                      │
│  ├─ GET  /api/messages/:chatId           │
│  ├─ POST /api/send                       │
│  ├─ GET  /api/search                     │
│  ├─ GET  /api/contacts                   │
│  └─ POST → webhook Seraphine (/webhook)  │
└──────────────────────────────────────────┘
         ↕ WhatsApp Web protocol (encrypted)
     [WhatsApp servers]
```

## Componente 1: whatsapp-bridge (Node.js)

### Stack

| Peça | Escolha | Porquê |
|---|---|---|
| Runtime | Node.js 20+ | whatsapp-web.js é nativo Node |
| WhatsApp lib | `whatsapp-web.js` (v1.26+) | Mais madura, 60k+ stars, ativamente mantida |
| HTTP server | Express ou Fastify | Leve, familiar, REST simples |
| Session store | `LocalAuth` strategy (whatsapp-web.js built-in) | Persiste sessão em `.wwebjs_auth/` — sobrevive restart sem re-scan |
| QR delivery | REST endpoint `/api/qr` retorna PNG base64 | Frontend renderiza no painel |

### Estrutura de arquivos

```
services/whatsapp-bridge/
├── package.json
├── src/
│   ├── index.ts           # Express app + WhatsApp client boot
│   ├── client.ts          # WhatsApp client singleton + events
│   ├── routes/
│   │   ├── status.ts      # GET /api/status
│   │   ├── qr.ts          # GET /api/qr
│   │   ├── chats.ts       # GET /api/chats
│   │   ├── messages.ts    # GET /api/messages/:chatId
│   │   ├── send.ts        # POST /api/send
│   │   ├── search.ts      # GET /api/search
│   │   └── contacts.ts    # GET /api/contacts
│   └── webhook.ts         # Outbound webhook to Seraphine
├── tsconfig.json
└── .wwebjs_auth/          # gitignored, session persistence
```

### API Contract

#### `GET /api/status`

Retorna estado da conexão com o WhatsApp.

```json
{
  "status": "ready",          // "disconnected" | "qr_pending" | "authenticating" | "ready"
  "phone": "5573999887766",   // null se não autenticado
  "name": "Jonathan",         // push name do perfil
  "uptime_s": 3600
}
```

#### `GET /api/qr`

Retorna QR code pra autenticação. Só disponível quando `status == "qr_pending"`.

```json
{
  "qr": "data:image/png;base64,iVBOR...",   // QR como data URL PNG
  "expires_in_s": 20                         // QR expira em ~20s, frontend deve poll
}
```

Se já autenticado: `{"qr": null, "message": "already authenticated"}`.

#### `GET /api/chats?limit=20&unreadOnly=false`

Lista conversas recentes ordenadas por última mensagem.

**Query params:**
- `limit` (int, default 20, max 50)
- `unreadOnly` (bool, default false) — se true, só chats com mensagens não lidas

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
      },
      "profilePicUrl": "https://..." // ou null
    },
    {
      "id": "120363012345@g.us",
      "name": "Grupo Trabalho",
      "isGroup": true,
      "unreadCount": 12,
      "lastMessage": {
        "body": "Reunião confirmada",
        "timestamp": 1744399000,
        "fromMe": false,
        "author": "Juliana"
      },
      "profilePicUrl": null
    }
  ]
}
```

#### `GET /api/messages/:chatId?limit=30&before=timestamp`

Lê mensagens de uma conversa específica.

**Path:** `:chatId` = ID do chat (ex: `5573999887766@c.us`)

**Query params:**
- `limit` (int, default 30, max 100)
- `before` (int timestamp, opcional — paginação pra trás)

```json
{
  "chatId": "5573999887766@c.us",
  "chatName": "Rodrigo Silva",
  "messages": [
    {
      "id": "msg_abc123",
      "body": "E aí, bora amanhã?",
      "timestamp": 1744400000,
      "fromMe": false,
      "author": "Rodrigo Silva",
      "type": "chat",           // "chat" | "image" | "video" | "audio" | "document" | "sticker"
      "hasMedia": false,
      "quotedMsg": null          // ou { body, author } se é resposta a outra msg
    },
    {
      "id": "msg_def456",
      "body": "Bora sim!",
      "timestamp": 1744400060,
      "fromMe": true,
      "author": "Jonathan",
      "type": "chat",
      "hasMedia": false,
      "quotedMsg": { "body": "E aí, bora amanhã?", "author": "Rodrigo" }
    }
  ]
}
```

**Nota sobre mídia:** se `hasMedia == true` e `type != "chat"`, o body contém
a caption (ou vazio). O conteúdo binário da mídia NÃO é retornado na listagem
(economiza bandwidth). Um endpoint futuro `/api/media/:msgId` pode servir o
download sob demanda.

#### `POST /api/send`

Envia uma mensagem de texto.

**Body:**
```json
{
  "chatId": "5573999887766@c.us",
  "message": "Vou chegar atrasado 15 min!",
  "quoteMsgId": null              // opcional: ID de mensagem pra responder em thread
}
```

**Response 200:**
```json
{
  "ok": true,
  "messageId": "msg_ghi789",
  "timestamp": 1744400120
}
```

**Erros:**
- `400` chatId ou message ausente
- `401` não autenticado
- `404` chatId não encontrado
- `500` falha de envio (rede, WhatsApp down, etc.)

#### `GET /api/search?query=reunião&chatId=&limit=20`

Busca em mensagens por texto.

**Query params:**
- `query` (string, obrigatório) — texto a buscar
- `chatId` (string, opcional) — restringir a um chat específico
- `limit` (int, default 20, max 50)

```json
{
  "results": [
    {
      "chatId": "120363012345@g.us",
      "chatName": "Grupo Trabalho",
      "message": {
        "id": "msg_xyz",
        "body": "Reunião confirmada pra sexta às 14h",
        "timestamp": 1744390000,
        "author": "Juliana",
        "fromMe": false
      }
    }
  ]
}
```

#### `GET /api/contacts?query=rodrigo`

Lista contatos. Filtro opcional por nome.

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

### Webhook (bridge → Seraphine)

Quando uma mensagem nova chega (e o bridge está `ready`), ele faz um POST
para o backend da Seraphine com o payload da mensagem:

```
POST http://localhost:8000/webhook/whatsapp
Content-Type: application/json

{
  "event": "message",
  "chatId": "5573999887766@c.us",
  "chatName": "Rodrigo Silva",
  "message": {
    "id": "msg_new001",
    "body": "Eai mano, confirma aí",
    "timestamp": 1744401000,
    "fromMe": false,
    "author": "Rodrigo Silva",
    "type": "chat"
  }
}
```

O backend da Seraphine decide se exibe como notificação proativa no chat
(similar às MCP notifications) e/ou faz TTS do preview. **Não responde
automaticamente** — o usuário precisa pedir "responde pro Rodrigo dizendo X"
pra Seraphine usar a tool `whatsapp_send_message`.

### Startup + Lifecycle

```
[whatsapp-bridge] starting on :3001
[whatsapp-bridge] loading session from .wwebjs_auth/...
[whatsapp-bridge] session found — authenticating...
[whatsapp-bridge] ✓ ready as Jonathan (5573999887766)
[whatsapp-bridge] webhook target: http://localhost:8000/webhook/whatsapp
```

Se a sessão não existe (primeiro boot):
```
[whatsapp-bridge] no session found — waiting for QR scan
[whatsapp-bridge] QR available at GET /api/qr
```

O frontend da Seraphine mostra o QR code numa modal (similar ao
GoogleAuthPanel) e faz polling a cada 3s. Quando o scan completa,
status muda pra "ready" e o QR desaparece.

### Persistência de sessão

`whatsapp-web.js` com `LocalAuth` strategy salva a sessão em disco sob
`.wwebjs_auth/`. Enquanto o arquivo existir, restart do bridge NÃO pede
novo QR — reconecta automaticamente. Sessão invalida se:
- Usuário deslogar manualmente via WhatsApp app → precisa re-scan
- WhatsApp mudar o protocolo forçando re-auth (raro)
- O usuário abrir WhatsApp Web em outro navegador (1 sessão web por vez)

### Requisitos

- **Node.js 20+** (LTS)
- **Chromium headless** — whatsapp-web.js usa Puppeteer internamente.
  No macOS Apple Silicon, `puppeteer` baixa o Chromium automaticamente
  via `npx puppeteer install`. Se o download falhar por proxy/firewall,
  setar `PUPPETEER_EXECUTABLE_PATH` pra um Chrome instalado.
- **Porta 3001** livre
- **Disco:** ~200-500 MB pra Chromium + session data
- **RAM:** ~200-400 MB (Chromium headless + Node)

### Instalação

```bash
cd services/whatsapp-bridge
npm install      # ou pnpm install
npx puppeteer install   # baixa Chromium se necessário
npm run build    # compila TypeScript
npm start        # ou node dist/index.js
```

---

## Componente 2: Seraphine tools (Python backend)

### Arquivos

```
backend/seraphine/whatsapp/
├── __init__.py
├── client.py        # WhatsAppBridgeClient — httpx wrapper pro bridge REST
└── routes.py        # FastAPI routes: /webhook/whatsapp + /whatsapp/status + /whatsapp/qr

backend/seraphine/tools/whatsapp.py   # 5 tools pro LLM
```

### WhatsAppBridgeClient

Classe simples que encapsula as chamadas REST ao bridge:

```python
class WhatsAppBridgeClient:
    def __init__(self, base_url: str, timeout: float = 10.0):
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def status(self) -> dict: ...
    async def qr(self) -> dict: ...
    async def list_chats(self, limit: int = 20, unread_only: bool = False) -> list[dict]: ...
    async def read_messages(self, chat_id: str, limit: int = 30) -> dict: ...
    async def send_message(self, chat_id: str, message: str, quote_msg_id: str | None = None) -> dict: ...
    async def search(self, query: str, chat_id: str | None = None, limit: int = 20) -> list[dict]: ...
    async def contacts(self, query: str | None = None) -> list[dict]: ...
```

### Tools (em `tools/whatsapp.py`)

| Tool | Name | Confirmation | Descrição |
|---|---|---|---|
| `WhatsAppAuthStatusTool` | `whatsapp_auth_status` | No | Verifica se o bridge tá conectado e qual número |
| `WhatsAppListChatsTool` | `whatsapp_list_chats` | No | Lista conversas recentes com preview e unread count |
| `WhatsAppReadMessagesTool` | `whatsapp_read_messages` | No | Lê mensagens de um chat específico |
| `WhatsAppSendMessageTool` | `whatsapp_send_message` | **Yes** | Envia mensagem (approval gate pra não mandar sem querer) |
| `WhatsAppSearchMessagesTool` | `whatsapp_search_messages` | No | Busca texto em mensagens |

#### Tool descriptions (pro LLM)

```python
whatsapp_list_chats.description = (
    "List the user's recent WhatsApp chats with last message preview "
    "and unread count. Use when the user asks 'quem me mandou mensagem?', "
    "'tem alguma mensagem nova?', 'o que tem no WhatsApp?'. Each chat has "
    "a chat_id — pass it to whatsapp_read_messages to see the full "
    "conversation or to whatsapp_send_message to reply."
)

whatsapp_read_messages.description = (
    "Read messages from a specific WhatsApp chat. Use after "
    "whatsapp_list_chats to dive into a conversation the user asks about "
    "('o que o Rodrigo falou?', 'lê as mensagens do grupo do trabalho'). "
    "Returns the last N messages with author, timestamp, and quoted "
    "replies."
)

whatsapp_send_message.description = (
    "Send a text message on WhatsApp on behalf of the user. ALWAYS "
    "requires user approval before sending. Use when the user says "
    "'manda pro Rodrigo que vou chegar atrasado' or 'responde pra "
    "Juliana dizendo X'. The chat_id comes from whatsapp_list_chats "
    "or whatsapp_search_messages."
)
```

### Routes (FastAPI)

#### `POST /webhook/whatsapp`

Recebe notificações do bridge (mensagem nova). O backend:
1. Persiste em `notifications` table (mesma do MCP)
2. Pusha via WS pro frontend como `{type: "whatsapp_notification", ...}`
3. Opcionalmente enfileira TTS do preview (mesmo padrão das MCP notifications)

#### `GET /whatsapp/status`

Proxy pro bridge `/api/status`. Usado pelo frontend WhatsAppAuthPanel.

#### `GET /whatsapp/qr`

Proxy pro bridge `/api/qr`. Retorna QR code em base64 pra o frontend renderizar.

### Config (backend `.env`)

```python
# WhatsApp bridge — leave url empty to disable entirely
whatsapp_bridge_url: str = ""    # "http://localhost:3001"
whatsapp_webhook_secret: str = ""  # opcional, pra validar POST do bridge (futuro)
```

Se `whatsapp_bridge_url` vazio, tools não são registradas e routes não são montadas.

### Bootstrap

`seraphine.bootstrap` ganha `_check_whatsapp_bridge()`:
- Se `whatsapp_bridge_url` estiver setado, bate em `/api/status`
- Se não responder: warning (não abort — WhatsApp é opcional)
- Se responder com `status != "ready"`: warning "WhatsApp bridge conectado
  mas não autenticado — escaneie o QR via /whatsapp/qr"

---

## Componente 3: Frontend (React)

### WhatsAppAuthPanel

Similar ao `GoogleAuthPanel`. Aparece na sidebar quando `whatsapp_bridge_url`
tá configurado.

- Se `status == "qr_pending"`: mostra QR code (poll `/whatsapp/qr` a cada 3s)
- Se `status == "ready"`: mostra "WhatsApp conectado como Jonathan (73 999...)"
  com botão de desconectar
- Se `status == "disconnected"`: mostra "WhatsApp desconectado" com botão
  de reconectar

### Notificações

Quando `whatsapp_notification` chega via WS:
- Browser notification: "Rodrigo: E aí, bora amanhã?"
- Chat notification inline (mesmo estilo das MCP notifications)
- Badge no sidebar (similar ao unread count do Gmail)

---

## Fases de implementação

### Fase A — Bridge + read tools (MVP)

1. Criar `services/whatsapp-bridge/` com Node.js + whatsapp-web.js
2. Implementar `/api/status`, `/api/qr`, `/api/chats`, `/api/messages/:chatId`,
   `/api/contacts`, `/api/search`
3. Criar `backend/seraphine/whatsapp/` com client + routes
4. Criar tools: `whatsapp_auth_status`, `whatsapp_list_chats`,
   `whatsapp_read_messages`, `whatsapp_search_messages`
5. Frontend: `WhatsAppAuthPanel` com QR code
6. Bootstrap: `_check_whatsapp_bridge()`
7. Config: `whatsapp_bridge_url` no `.env`

**Critério de aceite:**
- Bootstrap printa "✓ WhatsApp bridge ready as Jonathan"
- Usuário pergunta "quem me mandou mensagem?" → Seraphine lista chats
- Usuário pergunta "o que o Rodrigo falou?" → Seraphine lê as mensagens

### Fase B — Send + webhook notifications

1. Implementar `POST /api/send` no bridge
2. Implementar webhook (bridge → Seraphine)
3. Criar tool `whatsapp_send_message` (com approval gate)
4. Route `POST /webhook/whatsapp` no backend
5. Frontend: notificação proativa de mensagem nova
6. TTS do preview da notificação

**Critério de aceite:**
- "Manda pro Rodrigo que vou chegar atrasado" → approval panel → envia
- Mensagem nova chega → notification no chat + browser notification
- Preview da mensagem é falado via TTS

### Fase C — Polish

1. Suporte a mídia: thumbnail de imagens, transcrição de áudio via Whisper
2. Reply em thread (quoteMsgId)
3. Marcar como lido
4. Encaminhar mensagem
5. Reações (emoji)
6. Status messages (stories)

---

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Meta bane a conta por uso de API não-oficial | Uso pessoal, sem automação em massa, sem spam. Risco baixo. Manter volume de envio humanamente plausível. |
| WhatsApp muda protocolo | whatsapp-web.js é ativamente mantida, geralmente atualiza em dias. Pin a versão em package.json. |
| Sessão cai se abrir WhatsApp Web em outro browser | Documentar na UI. Pode re-escanear a qualquer momento. |
| Chromium headless come RAM | ~200-400 MB. Aceitável no M4 Max (36 GB). |
| Mensagens privadas expostas ao LLM | O LLM vê texto das mensagens quando a tool é chamada. Mesma trust boundary do Gmail. Sem envio a third-party (Anthropic recebe no API call, mas Anthropic policy não treina em dados de API). |
| Webhook flood de mensagens em grupos ativos | Rate-limit no webhook handler. Só notifica pra mensagens diretas + menções em grupo. |

---

## Fora do escopo

- Chamadas de voz/vídeo via WhatsApp
- WhatsApp Business features (catálogo, templates, bots)
- Multi-device nativo (precisa de beta flag no whatsapp-web.js)
- Encriptação E2E custom (whatsapp-web.js já cuida)
- Backup/export de conversas
- Integração com WhatsApp Channels
