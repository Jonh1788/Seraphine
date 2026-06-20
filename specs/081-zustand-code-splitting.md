# 081 - Zustand + Code Splitting

## Objetivo

Eliminar o monolito de estado em `App.tsx` (1700+ linhas) migrando todo o state management para stores Zustand por dominio, e habilitar code-splitting via React Router para que views pesadas (Lab, Finance, Avatar) sejam carregadas sob demanda.

## Motivacao

- `App.tsx` concentra 16 views, ~30 useState, WebSocket, audio pipeline, avatar ref, focus timer, wake word, onboarding. Qualquer mudanca nele causa re-render do app inteiro.
- Sem React Router, nao ha deep-linking real, browser back/forward, nem lazy loading por rota.
- Prop-drilling de 3+ niveis (App -> View -> Component) dificulta manutencao.

## Entregas

1. **Zustand stores por dominio**
   - `useUiStore` — activeView, theme, sidebarOpen, modals
   - `useChatStore` — messages, conversationId, draft, streamingState
   - `useRealtimeStore` — realtimeMode, talkState, vadState, wakeWordEnabled
   - `useAvatarStore` — avatarUrl, controllerRef, labOpen
   - `useAudioStore` — vpioSession, playback, micCapture, focusMusic
   - `useHealthStore` — todaySnapshot, waterIntake
   - `useNotificationStore` — unreadCounts (email, whatsapp, tasks, inbox)
   - Cada store com selectors granulares para evitar re-renders desnecessarios.

2. **React Router com lazy loading**
   - Substituir `activeView` state por `react-router-dom` v6 com `createBrowserRouter`.
   - Chat permanece always-mounted via layout route (Outlet + CSS visibility, preservando WS/scroll).
   - Views pesadas (`AvatarLab`, `AnimationLab`, `FinanceDashboard`, `FlashcardsView`) carregadas via `React.lazy`.
   - Deep-linking para `/:view`, `/:view/:id` (ex: `/tasks/abc123`, `/notes/xyz`).
   - Redirect `/` -> `/dashboard`.

3. **Migrar App.tsx**
   - `App.tsx` reduzido a: RouterProvider + layout shell (nav rail, top bar).
   - Hooks de lifecycle (WS connect, audio warmup, push subscribe) movidos para um `<AppBootstrap>` provider no layout.
   - Keyboard shortcuts registrados via `useEffect` no layout, despachando para os stores.

4. **Preservar compatibilidade**
   - `?view=tasks&focus=<id>` redireciona para `/tasks/<id>`.
   - `localStorage` keys migradas automaticamente (one-time migration no AppBootstrap).

## Limites

- Nao migrar a logica do WebSocket client (SeraphineWS) nesta iteracao — wrapper em `useChatStore` que delega para a instancia existente.
- Nao refatorar componentes filhos (ChatView, TasksView, etc.) — apenas trocar props por hooks de store.
- Nao adicionar SSR ou framework (Next/Remix). Continua SPA puro.

## Ordem de execucao

1. Instalar zustand + react-router-dom
2. Criar stores com estado inicial copiado de App.tsx
3. Criar layout route com nav rail + Outlet
4. Migrar views uma a uma (dashboard primeiro, chat por ultimo)
5. Remover props de App.tsx conforme cada view migra
6. Adicionar lazy() nas views pesadas
7. Smoke test de todas as 16 views + keyboard shortcuts

## Criterios de aceite

- `App.tsx` tem menos de 200 linhas.
- Nenhum prop drilling de App para views.
- Browser back/forward navega entre views.
- `/tasks/abc123` abre direto na task.
- Bundle da rota inicial (dashboard) nao inclui codigo do AvatarLab.
- Todos os testes existentes passam.
