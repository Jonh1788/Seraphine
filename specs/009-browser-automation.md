# Spec 009 — Browser Automation + PIX Transfer (C6 Bank)

## Contexto

A Seraphine hoje consegue buscar informações (web_search, web_fetch), mas
não consegue **agir** na web — reservar hotel, preencher formulário, fazer
PIX. Este spec adiciona um browser automatizado via Playwright que a
Seraphine controla usando visão (Claude Vision) num loop autônomo:
screenshot → analisa → decide ação → executa → repete.

O PIX via C6 Bank é o primeiro caso de uso concreto, mas a infra serve pra
qualquer site: reservar hotel no Booking, pedir comida no iFood, comprar
ingresso, preencher formulário governo, etc.

## Arquitetura

### Componente 1: Browser Service (Python + Playwright :3002)

Serviço REST standalone que controla uma instância Chromium via Playwright.
Roda no mesmo Mac da Seraphine (localhost). Playwright em modo **persistente**
(persistent context) pra manter cookies/login entre sessões.

```
services/browser-agent/
├── main.py           # FastAPI app + Playwright lifecycle
├── config.py         # env vars (PORT, HEADLESS, VIEWPORT, etc.)
├── browser.py        # Playwright browser singleton + context persistence
├── routes/
│   ├── navigate.py   # POST /navigate
│   ├── screenshot.py # POST /screenshot
│   ├── click.py      # POST /click
│   ├── type.py       # POST /type
│   ├── scroll.py     # POST /scroll
│   ├── keyboard.py   # POST /keyboard (press Enter, Tab, etc.)
│   ├── select.py     # POST /select (dropdown)
│   ├── page.py       # GET /page (current URL + title)
│   └── close.py      # POST /close
├── requirements.txt
└── user-data/        # Chromium profile persistence (cookies, login)
```

### API Contract

#### POST /navigate
```json
{ "url": "https://app.c6bank.com.br" }
→ { "ok": true, "url": "https://app.c6bank.com.br/login", "title": "C6 Bank" }
```

#### POST /screenshot
```json
{ "full_page": false }
→ { "image": "data:image/png;base64,iVBOR...", "width": 1280, "height": 800 }
```

Resolução padrão: 1280x800 (bom pra vision sem explodir tokens).
`full_page: true` captura a página inteira (scroll included).

#### POST /click
```json
{ "x": 640, "y": 400 }
→ { "ok": true }
```
Alternativo por selector CSS:
```json
{ "selector": "#btn-confirmar" }
→ { "ok": true }
```

#### POST /type
```json
{ "text": "73999887766", "clear_first": true, "press_enter": false }
→ { "ok": true }
```
`clear_first`: limpa o campo antes de digitar (triple-click + delete).

#### POST /keyboard
```json
{ "key": "Enter" }
→ { "ok": true }
```
Keys: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, etc.

#### POST /scroll
```json
{ "direction": "down", "amount": 500 }
→ { "ok": true }
```

#### POST /select
```json
{ "selector": "select#estado", "value": "BA" }
→ { "ok": true }
```

#### GET /page
```json
→ { "url": "https://app.c6bank.com.br/pix/enviar", "title": "Enviar Pix - C6 Bank" }
```

#### POST /close
```json
→ { "ok": true }
```

### Config

```
BROWSER_PORT=3002
BROWSER_HEADLESS=false      # false = janela visível (recomendado pra acompanhar)
BROWSER_VIEWPORT_WIDTH=1280
BROWSER_VIEWPORT_HEIGHT=800
BROWSER_USER_DATA_DIR=./user-data   # persistência de cookies/login
BROWSER_SLOW_MO=100         # ms entre ações (anti-bot, mais natural)
```

`HEADLESS=false` é importante pra que o usuário **veja** o que a Seraphine
tá fazendo no browser em tempo real.

### Persistência de login

