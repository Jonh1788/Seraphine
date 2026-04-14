# seraphine-web

React + Vite + TypeScript webapp for Projeto Seraphine.

## Setup

```bash
pnpm install
```

## Run

```bash
pnpm dev          # http://localhost:5173
```

Set `VITE_WS_URL` to override the backend WebSocket URL (default: `ws://localhost:8000/ws/conversation`).

## Test

```bash
pnpm test
```

## Layout

```
src/
  main.tsx
  App.tsx
  ws/             WebSocket client + types (Phase 0+)
  audio/          Mic capture + playback (Phase 2)
  avatar/         AvatarAdapter + VrmAvatar (Phase 3)
  chat/           Chat view (Phase 1)
  tools/          Approval panel (Phase 4)
```
