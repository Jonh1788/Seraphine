# Seraphine Mobile — Fase 1: Fundação (shell + Hoje + Mais)

**Data:** 2026-07-13
**Status:** Aprovado (aguardando review da spec)

## Problema / motivação

O handoff `apps/seraphine/frontend/handoff_mobile/` traz o redesign iOS completo (20 telas, Obsidian). Hoje o iPhone roda o MESMO `<App/>` desktop (o `main.tsx` estampa `data-shell="phone"`, mas nada o consome de forma estrutural; `MobileShell.tsx` é legado órfão, não montado). Resultado: no iPhone a experiência é o layout desktop denso.

20 telas não cabem num spec. Decomposição aprovada em fases — **esta spec cobre só a Fase 1 (Fundação)**:

- **Fase 1 (esta):** shell phone (tab bar + orb + safe areas + navegação empurrada) + telas **Hoje** e **Mais**; tabs interinas abrem as views existentes.
- Fase 2: Chat mobile + Tarefas. Fase 3: Trilhas mobile. Fase 4: módulos (Finanças/Hábitos/Diário/Inbox + empurradas). Fase 5: Voz + Onboarding.
- **Fora do roadmap webview:** lock screen widget + notificação rica (WidgetKit/Swift nativo) e wake word iOS (tela 20 do handoff).

## Decisões (brainstorm)

1. **Fase 1 = Fundação:** shell + Hoje + Mais (esqueleto onde as fases seguintes penduram).
2. **Tela Hoje com os 4 blocos** do handoff: Seraphine sugere, Agenda, Tarefas+Hábitos, Orçamento.
3. **Tabs interinas (Tarefas/Chat/Trilhas) abrem as views existentes** (desktop-styled) dentro do shell — tudo funciona desde o dia 1; as fases seguintes só melhoram o visual.
4. **Arquitetura A:** módulo novo `src/mobile/` gateado por `data-shell="phone"`; `AppLayout` desktop intocado (zero risco de regressão).

## Contexto do código (na main)

- `src/main.tsx:25-43` — `detectShell()` já estampa `data-shell="phone|tablet|desktop"` no `<html>`. É o gate.
- `src/App.tsx` — componente raiz que monta `AppLayout`; ponto onde o branch phone entra.
- `src/MobileShell.tsx` — legado órfão (238 linhas, HealthKit-sync); NÃO é montado por ninguém. Fica intocado nesta fase (remoção futura).
- Views existentes reutilizáveis: `chat/ChatView`, `tasks` (TasksView), `courses/TrilhasView`, `finance`, `habits`, `journal`, `insights`, `memory`, `notes`, `calendar` — todas recebem `onBack` ou equivalente (verificar assinatura por view na implementação).
- APIs: `/calendar`, `/habits`, `/notifications`, `/proactive`, `/courses/stats` (XP/streak), tasks e finanças (módulos `mod_tasks`/`mod_finance`) — nenhum backend novo é necessário.
- Design system: tokens em `src/styles.css` (idênticos ao handoff), ícones SVG em `src/icons/Icons.tsx` (NUNCA emoji), fonte Schibsted Grotesk já carregada.
- Referência de design: `handoff_mobile/README.md` (spec textual) + `handoff_mobile/Seraphine Mobile.dc.html` (20 frames hi-fi inline-styled; localizar frame por rótulo de texto).

## Arquitetura

```
main.tsx (inalterado) ── data-shell="phone" ──▶ App.tsx
                                                 ├─ phone?  <PhoneShell/>   (src/mobile/)
                                                 └─ senão   <AppLayout/>    (intocado)

PhoneShell — estado { tab: 'hoje'|'tarefas'|'chat'|'trilhas'|'mais', pushed: Pushed | null }
  ├─ área de conteúdo (safe-area top ~56px)
  │    ├─ tab hoje     → <HojeScreen/>                     (nova)
  │    ├─ tab tarefas  → <TasksView/>   embrulhada         (existente)
  │    ├─ tab chat     → <ChatView/>    embrulhada         (existente)
  │    ├─ tab trilhas  → <TrilhasView/> embrulhada         (existente)
  │    ├─ tab mais     → <MaisScreen onOpen={push}/>       (nova)
  │    └─ pushed       → <PushedScreen title onBack>{view existente}</PushedScreen>
  │                        (header ‹ voltar, SEM tab bar)
  └─ <TabBar/> (safe-area bottom +30px; oculta quando pushed)
```

## Componentes (`src/mobile/`)

### 1. `PhoneShell.tsx`
- Estado local `{ tab, pushed }`. `pushed = { key: string, title: string } | null` — pilha de 1 nível no v1 (módulos do Mais).
- Gate no `App.tsx`: `document.documentElement.dataset.shell === 'phone'` → renderiza `<PhoneShell/>` (uma linha de branch; `AppLayout` permanece o caminho default).
- Importa `./obsidian.css` (per-feature, padrão do repo).

### 2. `TabBar.tsx`
- 5 posições: Hoje · Tarefas · **Chat central elevado** · Trilhas · Mais.
- Chat = orb 56px, `margin-top:-22px`, sombra `0 6px 20px rgba(154,147,255,.4)` + anel `0 0 0 5px var(--app)`.
- Fundo `--nav`, borda superior `--border`; ativa = `--accent` 700, inativa = `--text-faint` 600; ícones stroke 1.7 (SVG de `Icons.tsx`), labels 10px.
- Padding inferior `calc(10px + env(safe-area-inset-bottom))`.

