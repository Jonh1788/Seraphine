# 076 — Aura Mobile-First Refresh + Living Sphere

## Contexto

A Aura está em produção em https://app.minha-aura.com. Stack moderno
(React 18 + Vite + Tailwind + FastAPI), telas funcionais (Chat,
Dashboard, Tasks, Finance, Calendar) e backend com LLM + tools. Não é
um rewrite — é uma **repaginação mobile-first** com:

- **Avatar 3D real.** Hoje o "avatar" da Aura é um gradiente CSS
  (`ChatPage.tsx:835`). O usuário já tem uma esfera Three.js refinada
  (Fibonacci sphere, displacement por shader, mouse reactive, edge wave
  circular, dust + sparkles, sem CPU por frame). Vai virar
  `<AuraSphere />` em react-three-fiber e ser a presença viva da Aura.
- **Mobile-first de verdade.** Hoje é responsivo (Tailwind breakpoints)
  mas pensado pra desktop primeiro: sidebar drawer pelo hamburger,
  modais `inset-0`, sem safe-area, sem PWA, sem bottom nav, sem swipe
  gestures. Em iPhone funciona, mas não convence.
- **Sistema visual mais distinto.** Paleta atual (`#0a0e1a` + roxo)
  é OK mas genérica. Mockup em `../Aura-mockup/aura-mockup.html`
  propõe navy mais profundo (`#06091A`), accent azul `#4F7EFF`, fontes
  Sora + DM Sans + JetBrains Mono. Vamos adotar (e melhorar).
- **Briefing diário.** Mockup tem uma sequência narrativa "Briefing"
  (typewriter + mini-orb pulsando a cada KPI entregue) que é a melhor
  ideia visual do protótipo. Vira página `/hoje`.
- **PWA installable.** Sem manifest, sem service worker, sem install
  prompt. Em iOS é "abrir no Safari"; em Android idem. Adicionar é
  trivial e desbloqueia o uso real como "app".

Referências:
- Mockup completo: `../Aura-mockup/aura-mockup.html` (HTML/CSS/JS
  vanilla, 12 telas, esfera canvas 2D).
- Esfera nova (a que vamos portar): código embutido na conversa de
  brainstorm — Three.js puro com 520 pontos, shader vertex que faz
  displacement + rim + edge wave + mouse-reactive, tudo na GPU. Já
  está perfeito; só precisa virar componente r3f.

## Escopo — 5 Fases

### Fase 1 — Design Tokens + Mobile Shell

**Objetivo:** trocar a base visual e a navegação mobile sem mexer no
conteúdo das páginas. Ao final desta fase, a app tem cara nova mas
todas as features atuais funcionam exatamente igual.

**Tokens** (`apps/aura/frontend/tailwind.config.ts`):
- Cores: substituir `bg.{base,surface,elevated}` por escala de 4
  superfícies sobre `#06091A`:
  ```ts
  bg: {
    base: '#06091A',
    s1:   '#0d132a',
    s2:   '#141c38',
    s3:   '#1d274a',
  }
  ```
- Accent: trocar `accent.purple*` por `accent.{blue, blue-soft, glow}`
  (`#4F7EFF`, `#7da0ff`, `rgba(79,126,255,0.45)`). Manter `accent.purple`
  como alias temporário deprecated pra não quebrar imports até a Fase 2.
- Manter `mod.{tasks,finance,reminders,habits,chat}` como está —
  já cumpre.
- Fonts: adicionar `display: ['Sora', ...]`, `mono: ['JetBrains Mono',
  'ui-monospace', ...]`. `sans` vira `['DM Sans', 'Inter', ...]`.
- Radius: extender `borderRadius` com `xl2: '22px'`, `xl3: '32px'`,
  `xl4: '46px'` (pareando com mockup).
- Shadows: adicionar `glow-blue: '0 0 32px -8px rgba(79,126,255,0.45)'`
  e `inset-edge: 'inset 0 1px 0 0 rgba(255,255,255,0.06)'`.

**Fonts** (`index.html` + `globals.css`):
- `<link>` Google Fonts para Sora 400/600/700, DM Sans 400/500/700,
  JetBrains Mono 400/500. Preconnect.

**Mobile Shell** (`layout/`):
- Novo `BottomNav.tsx` (fixed bottom, 5 slots, glassy bg
  `bg.s1/80 backdrop-blur`, safe-area `pb-[env(safe-area-inset-bottom)]`,
  active item destacado com glow azul). Visível só `<lg`.