Playwright com `persistent_context` salva cookies, localStorage, sessionStorage
em `user-data/`. Uma vez que o usuário loga no C6 Bank manualmente (na
primeira vez), o login persiste entre sessões. A Seraphine não guarda
senhas — só navega o browser que já tá logado.

### Startup

```
[browser-agent] starting on :3002
[browser-agent] launching Chromium (headless=false, viewport=1280x800)
[browser-agent] user data dir: ./user-data/
[browser-agent] ready — browser visible on screen
```

---

## Componente 2: Seraphine Tools (Python backend)

### Arquivos

```
backend/seraphine/browser/
├── __init__.py
├── client.py        # BrowserAgentClient — httpx wrapper
└── routes.py        # (futuro: proxy endpoints se necessário)

backend/seraphine/tools/browser.py   # tools pro LLM
```

### Tools

| Tool | Name | Confirmation | Descrição |
|---|---|---|---|
| `BrowserOpenTool` | `browser_open` | No | Navega pra uma URL |
| `BrowserScreenshotTool` | `browser_screenshot` | No | Screenshot → retorna como imagem pro vision do Claude |
| `BrowserClickTool` | `browser_click` | No | Clica em (x, y) ou selector CSS |
| `BrowserTypeTool` | `browser_type` | No | Digita texto no campo focado |
| `BrowserScrollTool` | `browser_scroll` | No | Scroll up/down |
| `BrowserKeyTool` | `browser_key` | No | Pressiona tecla (Enter, Tab, etc.) |
| `BrowserPageInfoTool` | `browser_page_info` | No | URL + título da página atual |
| `BrowserSubmitTool` | `browser_submit` | **Yes** | Submete form / clica em botão de confirmação |
| `BrowserConfirmPaymentTool` | `browser_confirm_payment` | **Yes** | Confirma pagamento/PIX — gate máximo com detalhes |

### Screenshot → Vision

`browser_screenshot` retorna a imagem como content block pra Claude:
```python
async def execute(self, args):
    data = await self.client.screenshot()
    return ToolResult(
        ok=True,
        output="Screenshot da página atual",
        # A imagem base64 é passada como content block de imagem
        # pro engine incluir na próxima mensagem ao LLM
        metadata={"image": data["image"], "width": data["width"], "height": data["height"]},
    )
```

O engine precisa ser adaptado pra que quando uma tool retorna `metadata.image`,
esse dado seja incluído como image content block na próxima chamada ao LLM.
Isso é o que permite o loop de visão:
1. Claude chama `browser_screenshot`
2. Tool retorna imagem no metadata
3. Engine inclui a imagem na próxima mensagem
4. Claude "vê" a página e decide a próxima ação

### System prompt pra navegação

Quando uma tool de browser está registrada, adicionar ao system prompt:

```
You have access to a web browser. When the user asks you to do something
on a website (reserve hotel, make a PIX, fill a form, order food), use
the browser tools in a loop:

1. browser_open(url) to navigate
2. browser_screenshot() to see the page
3. Analyze the screenshot and decide what to do
4. browser_click(x, y) or browser_type(text) to interact
5. browser_screenshot() again to see the result
6. Repeat until the task is done

IMPORTANT RULES:
- ALWAYS take a screenshot after every action to verify the result
- NEVER guess what's on the page — always screenshot first
- For payments/PIX/checkout: ALWAYS use browser_confirm_payment with
  full details so the user can approve
- For form submissions: use browser_submit so the user can review
- Click coordinates are based on the 1280x800 viewport
- If you see a login page, ask the user to log in manually (don't
  ask for passwords)
- Be patient — wait for pages to load (1-2s) before screenshotting
- Describe what you see and what you're doing at each step
```

---

## Caso de uso: PIX via C6 Bank

### Pré-requisitos
1. Browser service rodando (`services/browser-agent`)
2. Usuário já logou no C6 Bank pelo menos uma vez (cookies persistidos)
3. C6 Bank web: `https://app.c6bank.com.br`