### 3. `Orb.tsx` (identidade)
- Props: `size` (20–158), `float?: boolean`, `halo?: boolean`.
- Esfera em camadas (verbatim do handoff): `radial-gradient(circle at 32% 26%, #efedff 0%, #cac5ff 22%, #9a93ff 55%, #4d45b8 85%, #332d85 100%)` + inset duplo (`inset -5px -7px 14px rgba(15,10,60,.55)`, `inset 3px 4px 8px rgba(255,255,255,.35)`) + glow `rgba(154,147,255,.45)` + brilho especular (elipse branca blur, rotate -24°).
- `float` → `orbFloat` 5s; `halo` → conic-gradient girando atrás (`orbSpin` 6s, blur 7px). Keyframes no `mobile/obsidian.css`.

### 4. `HojeScreen.tsx` — 4 blocos, cada um componente isolado com fetch próprio e fail-soft (erro/vazio → bloco não renderiza; a tela nunca quebra)
- **Header:** orb 38px + "Bom dia/Boa tarde/Boa noite" (saudação por hora local). SEM sino no v1 (não há view de notificações mobile; entra na Fase 4).
- **SugereCard:** card gradiente `rgba(154,147,255,.14→.04)`, borda `rgba(154,147,255,.22)`, sparkle SVG + texto + ações **Resolver** / **Depois**. Fonte: primeiro item não-lido de `/notifications` (única fonte no v1; `/proactive` fica pra depois). **Resolver** → abre a view alvo da notificação como pushed (mapeamento por tipo; tipo sem view → botão vira "Ver" abrindo o módulo mais próximo) e marca lida via API se o endpoint existir. **Depois** → dispensa local (localStorage, chave por id+dia). Sem itens → bloco some.
- **AgendaBlock:** eventos de hoje de `/calendar` (hora + título + cor de categoria, border-left colorida). Máx 4, "+N".
- **TarefasHabitosRow:** duas colunas — top 3 tarefas de hoje (checkbox 22px, toque conclui via API) e anel de hábitos (progresso feito/total do dia, ex. 4/5) com link pro módulo.
- **OrcamentoBlock:** barra compacta gasto-do-mês vs orçamento (API de finanças; se não houver orçamento configurado, mostra só o total gasto).

### 5. `MaisScreen.tsx`
- **Perfil:** orb 42px + nome + pills XP/streak (`/courses/stats`, reusa `.tr-pill--xp/--streak` do reskin Trilhas) + engrenagem (abre o Settings drawer existente, se acessível; senão omite no v1).
- **Grid 2-col de módulos:** Finanças, Hábitos, Diário, Inbox, Calendário, Memória, Insights, Notas — card `--surface` com ícone SVG colorido; toque → `push({key, title})` → view existente correspondente numa `PushedScreen`. Status ao vivo/badges ficam pra Fase 4 (YAGNI no v1).

### 6. `PushedScreen.tsx`
- Header fixo: ‹ (ArrowLeftIcon, alvo ≥44px) + título; conteúdo = view existente com `onBack` apontando pro pop. Sem tab bar (o shell esconde quando `pushed != null`).

### 7. `mobile/obsidian.css`
- Safe areas, tab bar, orb (+keyframes `orbFloat`/`orbSpin`), cards Hoje/Mais, pushed header. Tokens do design system; alvos de toque ≥44px; cards raio 15–18 padding 13–16 (handoff).
- Guarda-chuva: TODAS as regras sob `html[data-shell='phone']` (ou classe raiz `.mshell`) pra nunca vazar pro desktop/tablet.

## Dados / erros

- Nenhuma API nova. Todos os fetches são read-only exceto: concluir tarefa (API tasks existente) e dispensa do SugereCard (localStorage, não muta backend).
- Fail-soft por bloco: cada bloco do Hoje trata erro/loading/vazio isoladamente; shell e tab bar nunca dependem de rede.
- Views embrulhadas mantêm seus próprios estados/fetches — o shell não intercepta nada.
- Tablet (`data-shell="tablet"`) segue no `AppLayout` desktop nesta fase (decisão explícita; revisitar depois).

## Fora de escopo (Fase 1)

Redesenho mobile de Chat/Tarefas/Trilhas (F2-3); Finanças/Hábitos/Diário/Inbox mobile + Memória/Calendário/Insights/WhatsApp empurradas redesenhadas (F4); Voz e Onboarding (F5); widget/notificação rica/wake word (nativo, fora do webview); badges/status ao vivo no grid do Mais; sino/notificações push; remoção do `MobileShell.tsx` legado.

## Testes

- `pnpm exec tsc --noEmit` limpo; vitest existente verde (nada de courses/grading tocado).
- Unit (vitest): helpers puros se surgirem (ex. saudação por hora); render smoke do `TabBar` (tab ativa + orb central) e do gate do `App` (phone → PhoneShell, desktop → AppLayout) com `data-shell` mockado.
- Manual: `pnpm dev` + devtools em modo iPhone (UA/touch) → shell aparece; desktop normal → `AppLayout` intocado. Depois `pnpm tauri ios dev` no simulador pra validar safe areas reais.
- Zero emoji (grep gate); zero regressão desktop (nenhum arquivo do AppLayout tocado além do branch de 1 linha no App.tsx).
