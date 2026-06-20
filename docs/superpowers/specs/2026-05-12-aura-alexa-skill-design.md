# Spec — Alexa Integration for Aura via Custom Skill

**Date:** 2026-05-12
**Status:** Approved (design phase) — distribuição = Beta (até 500 testers)
**Owner:** Aura backend + frontend
**Implementation default model:** `opus` (claude-opus-4-7) for every spawned agent.

---

## 1. Context

Aura today fala com o user pelo browser (`https://app.minha-aura.com`),
pelo PWA (Web Push) e — após o spec `2026-05-02` — pelo WhatsApp via
Evolution API. O user tem um Echo em casa e quer poder falar com a Aura
sem abrir nada: "Alexa, pergunta pra Aura quais são meus compromissos
de hoje" ou "Alexa, pede pra Aura criar tarefa: comprar pão amanhã 8h".

Não é controle de smart-home (Aura não comanda lâmpada nenhuma). É
acesso conversacional ao mesmo loop agentic já exposto no chat web e no
WhatsApp.

## 2. Goals

- Skill custom em pt-BR (`pt-BR` locale) publicada na Amazon Developer
  Console, invocação `"abre a aura"` / `"pergunta pra aura"`.
- Account Linking: cada user da Aura vincula sua conta Amazon uma vez,
  fluxo OAuth2 Authorization Code padrão; depois disso, requests da
  Alexa chegam com `accessToken` que o backend troca por `user_id`.
- O handler de skill chama o mesmo `_run_agentic_collect()` do chat web
  /WA, devolve a resposta como `outputSpeech` (SSML curto), e mantém o
  histórico numa `aura_chat_conversations` com `metadata.channel =
  "alexa"`.
- Sessão multi-turn: enquanto o user mantém a skill aberta, o
  `sessionId` da Alexa mapeia pro mesmo `conversation_id` Aura.
- Resposta sempre cabe em ~8s (limite duro da Alexa: 8s pro endpoint
  responder ou a sessão morre).

## 3. Non-goals (v1)

- **Proactive Events API** (Alexa anunciando lembretes no Echo sem ser
  invocada). Fica pra v2; exige certificação extra e fluxo separado.
- **Smart Home Skill** (Aura não é dispositivo).
- **Áudio capturado pelo Echo** processado como áudio na Aura — o ASR
  da própria Alexa já entrega texto pro endpoint; reaproveitamos texto.
- **Multi-conta Amazon por user Aura** (1 user Aura = 1 conta Amazon
  linkada).
- **Display devices** (Echo Show APL cards). Só `outputSpeech` e
  `reprompt` em v1.
- **Push de mídia / imagens** na resposta.

## 4. Topology

```
   ┌──────────┐  voz      ┌────────────────────┐
   │ Echo /   │ ─────────▶│ Alexa Voice Service│
   │ Echo Dot │           │  (Amazon cloud)    │
   └──────────┘           └─────────┬──────────┘
                                    │ HTTPS
                                    │ POST JSON (Request envelope,
                                    │   accessToken, sessionId, …)
                                    ▼
                          ┌─────────────────────────┐
                          │ aura-backend            │
                          │  POST /alexa            │  ← skill endpoint
                          │  GET  /alexa/oauth/authorize │
                          │  POST /alexa/oauth/token │  ← Account Linking
                          │  GET  /alexa/oauth/userinfo  (opcional)
                          └─────────────────────────┘
```

- Endpoint **público** com TLS válido (já temos — nginx + Let's Encrypt
  no `app.minha-aura.com`).
- Validação de assinatura Amazon (`Signature-256` + `SignatureCertChainUrl`)
  obrigatória em produção; sem isso a Amazon recusa certificar a skill.
- Validação de `applicationId` (a skill da Aura tem um id fixo; rejeita
  requests de outras skills que apontem pro endpoint).

## 5. Data Model

Três tabelas novas em SQLite, owned by Aura.

```sql
-- Vincula um user Aura a uma conta Amazon (Account Linking concluído).
CREATE TABLE aura_user_alexa (
  user_id          TEXT PRIMARY KEY,
  amazon_user_id   TEXT NOT NULL UNIQUE,   -- subject vindo do JWT da Amazon
  linked_at        TEXT NOT NULL,          -- ISO timestamp
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- OAuth authorization codes emitidos pela Aura pra Alexa trocar por token.
-- TTL curto (10 min), single-use (drop on /token).
CREATE TABLE aura_alexa_auth_codes (
  code           TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Access + refresh tokens emitidos pela Aura. Refresh é o token longo
-- que a Alexa guarda; access expira (1h) e a Alexa renova sozinha.
CREATE TABLE aura_alexa_tokens (
  refresh_token  TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  revoked_at     TEXT                       -- NULL se ativo
);
```

