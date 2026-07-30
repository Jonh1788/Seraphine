# Seraphine × EspMusic — controlar o som da casa

**Data**: 2026-07-30
**Estado**: desenho aprovado, pronto para virar plano de implementação

## Problema

O **EspMusic** (`~/Dev/HomeEspSera`, repo separado) é o começo da casa
inteligente: um ESP32 por cômodo tocando áudio, com um servidor FastAPI num PC
Windows da rede local. Ele já tem API HTTP completa e um painel PWA próprio.

A Seraphine deveria conseguir tocar música, dar avisos falados e mexer no
volume — mas o backend dela roda **no VPS**, e o EspMusic só existe **dentro da
LAN**. É esse vão que o desenho fecha.

O EspMusic é o primeiro aparelho de uma lista: luzes, garagem e piscina vêm
depois. O desenho é feito para que cada um deles seja um adaptador novo, não uma
integração nova.

## Decisões tomadas

| Questão | Decisão |
|---|---|
| Alcance | **Só em casa** no v1: o app Tauri na LAN executa. Acesso de fora fica para a v2 (bridge outbound). |
| Voz dos avisos | **A voz da Seraphine** (TTS dela). Sem fallback para o TTS do Windows. |
| Autonomia | **Nenhuma** no v1 — a casa só fala quando você pede. |
| Casa vs navegador | **Navegador continua o padrão.** A casa só toca quando você citar cômodo/casa. Nada muda no comportamento atual de `play_music`. |
| Forma do transporte | **Relé HTTP genérico com allowlist** no Rust + domínio todo em Python. |

## Arquitetura

```
VPS (backend)                    Mac (.app, na LAN)            PC Windows
┌───────────────────┐            ┌──────────────────┐          ┌──────────────┐
│ tools/home.py     │            │ tool-proxy/      │          │  EspMusic    │
│  home_play        │            │   index.ts       │          │  FastAPI     │
│  home_control     │            │   ["lan_request"]│          │  :8080       │
│  home_announce    │  WS        │        ↓         │  HTTP    │              │
│  home_status      │ ─────────► │  src-tauri/      │ ───────► │ /api/play    │
│        ↓          │ tool_proxy │   home.rs        │  LAN     │ /api/volume  │
│ home/service.py   │  _request  │  (allowlist +    │          │ /api/announce│
│ home/espmusic.py  │            │   reqwest)       │          │   (novo)     │
│ home/transport.py │            └──────────────────┘          └──────┬───────┘
└───────────────────┘                                                 │ TCP
                                                              ESP32 do cômodo
```

O ponto central: **`lan_request` não é uma tool do registry**. O LLM nunca a vê.
É uma capacidade do cliente, invocada pelo transporte com o mesmo mecanismo de
proxy que já existe (`_proxy_tool_via_client`, `conversation/engine.py:378`).
As tools que o LLM enxerga são de domínio (`home_play`, …) e rodam no VPS.

Isso é o que torna a v2 barata: trocar o transporte por um bridge outbound é
reescrever `home/transport.py` e nada mais.

### Componentes novos — backend (`apps/seraphine/backend/seraphine/`)

- **`home/transport.py`** — `LanTransport.request(method, path, json=None, audio=None)`.
  Monta o payload de `lan_request` e chama `_proxy_tool_via_client(app_state,
  "lan_request", …)`. Converte erros de proxy/rede em exceções de domínio.
- **`home/espmusic.py`** — `EspMusicAdapter`. Conhece as rotas do EspMusic,
  traduz cômodo → `espmusic-<slug>`, converte volume %↔dB, interpreta as
  respostas e resume o `/api/status`.
- **`home/service.py`** — `HomeService`, dono do adaptador e ponto de extensão
  para `lights.py` / `garage.py` / `pool.py`.
- **`tools/home.py`** — as quatro tools, injetadas com `HomeService`.
- **`tools/registry.py`** — registra as quatro quando `home_service is not None`,
  no mesmo padrão dos demais serviços opcionais.

### Componentes novos — frontend (`apps/seraphine/frontend/`)

- **`src/tool-proxy/index.ts`** — handler `lan_request`, que só repassa para o
  comando Tauri e embrulha o resultado no `ProxyResponse` de sempre.