- Refactor `AppShell.tsx`: layout muda para
  ```
  <main pb={hasBottomNav ? 'safe+64' : 'safe'}>{children}</main>
  <BottomNav className="lg:hidden" />
  <Sidebar className="hidden lg:block" />
  ```
  Hambúrguer + drawer atual continuam só pra acessar "Mais" em desktop
  reduzido (não é mais o entry mobile principal).
- Refactor `MobileTopbar.tsx`: simplifica para título da página +
  ações contextuais (sem hamburger). Em rotas com `<AuraSphere
  variant="compact" />`, sphere aparece à esquerda do título.
- Novo `<Sheet />` em `components/Sheet.tsx`: bottom-sheet em mobile
  (CSS `dialog` + `transform: translateY(100%)` → `0`, drag-to-dismiss
  via `pointermove`), centered modal em `lg`. Substitui `inset-0` de
  `TaskEditorModal.tsx`.
- Audit tap targets: `Button.tsx` ganha `min-h-11 min-w-11` por default
  em variant `mobile`; revisar Input, TabPills, FilterPillBar.
- Adicionar variáveis CSS `--safe-top`, `--safe-bottom` em `globals.css`
  baseadas em `env(safe-area-inset-*)`.

**IA nova** (rotas):
- `/` → Chat (mantém)
- `/hoje` → Briefing + Dashboard (renomeia `/visao-geral`; rota antiga
  redireciona)
- `/tarefas` → Tasks (mantém)
- `/financas` → Finance (mantém)
- `/mais` → hub com cards pra Calendar, Hábitos, Conhecimento, Perfil
  (settings). `/calendario` continua acessível direto.

Bottom nav slots: **Aura · Hoje · Tarefas · Finanças · Mais**.

### Fase 2 — `<AuraSphere />` + Chat Refresh

**Objetivo:** substituir o gradiente CSS no chat pela esfera 3D real,
com estados visuais sincronizados com o ciclo de conversa.

**Deps novas** (`apps/aura/frontend/package.json`):
- `three@^0.169` (mesma versão que Seraphine usa, ref CLAUDE memory)
- `@react-three/fiber@^8`
- `@react-three/drei@^9`

**Estrutura** (`src/aura/sphere/`):
```
AuraSphere.tsx        // Canvas + Suspense + DPR clamp + variant
useAuraShader.ts      // hook expõe uniforms como state
shaders/
  aura.vert.glsl      // o vertex shader portado (displaceAura + rim + wave)
  aura.frag.glsl      // pontos
  lines.frag.glsl     // linhas
  dust.{vert,frag}.glsl
  sparkle.{vert,frag}.glsl
geometry/
  buildSphere.ts      // gera 520 pontos via Fibonacci + conexões
audio/
  useAudioLevel.ts    // WebAudio analyser → 0..1 RMS, pra speaking state
```

**API**:
```ts
type AuraState = 'idle' | 'listening' | 'speaking' | 'thinking';
type AuraVariant = 'hero' | 'compact' | 'mini';

<AuraSphere
  variant="hero"       // hero=full canvas, compact=64px, mini=24px inline
  state="idle"
  audioLevel={0..1}    // se speaking
  className="..."
/>
```

**Estados** (cada um modula uniforms, sem reanimar mesh):
- `idle`: defaults (uWaveSpeed 0.105, uWaveStrength 0.115, palette
  blue-cyan).
- `listening`: uWaveSpeed → 0.18, tint quente (mix com `#ffd28a` 25%),
  uMouseRadius global 0.4 (pulso lento no centro mesmo sem mouse).
- `speaking`: uWaveStrength = 0.115 + audioLevel * 0.25, uPointColor
  ganha boost (1.0 → 1.4 multiplier no fragment), edge wave 1.6× speed.
- `thinking`: linhas mais densas (alpha base 0.35), uPointColor = roxo
  `#7da0ff`, edge wave 2× speed.

Transições entre estados: `useSpring` (ou lerp em `useFrame`) com
0.4s ease-out. Nunca hard-cut.

**LOD**:
- Detect: `(devicePixelRatio * window.innerWidth) < 1500` → low-end.
- Low-end: POINT_COUNT 280 (vs 520), dust 200 (vs 460), sparkle 80
  (vs 180). Recomputar `buildSphere` com count menor.