Reuse `aura_chat_conversations` + `aura_chat_messages`. A conversation
Alexa de cada user é identificada por `metadata = {"channel": "alexa"}`.
Diferente do WhatsApp (uma só, persistente), **cada sessão Alexa abre
uma nova conversation** — o user diz "Alexa, fecha a Aura" e a próxima
sessão começa do zero. Histórico fica salvo, mas o contexto LLM
recomeça (evita arrasto de "ontem você pediu X" em invocações curtas).

Mapping `sessionId → conversation_id` vive em memória process-local
(dict com TTL de 30 min — a Alexa já encerra sessão muito antes disso).

## 6. Backend Modules

```
apps/aura/backend/aura/alexa/
  __init__.py
  schema.py         # CREATE TABLE migrations (registered in main.py)
  signature.py      # Amazon request signature + cert chain validation
  oauth.py          # Authorization Code grant endpoints
  intents.py        # Intent → handler dispatch
  service.py        # AlexaService — session mgmt + agentic call
  routes.py         # FastAPI router (/alexa + /alexa/oauth/*)
  config.py         # Pydantic settings (AURA_ALEXA_*)
```

### 6.1 Signature validation (`alexa/signature.py`)

Cada request da Alexa traz:
- `Signature-256` header
- `SignatureCertChainUrl` header (URL pro cert chain da Amazon, em
  `s3.amazonaws.com/echo.api/...`)
- Body bruto

Pipeline:

1. Confere o `SignatureCertChainUrl` (host = `s3.amazonaws.com`, path
   começa em `/echo.api/`, porta 443, scheme https).
2. Baixa cert chain (cacheia em memória por `SubjectKeyIdentifier`).
3. Verifica chain até a CA Amazon.
4. Confere `SubjectAlternativeName` contém `echo-api.amazon.com`.
5. RSA-SHA256 verify do body com a public key.
6. Confere `request.timestamp` dentro de uma janela de 150s.

Falhar qualquer step → 400. Sem 401/403, porque a Amazon trata 4xx
genéricos como "skill quebrada" e reduz tráfego; 400 é o canônico
deles.

Cache do cert: TTL de 24h, key = URL. Reduz pressão na S3 da Amazon.

### 6.2 OAuth (Authorization Code, `alexa/oauth.py`)

Aura vira **OAuth2 provider**, escopo mínimo (`aura.full`).

- `GET /alexa/oauth/authorize?client_id&redirect_uri&state&response_type=code&scope=aura.full`
  → se o user não tá logado na Aura, redireciona pro login web normal,
  retorna; se tá logado, mostra tela curta "**Conectar Aura ao seu
  Echo?**" com botão Autorizar. Ao clicar, gera `code` (random 32-byte
  hex, TTL 10min), persiste em `aura_alexa_auth_codes`, redireciona pra
  `redirect_uri?code=...&state=...`.
- `POST /alexa/oauth/token` (Basic Auth: client_id/client_secret no
  header)
  - `grant_type=authorization_code` → troca `code` por `{access_token,
    refresh_token, token_type: Bearer, expires_in: 3600}`. Drop do code.
  - `grant_type=refresh_token` → emite novo `access_token` (refresh
    rota também — token rotation), revoga o anterior.

`client_id` + `client_secret` são fixos (1 só client: a skill da Aura).
Vivem em `.env.prod` como `AURA_ALEXA_CLIENT_ID` e
`AURA_ALEXA_CLIENT_SECRET`. Configurados na Amazon Developer Console
do lado da skill.

`redirect_uri` permitido (whitelist): os 3 fixos que a Alexa publica
(`https://layla.amazon.com/api/skill/link/{vendorId}`,
`https://alexa.amazon.co.jp/...`, `https://pitangui.amazon.com/...`).
Qualquer outro → 400.

### 6.3 Intents (`alexa/intents.py`)

Catálogo mínimo na skill (definido no Developer Console em pt-BR):