- **`src-tauri/src/home.rs`** — comando `lan_request`:
  - valida `host:porta` contra uma **allowlist** — uma constante no próprio
    `home.rs` com `espmusic.local:8080` e o IP fixo do PC como reserva (quando
    o mDNS falha). É código, não configuração: muda uma vez e raramente.
  - `reqwest` com timeout de 20s (nova dependência no `Cargo.toml`);
  - corpo JSON ou multipart (quando vem áudio em base64);
  - devolve `{status, body}` — sem interpretar nada.

Chamadas HTTP para a LAN precisam sair do Rust: o EspMusic não tem CORS e o app
não usa `tauri-plugin-http`, então `fetch` do webview seria bloqueado.

### Componente novo — EspMusic (`~/Dev/HomeEspSera`, repo separado)

- **`POST /api/announce`** (multipart, campo `file`): grava o áudio recebido num
  arquivo temporário e chama `engine.play_alert([...], preset="voice")`.

É a única mudança lá. A prioridade de aviso já existente cuida do resto: o aviso
corta a música e a faixa volta exatamente do ponto onde parou (`README.md`,
seção "Prioridade").

## Contrato das tools

Todas com `requires_confirmation = False` — são ações reversíveis e sempre
partem de um pedido explícito seu.

| Tool | Args | Chamadas |
|---|---|---|
| `home_play` | `query` (obrigatório: música, link do YouTube ou caminho), `room?`, `mode` = `now`\|`queue` (padrão `now`) | `POST /api/device` se houver `room`, depois `POST /api/play {query, mode}` |
| `home_control` | `action` (obrigatório), `value?`, `room?` | ver tabela abaixo |
| `home_announce` | `text` (obrigatório) | TTS → `POST /api/announce` |
| `home_status` | — | `GET /api/status` |

`home_status` não recebe `room`: o `/api/status` já devolve o estado global,
incluindo a lista de caixas e qual está selecionada.

`mode: "queue"` só enfileira se já houver algo tocando ou na fila; caso
contrário o EspMusic toca na hora (`api.py:93`). É o comportamento desejado.

### Não confundir com o `play_music` do navegador

A Seraphine já tem `play_music` / `pause_music` / `now_playing` em
`tools/browser.py`, que controlam o YouTube Music no navegador do Mac. Elas
continuam sendo o **padrão**. As descrições das tools `home_*` precisam dizer
explicitamente: *use apenas quando o usuário citar um cômodo ou a casa
("na sala", "nas caixas", "na casa"); para tocar no próprio Mac, use
`play_music`*. Sem essa instrução no texto da tool, o LLM escolhe errado.

`home_control.action` aceita:

| action | Chamada |
|---|---|
| `pause` / `resume` | `POST /api/pause {"on": true/false}` |
| `next` | `POST /api/next` |
| `stop` | `POST /api/stop` (limpa a fila) |
| `mute` | `POST /api/mute` (alterna) |
| `volume_up` / `volume_down` | `POST /api/volume {"delta_db": ±2}` |
| `volume_set` | `POST /api/volume {"db": 20·log₁₀(value/100)}` |
| `radio_on` / `radio_off` | `POST /api/radio {"on": true/false}` |

### Volume

A API do EspMusic trabalha em dB; o painel mostra %. O adaptador usa a mesma
fórmula do painel (`web/src/api.js:102`, `dbToPct`): `db = 20·log₁₀(pct/100)`.
Logo 100% = 0 dB, 50% ≈ −6 dB, 12% ≈ −18,4 dB. `value` em `volume_set` é sempre
percentual (0–100), que é como você fala. `value = 0` manda `db = -60`
(silêncio prático) em vez de `log₁₀(0)` — não usa `/api/mute`, que é um
alternador e desmutaria se já estivesse mudo.

`mute` é alternador do lado do EspMusic; o estado atual vem no `home_status`,
então o LLM consegue conferir antes de alternar.

### Cômodos

`room` é opcional em todas. **Sem `room`, usa a caixa já selecionada** — a
Seraphine nunca troca de cômodo por conta própria. Com `room`, o adaptador
normaliza (minúsculas, sem acento, espaços → hífen), valida contra a lista de
caixas do `/api/status` e só então chama `/api/device`.