- Em `variant="mini"`: skip dust + sparkle inteiramente.
- Pause `useFrame` quando `document.hidden` (nem invisível dá pra
  desperdiçar bateria).

**Integração com Chat** (`pages/ChatPage.tsx`):
- `EmptyChat()` (linhas 835–848) substitui o gradiente pelo
  `<AuraSphere variant="hero" state="idle" />` ocupando ~60% da
  altura, com texto de boas-vindas embaixo.
- `MobileTopbar` em `/`: `<AuraSphere variant="compact" state={...} />`
  à esquerda. State derivado de:
  - `idle`: nada acontecendo
  - `listening`: STT gravando (já existe via `aura.stt.routes`)
  - `speaking`: SSE streaming chunks chegando → TTS tocando (TTS
    futuro; por enquanto só durante streaming SSE)
  - `thinking`: requisição enviada, aguardando 1º chunk
- Audio level: usar `<audio>` element existente (se houver TTS) com
  `AudioContext` + `AnalyserNode` → RMS por frame em `useAudioLevel`.
  Se não houver TTS hoje, expor stub que retorna 0 e plugar quando
  TTS chegar (sphere fica visível mas sem modular amplitude).

### Fase 3 — Página `/hoje` (Briefing + Dashboard)

**Objetivo:** transformar a tela de entrada do dia. Hoje é grid de
cards genérico; vira **narrativa diária** seguida de KPIs e atalhos.

**Frontend** (`pages/HojePage.tsx`, renomeia `DashboardPage.tsx`):

Layout:
```
[ Hero card — sphere mini + greeting + typewriter narrativo ]
[ KPI grid 2×2 mobile / 4× lg: Tarefas Saúde · Atrasadas · Saldo · Próx Evento ]
[ Próximas tarefas (top 3) → atalho /tarefas ]
[ Últimas transações (top 3) → atalho /financas ]
[ Próximos eventos (top 3) → atalho /calendario ]
```

- **Hero card** (`components/HeroBriefing.tsx`):
  - `<AuraSphere variant="compact" state="speaking" audioLevel={typingLevel} />`
    (audioLevel sintético baseado em chars/seg do typewriter, 0.15–0.4).
  - Greeting dinâmico ("Bom dia, Jonathan", baseado em hora local).
  - Typewriter (18ms/char, igual mockup) renderizando texto vindo do
    backend. Trechos coloridos via tokens inline:
    `[urgent]2 atrasadas[/urgent]`, `[good]+R$ 1.240[/good]`,
    `[blue]reunião às 14h[/blue]`.
  - Botão "Repetir briefing" + "Falar com Aura" (atalho pra `/`).

- **KPIs** (reutiliza `StatCard.tsx`, ajusta cores pros tokens novos).
- **Atalhos**: 3 cards horizontalmente scrolláveis em mobile.

**Backend** (`apps/aura/backend/aura/briefing/`):
- Novo módulo `briefing/routes.py`:
  - `GET /briefing/today` → `{ text: str, segments: [{kind, text}], ttl_seconds: int }`
  - Cacheia por `(user_id, date.today())` em memória (ou na sessão atual)
    — não é dado precioso, regenera no dia seguinte.
- `briefing/service.py`:
  - Coleta read-only: tasks pendentes/atrasadas, saldo do mês corrente,
    próximos 3 eventos do dia, hábitos do dia.
  - Monta prompt: "Você é a Aura. Em 3-4 frases curtas, narre o dia
    do usuário. Use tags `[urgent]`, `[good]`, `[blue]` em trechos
    específicos. Tom caloroso, direto, PT-BR."
  - Chama `AnthropicClient` (já existe), modelo Sonnet (briefing não
    precisa de Opus).
  - Parse das tags → `segments` array pro frontend renderizar com
    cores. Texto cru também devolvido pra fallback.
- Tools: nenhuma. É read-only puro, briefing não escreve nada.

### Fase 4 — PWA + Microinterações

**PWA** (deps: `vite-plugin-pwa`):
- `vite.config.ts`: registrar plugin com `registerType: 'autoUpdate'`,
  `manifest: { name: 'Aura', short_name: 'Aura', theme_color: '#06091A',
  background_color: '#06091A', display: 'standalone', icons: [...] }`.
- Ícones PWA em `public/icons/`: 192, 512, 512-maskable. Geramos via
  script ou um quick-pass no Figma.