| Intent                 | Sample utterances pt-BR                                 |
|------------------------|---------------------------------------------------------|
| `LaunchRequest`        | "abre a aura", "inicia aura"                            |
| `PerguntarIntent`      | "{query}", "pergunta {query}", "diz pra aura {query}"   |
| `AMAZON.HelpIntent`    | "ajuda", "o que você faz"                               |
| `AMAZON.StopIntent`    | "para", "fechar"                                        |
| `AMAZON.CancelIntent`  | "cancela"                                               |
| `AMAZON.FallbackIntent`| (catch-all que a Alexa dispara quando nada bate)        |

`PerguntarIntent` usa um único slot `query` do tipo
`AMAZON.SearchQuery`. Texto livre cai direto no `_run_agentic_collect()`.

Handlers:

```python
async def handle_launch(svc, envelope) -> AlexaResponse: ...
async def handle_perguntar(svc, envelope) -> AlexaResponse: ...
async def handle_help(svc, envelope) -> AlexaResponse: ...
async def handle_stop(svc, envelope) -> AlexaResponse: ...
async def handle_fallback(svc, envelope) -> AlexaResponse: ...
```

Dispatch é um dict `{intent_name: handler}` em `intents.py`. Intent
desconhecido → resposta "Não entendi, pode repetir?" + `shouldEndSession
= False`.

### 6.4 AlexaService (`alexa/service.py`)

- `user_id_from_access_token(token)` — consulta
  `aura_alexa_tokens.access_token`, valida expiração, retorna `user_id`
  ou levanta `AlexaAuthError` (handler devolve `LinkAccount` card +
  speech "Vincule sua conta Aura no app Alexa").
- `get_or_create_session(session_id, user_id)` — devolve
  `conversation_id`; cria conversation nova com `metadata.channel =
  "alexa"` se for novo `sessionId`.
- `process_query(user_id, session_id, query_text)` — chama
  `_run_agentic_collect()`, devolve `reply_text` (e descarta chips/UI
  state). Trunca pra ~600 chars antes de virar `outputSpeech` (limite
  da Amazon é 8000 mas a UX é ruim acima de ~30s falados).
- `close_session(session_id)` — limpa o mapping in-memory.

### 6.5 Refactor — nenhum

`_run_agentic_collect()` já está extraído pelo spec do WhatsApp
(2026-05-02). A skill só consome. **Pré-requisito:** o spec do
WhatsApp tem que estar implementado primeiro, OU o refactor isolado em
`chat/routes.py` precisa virar tarefa zero deste plano.

## 7. Routes

```
POST /alexa                          (público; valida signature + applicationId)
GET  /alexa/oauth/authorize          (público; redireciona se não logado)
POST /alexa/oauth/token              (Basic Auth client; público)
```

Response envelope da Alexa (resumido):

```json
{
  "version": "1.0",
  "sessionAttributes": { "conversation_id": "..." },
  "response": {
    "outputSpeech": { "type": "SSML", "ssml": "<speak>...</speak>" },
    "reprompt":     { "outputSpeech": { ... } },
    "shouldEndSession": false,
    "card": null
  }
}
```

SSML do reply é gerado por um helper `to_ssml(text)` que escapa
`&<>'"` e enquadra em `<speak>...</speak>`. Sem `<prosody>` / pausa
artificial em v1.

`shouldEndSession`:
- `LaunchRequest` → false (espera próxima fala).
- `PerguntarIntent` → false (multi-turn).
- `AMAZON.StopIntent` / `CancelIntent` → true.
- Resposta com erro fatal → true + speech "Algo deu errado, tente de
  novo daqui a pouco."

## 8. Frontend

### 8.1 PerfilPage card "Alexa"

Igual ao card do Google Calendar / WhatsApp — ícone (SVG inline,
nunca emoji), pill de status, botão.

- **Não vinculado** — botão "Como conectar". Abre modal com 3 steps:
  1. Abra o app Alexa no celular → "Skills e Jogos" → "Aura".
  2. Toque em **Ativar** → app mostra login da Aura.
  3. Use o mesmo login do `app.minha-aura.com`. Pronto.

  Não tem fluxo de iniciação **a partir da Aura**, porque o
  Account Linking só pode ser iniciado pela própria Alexa app. O card
  é informativo + status.