O EspMusic toca em **uma caixa por vez**; tocar em vários cômodos ao mesmo tempo
não existe do lado dele e está fora de escopo.

`home_announce` **não aceita `room`** no v1, de propósito: o aviso sai na caixa
selecionada, e trocar a caixa para avisar moveria a música junto (é a mesma
seleção). Avisar num cômodo sem mudar onde a música toca exige um conceito de
"caixa alvo do aviso" que o EspMusic ainda não tem — fica para quando o
EspMusic suportar mais de uma caixa.

Em `volume_up` / `volume_down` o `value` é ignorado: o passo é fixo em 2 dB.
Para um alvo específico, o LLM usa `volume_set`.

### Fluxo do aviso

1. LLM chama `home_announce("o jantar chegou")`.
2. O backend sintetiza com o TTS ativo: tenta `synthesize_ogg`; se o adaptador
   não implementar (só alguns implementam — ver `tts/base.py:21`), junta os
   chunks PCM s16le 24 kHz de `synthesize_stream` e embrulha num WAV.
3. O áudio vai em base64 dentro dos args de `lan_request` (mesmo padrão de
   enriquecimento server-side de `consumes_attached_image`, `tools/base.py:37`).
4. O Rust posta multipart em `/api/announce`.
5. O EspMusic corta a música, fala com preset `voice`, e devolve a faixa ao
   ponto exato.

## Tratamento de erro

Cada falha vira uma frase que a Seraphine consegue falar, nunca um stack trace:

| Situação | Mensagem |
|---|---|
| App fechado / fora da LAN (o broker responde `no Tauri WebSocket is connected`) | "não alcanço a casa — o app não está aberto no Mac" |
| EspMusic fora do ar ou `.local` não resolve | "o servidor da casa não respondeu" |
| Cômodo desconhecido | erro **lista os cômodos existentes**, para o LLM se corrigir na mesma volta |
| `404 nada encontrado` do `/api/play` | "não achei essa música" |
| Host fora da allowlist | o Rust recusa antes de abrir conexão (rede de segurança, não deveria ocorrer) |
| TTS indisponível | erro claro; **sem** fallback para o TTS do Windows |

Timeouts: 20s no Rust, 90s no proxy (`_PROXY_TIMEOUT_SECONDS`,
`conversation/engine.py:357`) — a busca do `yt-dlp` cabe folgado.

## Testes

- **Backend (pytest)** — adaptador contra um transport falso:
  - mapeamento ação → rota/corpo para cada `action`;
  - conversão %↔dB nos limites (0%, 50%, 100%);
  - normalização de cômodo com acento e espaço (`"Sala de Estar"` →
    `espmusic-sala-de-estar`);
  - cada linha da tabela de erros virando a mensagem certa;
  - `home_announce` com TTS falso: confere o multipart montado e o caminho
    `synthesize_ogg` → fallback WAV.
  - tools: schema JSON válido e repasse correto de args ao adaptador.
- **Rust** — teste de unidade da allowlist: host permitido, host negado, porta
  divergente.
- **TS** — handler `lan_request` com `invoke` mockado (sucesso e erro).
- **E2E manual** (depende do PC e das caixas ligadas; checklist para rodar à
  mão): tocar uma música pedindo o cômodo, subir o volume, pular a faixa, mandar
  um aviso — e confirmar que a música retoma do ponto exato depois do aviso.

## Fora de escopo (v1)

- Aba "Casa" na UI da Seraphine — o PWA do EspMusic já cobre isso.
- Tocar em várias caixas ao mesmo tempo — o EspMusic não suporta.
- Avisos automáticos (lembretes, email urgente, rotinas) — decisão explícita de
  não dar autonomia agora.
- Acesso de fora de casa — v2, via bridge outbound.
- Luzes, garagem, piscina — cada um vira um adaptador em `home/` depois, sem
  mexer em Rust nem em TS.

## Deploy

- Backend: `git push vps main` (hook redeploya via docker compose).
- Frontend/Rust: `pnpm tauri:install` na máquina local.
- EspMusic: commit no repo `~/Dev/HomeEspSera` e reiniciar
  `python espmusic.py serve` no PC Windows.