### Fluxo esperado

```
Usuário: "Faz um PIX de R$50 pro Rodrigo, chave 73999887766"

Seraphine:
  "Vou abrir o C6 Bank e fazer o PIX!"
  → browser_open("https://app.c6bank.com.br")
  → browser_screenshot()
  [Claude vê: dashboard do C6 com saldo, menu lateral]
  
  → browser_click(menu Pix ou coordenada do botão)
  → browser_screenshot()
  [Claude vê: tela de Pix com opções Enviar/Receber/etc]
  
  → browser_click("Enviar")
  → browser_screenshot()
  [Claude vê: formulário de envio com campo de chave]
  
  → browser_click(campo chave) → browser_type("73999887766")
  → browser_click("Continuar")
  → browser_screenshot()
  [Claude vê: dados do destinatário (Rodrigo Silva, CPF ***)]
  
  → browser_click(campo valor) → browser_type("50,00")
  → browser_screenshot()
  [Claude vê: tela de confirmação com todos os dados]
  
  "Jonathan, confirme o PIX:
   → Destinatário: Rodrigo Silva
   → Chave: 73999887766
   → Valor: R$ 50,00
   → Banco: C6 Bank
   Confirmar?"
  
  → browser_confirm_payment() → APPROVAL GATE
  → Usuário aprova
  → browser_click("Confirmar") na tela do C6
  → browser_screenshot()
  [Claude vê: comprovante do PIX]
  
  "PIX de R$50,00 enviado com sucesso para Rodrigo Silva! 🎉
   Comprovante disponível na tela."
```

### Segurança

- **Login**: feito manualmente pelo usuário. Seraphine NUNCA pede senha.
- **PIX**: SEMPRE passa pelo approval gate com detalhes completos antes de
  clicar confirmar.
- **Sessão**: se o C6 expirar a sessão, Seraphine detecta a tela de login
  e pede pro usuário re-logar.
- **2FA**: se o banco pedir OTP/biometria, Seraphine avisa o usuário e
  espera ele completar no celular.

---

## Outros casos de uso

Com a mesma infra de browser:

- **Reservar hotel**: Booking.com, Airbnb
- **Pedir comida**: iFood, Rappi
- **Comprar ingresso**: Sympla, Ingresse
- **Pagar boleto**: via internet banking do C6
- **Preencher formulário**: qualquer site gov/privado
- **Pesquisa avançada**: sites que web_fetch não consegue (JS-heavy, login-required)

---

## Fases

### Fase A — Browser service + tools básicas

1. `services/browser-agent/` com Playwright + FastAPI
2. Endpoints: navigate, screenshot, click, type, scroll, keyboard, page, close
3. Seraphine tools: browser_open, browser_screenshot, browser_click,
   browser_type, browser_scroll, browser_key, browser_page_info
4. Engine: suporte a image content block no tool result
5. Config + bootstrap

**Critério**: "abre o google e pesquisa hotéis em Arraial" funciona end-to-end
com vision loop.

### Fase B — Actions com gate + PIX

1. browser_submit + browser_confirm_payment com approval gate
2. System prompt de navegação
3. Teste com C6 Bank PIX
4. Persistência de cookies

**Critério**: PIX de teste (R$1) funciona end-to-end com confirmação do usuário.

### Fase C — Polish

1. Espera inteligente (aguardar página carregar antes de screenshot)
2. Element highlighting (marcar onde vai clicar antes de clicar)
3. Gravação de ações (replay de fluxos frequentes)
4. Multi-tab support
5. Download de arquivos (comprovantes, boletos)

---

## Requisitos

- **Playwright** (`pip install playwright && playwright install chromium`)
- **FastAPI + uvicorn** (mesmo padrão dos outros services)
- **RAM**: ~200-400 MB pro Chromium
- **Tela**: modo não-headless precisa de display (no Mac: funciona direto)