- **Vinculado** — verde, "Conectado à conta Amazon `a••••••••@gmail.com`"
  (mostra só o domínio + 1ª letra) e botão "Desvincular" com
  `ConfirmDialog` `tone="danger"`. Desvincular dispara
  `POST /alexa/disconnect`, que revoga todos os tokens daquele
  `user_id` em `aura_alexa_tokens`.

### 8.2 API client `frontend/src/api/alexa.ts`

```ts
getStatus(): Promise<{ linked: boolean; amazon_email_masked: string | null }>
disconnect(): Promise<{ ok: true }>
```

(Sem `connect()` — fluxo vive na Alexa app, não na Aura.)

## 9. Deploy & Config

### 9.1 docker-compose

**Nada novo.** Endpoint vive no `backend` que já tá em produção. Não há
sidecar, não há fila, não há instância tipo Evolution.

### 9.2 nginx

Path `/alexa` e `/alexa/oauth/*` precisam:
- `client_max_body_size 64k` (requests Alexa são pequenas).
- Preservar header `Signature-256` e `SignatureCertChainUrl` no proxy
  (caso config strip headers). Conferir antes do go-live.

### 9.3 `.env.prod`

```
AURA_ALEXA_SKILL_ID=amzn1.ask.skill.<uuid>          # vem do Developer Console
AURA_ALEXA_CLIENT_ID=<generated 32-byte hex>
AURA_ALEXA_CLIENT_SECRET=<generated 64-byte hex>
AURA_ALEXA_OAUTH_ISSUER=https://app.minha-aura.com  # base pros endpoints OAuth
```

### 9.4 Amazon Developer Console (one-time, manual)