- Service worker: precache do shell + runtime cache pra `/api/*` com
  `NetworkFirst`. Sem offline-first real (a Aura precisa de backend).
- iOS install prompt: detect `navigator.standalone === false &&
  /iPhone|iPad/.test(userAgent)`, mostrar overlay um-shot ("Toque em
  Compartilhar → Adicionar à Tela de Início") com checkbox "não mostrar
  de novo" persistido em localStorage.
- Android: `BeforeInstallPromptEvent` capturado, botão flutuante "Instalar
  Aura" no drawer de Mais.

**Microinterações**:
- **Swipe-to-action** em listas de Tarefas e Transações:
  `useSwipe` hook customizado (pointer events, threshold 80px). Esquerda
  = ação primária (concluir / editar), direita = secundária (snooze /
  excluir). Animação spring no transform.
- **Pull-to-refresh** em `/tarefas`, `/financas`, `/hoje`. Hook
  `usePullToRefresh` (touchmove, threshold 60px, callback `onRefresh`).
  Indicador: spinner azul que escala 0→1.
- **Haptic feedback** (`navigator.vibrate(10)`) em swipe action confirmada
  e em botão primário se `'vibrate' in navigator` e mobile.
- **Confetti** mínimo ao concluir última tarefa do dia (já existe a
  contagem; adicionar trigger).

### Fase 5 — Páginas Novas (Hábitos + Conhecimento)

**Objetivo:** preencher os 2 buracos do mockup que valem a pena.
Metas/Lembretes/Lista ficam de fora (vazias ou redundantes).

**Hábitos** (`pages/HabitsPage.tsx`, rota `/mais/habitos`):
- Heatmap 7 colunas (dias da semana) × 26 linhas (~6 meses) — reutiliza
  paleta `mod.habits` em escala de saturação 0..1.
- Health ring: SVG circle com `stroke-dasharray` baseado em
  `done_today / target`.
- Lista de hábitos do dia com toggle inline.
- Backend: novo módulo `apps/aura/backend/aura/habits/` com
  `routes.py` (CRUD básico) e `models.py` (`Habit`, `HabitLog`).
  Schema simples: `habit(id, name, target_per_week, color)` e
  `habit_log(habit_id, date, done)`.

**Conhecimento** (`pages/KnowledgePage.tsx`, rota `/mais/conhecimento`):
- Lista de "cadernos" (notebooks) e brain dumps livres.
- Cada notebook = collection de notas markdown (TipTap já instalado).
- Backend: módulo `apps/aura/backend/aura/knowledge/` com
  `notebook(id, name, color)` e `note(notebook_id, title, content_md,
  created_at)`.
- Search full-text simples (LIKE em SQLite por enquanto; FTS5 depois
  se virar gargalo).

Ambas as features são opt-in: aparecem em `/mais` mas não bloqueiam
nada. Se sobrar tempo, tools de LLM ganham `create_habit_log` e
`add_note_to_notebook` pra Aura conseguir registrar via chat.

## Sem-escopo

- **Rewrite pra Next.js / SSR.** Vite + SPA cobre o caso. SEO não
  importa (app autenticado).
- **Capacitor / Tauri / app nativo.** PWA é o entregável mobile. Se
  precisar de HealthKit/notificações nativas, SDD novo.
- **Multi-tenant / white-label.** A Aura é um produto, não plataforma.
- **Reescrever o backend Python.** Continua FastAPI + SQLite + LLM tools.
  Só ganha módulos novos (briefing, habits, knowledge).
- **Implementar 100% do mockup.** Lembretes (redundante com Tarefas),
  Lista (idem), Metas (vazia, sem fluxo definido) ficam fora.
- **Offline-first sync.** Service worker é install + cache de assets,
  não offline-write. A Aura sem backend não funciona — assumimos online.
- **Voz (TTS) na Aura web.** Sphere já fica pronta pra `audioLevel`,
  mas wiring de TTS de verdade vira SDD próprio (precisa decidir
  provider, custo, voz). Por enquanto sphere fica em `idle` ou
  `thinking` durante streaming.
- **Dark/light theme toggle.** Aura é dark-only (mockup também é).
  Light mode vira SDD se pedido.

## Dependências

- **Novas npm** (`apps/aura/frontend`):
  - `three@^0.169`
  - `@react-three/fiber@^8`
  - `@react-three/drei@^9`
  - `vite-plugin-pwa@^0.20`
  - `workbox-window@^7` (peer do vite-plugin-pwa)
- **Nenhuma nova dep Python.** Briefing usa `AnthropicClient` já
  existente; Habits + Knowledge usam o mesmo `Store` SQLite + Pydantic.
- **Fontes**: Google Fonts (Sora, DM Sans, JetBrains Mono) via `<link>`.
  Sem self-host por enquanto.
- **Specs relacionadas**: nenhuma da Aura ainda. Se houver SDD futuro
  pra TTS, vai consumir `<AuraSphere state="speaking" />` direto.

## Entrega sugerida

| Fase | PR | Estimativa | Risco |
|------|----|------------|-------|
| 1 — Tokens + Mobile shell | 1 PR | 1 dia | Baixo (cosmético + nav) |
| 2 — Sphere + Chat | 1 PR | 1 dia | Médio (perf em low-end mobile) |
| 3 — Briefing + endpoint | 1 PR | 1 dia | Baixo–médio (LLM cost em produção) |
| 4 — PWA + microinterações | 1 PR | meio dia | Baixo |
| 5 — Hábitos + Conhecimento | 1 PR | 1 dia | Baixo (CRUD simples) |

Total ≈ 4–5 dias. Fases 1 e 2 são as core; 3–5 podem fatiar conforme
prioridade.

Cada fase merge → `git push vps main` → docker compose redeploy
(ref `feedback_deploy_push.md`). Smoke test em
https://app.minha-aura.com após cada deploy: abrir em iPhone Safari +
Chrome desktop, validar bottom nav, sphere render, briefing carrega.

## Riscos & mitigações

- **Sphere pesada em mobile low-end.** 520 pontos + 460 dust + 180
  sparkle + shaders custom em iPhone SE pode dar <30fps. Mitigar com
  LOD agressivo (Fase 2 já prevê), `frameloop="demand"` em variant
  `mini`/`compact`, e fallback final pra GIF estático se DPR muito
  baixo.
- **Briefing LLM custo.** Cada usuário gerando briefing diário com
  Sonnet ≈ R$ 0,01–0,03/dia. Cache por (user, date) é mandatório.
  Adicionar feature flag `BRIEFING_ENABLED` no backend pra desligar
  rápido se virar problema.
- **PWA em iOS.** Notificações push não funcionam (limitação Apple),
  install prompt é manual. Documentar isso no overlay iOS pra setar
  expectativa. Não é blocker.
- **Tokens novos quebrando estilos atuais.** Manter aliases deprecated
  (`accent.purple` → mapeia pra `accent.blue` por 1 fase) e migrar usos
  com `git grep` + replace controlado.
- **Bottom nav cobrindo conteúdo.** Padding `pb-[calc(64px+env(safe-area-inset-bottom))]`
  no `<main>`. Auditar páginas com sticky elements (FilterPillBar) pra
  garantir z-index correto.
- **Deploy via VPS rola por commit.** Push direto na `vps main` redeploya
  prod. Cada fase deve ser merged + smoke-tested ANTES da próxima começar
  (sem stack de PRs sobre Aura simultaneamente).

## Testes

Cobertura mínima por fase:

- **Fase 1**: Vitest snapshot do `<BottomNav />` em 5 estados ativos.
  Manual: abrir em iPhone Safari real + Android Chrome real, validar
  safe-area + tap targets.
- **Fase 2**: Vitest unit do `useAuraShader` (uniforms mudam conforme
  state). Lighthouse perf score em mobile mid-tier > 70 com sphere
  ativa. Manual: 60fps no Pixel 7, 30fps mínimo no iPhone SE.
- **Fase 3**: Pytest do `briefing/service.py` com mock LLM (verificar
  que segments parseiam corretamente, urgent/good/blue cores aplicam).
  E2E (Playwright): abrir `/hoje`, esperar typewriter terminar,
  verificar 4 KPIs renderizam.
- **Fase 4**: PWA install simulado via Lighthouse PWA audit (score 100).
  Manual: instalar em iPhone via Safari → Adicionar à tela, abrir,
  validar splash + standalone.
- **Fase 5**: Pytest CRUD de habits e notes. Vitest do heatmap (input
  determinístico → DOM esperado). E2E: criar hábito, marcar feito,
  recarregar, verificar persistência.
