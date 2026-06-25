# Frontend Performance — Seraphine

**Date:** 2026-06-25
**Status:** Design approved, pending spec review
**Scope:** Frontend React + Three.js avatar lifecycle. No backend changes.

## Problem

Two symptoms, one shared root cause and several independent contributors:

1. **Closing and reopening the Tauri window freezes the app** (most acute in dev).
2. **General frontend jank / sustained CPU·GPU load** while navigating.

### Root cause (the freeze)

The `main` window is **never destroyed on close**. `src-tauri/src/lib.rs:334` intercepts
`WindowEvent::CloseRequested` and does `window.hide()` + `api.prevent_close()` (close-to-tray;
the only real quit is the tray "Sair" → `app.exit(0)`). The webview, its WebGL context, and the
avatar's `requestAnimationFrame` loop **stay alive while the window is hidden**. On top of that:

- **The avatar RAF loop never pauses on hide/visibility change.** `avatar/VrmAvatarController.ts`
  has a working `setRenderPaused()` but it is only wired in the separate companion window
  (`avatar-companion/AvatarCompanion.tsx`), for native drag. The main window's controller keeps
  running while hidden; macOS throttles the WebView render thread, and on restore `clock.getDelta()`
  floods catch-up. (A 100ms delta clamp at `VrmAvatarController.ts:525` softens animation jump but
  does not stop the loop or the throttle/restore cycle.)
- **The WebGL context is never truly released.** `dispose()` (`VrmAvatarController.ts:1833`) calls
  `renderer.dispose()` (frees GPU programs) but **not** `renderer.forceContextLoss()`. Repeated
  mount→unmount / hide→show cycles accumulate orphaned contexts; WebViews cap live WebGL contexts
  (~16), after which creation stalls — a freeze.
- **No `webglcontextlost` / `webglcontextrestored` handling** anywhere (grep: zero matches). If the
  WebView reclaims a context, the loop renders into a dead context.

### Independent frontend contributors

- **Avatar renders forever even when hidden.** `VrmAvatar` is mounted once in `AppLayout.tsx:430`
  inside the sidebar and only hidden via CSS (`sidebar--hidden`) on the ~24 non-chat views. It is
  visible only in the chat view, yet burns a full RAF (mixer + IK + spring bones + render) in every
  other view. Single biggest always-on cost.
- **Zero `React.memo` in the codebase + a monolithic `AppLayout`.** `AppLayout.tsx` reads ~45 zustand
  selectors (lines 91-155) and rebuilds a 25-entry `navItems` array with inline closures/JSX
  (278-319) on every render. `useFocusTimer` (181) ticks ~1×/s and re-renders the entire 780-line
  shell — which hosts the always-mounted, 1591-line `ChatView` (494-534), re-rendering it too
  (including `turns.map`). Notification pushes and the 60s `tasksPendingCount` poll do the same.

### What is already fine (do not touch)

zustand fine-grained selectors, `RefsContext` (stable refs, never re-renders), the single WebSocket
in `ws/client.ts`, and all timer/listener/WS cleanup are correct. This is a targeted optimization,
not a refactor.

## Design

Three independent blocks, implemented and verified in order A → B → C (risk increases per block).

### Block A — Fix the window close/reopen freeze

**A1. Pause RAF on hide / visibility change.** In `VrmAvatarController.ts`, register a
`document.visibilitychange` listener (and Tauri window blur/focus if cheaper/more reliable in the
Tauri webview) that calls the existing `setRenderPaused(document.hidden)`. Store the listener
reference and remove it in `dispose()`. Eliminates the throttle/catch-up flood on restore.

**A2. Release the WebGL context on dispose.** In `dispose()`, after `renderer.dispose()`, call
`renderer.forceContextLoss()` and then drop the renderer reference (`this.renderer = null!` or guard
later use). Stops context accumulation across hide/show and mount/unmount cycles.

**A3. Handle context loss/restore.** On the canvas, add:
- `webglcontextlost` → `event.preventDefault()` + pause the loop (set a `contextLost` flag the loop
  checks alongside `renderPaused`).
- `webglcontextrestored` → clear the flag and resume; if Three.js state cannot be trusted, signal the
  React layer (via the existing `onReady`/controller channel) to recreate the controller.
- Remove both listeners in `dispose()`.

### Block B — Stop the avatar rendering outside chat

**B1.** In `AppLayout`, drive the avatar's pause state from `activeView`:
`avatarCtrlRef.current?.setRenderPaused(activeView !== 'chat')`. Apply via an effect on `activeView`
(and once on avatar-ready, so it starts paused if the app opens on a non-chat view). The avatar is
only visible in chat, so this is safe and high-value.

Note: `setRenderPaused(true)` short-circuits per-frame work but the RAF chain keeps requesting frames
(doing nothing). That is acceptable (browser throttles a no-op RAF). Combined with A1, a hidden +
non-chat avatar does essentially no work.

### Block C — Cut shell re-renders

**C1. Scope the focus timer.** Move `useFocusTimer` consumption out of `AppLayout` into leaf
components — the topbar `FocusPill` and the sidebar Pomodoro card — so the ~1×/s tick re-renders
only those leaves, not the shell + ChatView.

**C2. Memoize the always-mounted chat surface.** Wrap `ChatView` in `React.memo`, and the chat blocks
it renders (`TaskChatBlock`, `NoteChatBlock`, and siblings in `chat/`). Stabilize the props/callbacks
`AppLayout` passes to `ChatView` with `useCallback`/`useMemo` so the memo actually holds.

**C3. Memoize `navItems`.** Wrap the 25-entry `navItems` construction in `AppLayout` in `useMemo`
keyed on the few values it actually depends on, so it is not rebuilt with fresh closures every render.

## Validation

Each block is independently testable; verify before moving to the next.

- **A** — Close and reopen the main window ~10× in dev; confirm no freeze. In DevTools, watch live
  WebGL context count stay flat across cycles (it should not climb). Confirm the avatar resumes
  cleanly without a pose jump after restore.
- **B** — Navigate Chat → Tasks → Finance → Maestro. In React DevTools / Activity Monitor (or
  `chrome://gpu`-style stats via DevTools), confirm GPU/CPU from the avatar drops to ~0 outside chat
  and recovers on return to chat.
- **C** — React DevTools Profiler: start a focus session and trigger a notification push; confirm
  `AppLayout` and `ChatView` do **not** re-render on each timer tick / push (only the relevant leaves
  do).

## Out of scope

- Backend / chat / STT-TTS / deepsearch latency.
- View-switch re-fetch cost (non-chat views unmount and re-init on every visit) — correct behavior,
  not a leak; revisit only if it proves to be a real stall after A/B/C.
- The avatar-companion window's existing drag-pause logic (already works; only reuse its
  `setRenderPaused` mechanism).

## Risk notes

- A3 context-restore may require recreating the controller rather than reusing Three.js state; design
  the React signal path (B already centralizes the controller in `AppLayout` state + `RefsContext`)
  so a clean recreate is possible.
- C2 memoization can mask stale closures if props are not properly stabilized — verify with the
  Profiler that updates still propagate (new messages still render) after wrapping.