1. Criar Skill custom, locale `pt-BR`, invocation `"a aura"`.
2. Definir intents conforme §6.3, slot `query: AMAZON.SearchQuery`.
3. Endpoint → HTTPS, `https://app.minha-aura.com/alexa`, cert SNI
   (Let's Encrypt já válido).
4. Account Linking:
   - Auth URI: `https://app.minha-aura.com/alexa/oauth/authorize`
   - Token URI: `https://app.minha-aura.com/alexa/oauth/token`
   - Client ID / Secret: o que está em `.env.prod`.
   - Grant type: Authorization Code.
   - Scope: `aura.full`.
5. Testar no simulador, depois escolher modo de distribuição (veja
   §9.5).

### 9.5 Distribuição da skill (multi-user)

A skill nasce multi-tenant no backend (cada user Aura linka a própria
conta Amazon, ver §5), mas o que define **quem consegue enxergar a
skill no app Alexa** é o estado de distribuição na Developer Console.
Três modos:

| Modo            | Quem vê a skill                                  | Custo operacional                                  |
|-----------------|--------------------------------------------------|----------------------------------------------------|
| **Development** | Só a conta Amazon dona da skill (a do dev).      | Zero. Default ao criar.                            |
| **Beta**        | Até 500 contas Amazon convidadas por email.      | Cadastrar email de cada tester no painel.          |
| **Live**        | Qualquer um na loja Alexa Skills do locale.      | Passar por certificação Amazon (política, testes). |

**Decisão v1: Beta.** Casa com o perfil atual (5–6 users, mesma
audiência do WhatsApp), evita certificação, e cada user Aura precisa:

1. Ser convidado por email Amazon no painel Beta (`Developer Console
   → Distribution → Availability → Beta Test`).
2. Aceitar o convite no email (link da Amazon).
3. Abrir o app Alexa → Skills & Games → Aura → Ativar.
4. Logar com a conta Aura no fluxo OAuth (§6.2). A partir daí, o Echo
   daquele user conversa com a Aura daquele user.

**Promoção pra Live** é um upgrade depois — exige privacy policy
pública, ícones, descrição PT-BR, e ~3 dias de review da Amazon. Fora
do escopo da v1.

## 10. Limits & Safety

- **Latência:** loop agentic precisa fechar em <7s pra deixar margem
  pro network. Se o LLM demora, mandar `progressiveResponse`
  ("Pensando...") via Directive Service após 3s, e a resposta final
  quando estiver pronta. Implementação em §6.4 com `asyncio.timeout`
  hard em 7s — se estourar, devolve "Demorei mais que o esperado,
  posso tentar de novo?" + `shouldEndSession=true`.
- **Rate limit:** 60 invocações/hora por `user_id` (sliding window em
  memória, mesmo padrão do WhatsApp). Excesso → speech "Você atingiu
  o limite por hora" + end session.
- **Account Linking obrigatório.** Request sem `accessToken` válido →
  resposta com `card.type = "LinkAccount"`, que faz a Alexa app abrir
  a tela de vincular.
- **`applicationId` check:** rejeita requests cujo
  `session.application.applicationId` ≠ `AURA_ALEXA_SKILL_ID`. Defesa
  contra alguém apontar a própria skill pro nosso endpoint.
- **Timestamp skew:** 150s, conforme certificação Amazon.
- **Sem logging de `query` em INFO** — texto da pergunta vai pra DEBUG
  só. Echo capta tudo que o user fala antes e depois da wake-word; não
  queremos isso em logs de produção.

## 11. Failure Modes

| Failure                                    | Behavior                                                          |
|--------------------------------------------|-------------------------------------------------------------------|
| Signature inválida                         | 400, log WARN. Amazon não retenta.                                |
| `applicationId` errado                     | 400, log WARN.                                                    |
| `accessToken` ausente/expirado/revogado    | 200 com `card.type=LinkAccount`, speech "Vincule sua conta".      |
| LLM timeout >7s                            | 200 com "Demorei mais que o esperado…", `shouldEndSession=true`.  |
| LLM tool error                             | 200 com "Algo deu errado, posso tentar de novo?", end session.    |
| Intent desconhecido                        | 200 fallback "Não entendi, pode repetir?", session aberta.        |
| Refresh token consumido 2x (replay)        | `/token` retorna 400 `invalid_grant`. Alexa força re-link.        |

## 12. Testing Strategy

- **Unit (pytest):**
  - `signature.verify` — fixture com payload + cert válido vs. corrompido,
    + timestamp fora da janela.
  - `oauth.exchange_code` — code válido, expirado, single-use enforcement.
  - `oauth.refresh` — rotation, revoga anterior.
  - `intents.dispatch` — cada intent → handler certo; desconhecido → fallback.
  - `AlexaService.process_query` — happy path com `_run_agentic_collect`
    mockado; timeout 7s.

- **Integration (pytest + FastAPI TestClient):**
  - POST `/alexa` com LaunchRequest assinado (fixture) → response shape.
  - Fluxo OAuth completo: authorize → code → /token → access_token →
    POST /alexa com Bearer → 200 com reply.
  - Replay: usar o mesmo refresh duas vezes → 2ª falha.

- **Manual E2E (post-deploy):**
  - Skill em modo Beta, testar no Echo real:
    - "Alexa, abre a aura" → speech de boas-vindas.
    - "Qual minha agenda hoje?" → resposta com eventos do dia.
    - "Cria tarefa: comprar pão amanhã 8h" → confere na UI web.
    - "Para" → encerra.
  - Account unlinking pela Alexa app → próxima invocação cai no
    LinkAccount card.

## 13. Rollout Plan (high level)

Detalhe em `/writing-plans`. Ordem:

1. Schema + `signature.py` + testes (assinatura é o ponto mais
   delicado, faz primeiro).
2. OAuth provider (`/authorize` + `/token`) com fluxo end-to-end no
   TestClient.
3. `AlexaService` + `intents.py` + handler do `/alexa` (com
   `_run_agentic_collect` já existente).
4. Frontend card no Perfil (status + disconnect; sem connect button).
5. Nginx config bump (preservar headers Signature-*).
6. Boot one-shot:
   - `git push vps main`
   - Configurar skill na Amazon Developer Console
   - Smoke E2E no Echo
   - Convidar contas Amazon como Beta testers.

Cada agente roda com `model: opus`.

## 14. Out-of-scope reminders (v2 backlog)

- **Proactive Events API** — Aura proativamente anuncia lembretes nos
  Echos do user ("Você tem reunião em 10 minutos"). Exige certificação
  da skill + permissão explícita do user na Alexa app.
- **APL / Echo Show** — cards visuais (lista de compromissos, gráfico
  financeiro) em devices com tela.
- **Multi-comando numa frase** ("cria tarefa X e mostra agenda") —
  hoje cai num só round de `_run_agentic_collect`, que tem que
  resolver tudo; pode precisar de slot extra ou intent composto.
- **Identificação por voz** (Alexa Voice ID) pra desambiguar usuários
  na mesma casa.
- **Skill em outros locales** (`en-US`, `es-ES`).
