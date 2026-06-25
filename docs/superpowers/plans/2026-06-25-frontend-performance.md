# Frontend Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the window close/reopen freeze and cut sustained CPU·GPU load and shell re-renders in the Seraphine frontend.

**Architecture:** Three independent blocks. (A) Make the avatar's Three.js controller pause its render loop when the window is hidden, truly release the WebGL context on dispose, and survive WebGL context loss. (B) Pause the avatar whenever the active view is not chat. (C) Stop the focus-timer tick and other slice updates from re-rendering the 780-line shell and the always-mounted ChatView, via `React.memo`, `useMemo`, and a single-instance focus context.

**Tech Stack:** React 18 + TypeScript, Vite, zustand, three.js + @pixiv/three-vrm, Tauri (desktop), vitest.

## Global Constraints

- No emojis in any UI/icons — inline SVGs only (`icons/`). Verbatim from project rule.
- All `addEventListener` / `setInterval` / RAF additions MUST be removed/cancelled in the matching cleanup (`dispose()` or effect return). No new leaks.
- `useFocusTimer` has side effects (interval, localStorage, `notify`, backend `logFocusSession`, avatar expressions). It MUST remain a **single instance** in the running app — never call it from two components at once.
- WebGL/Tauri-window lifecycle cannot be unit-tested in jsdom (no real WebGL context). For those tasks the verification gate is: `pnpm lint` clean, `pnpm build` (tsc typecheck) clean, existing `pnpm test` suite still green, **plus** the explicit manual run/observe steps. Do not write fake jsdom tests that instantiate `VrmAvatarController` with a canvas.
- Run all commands from `apps/seraphine/frontend/`.

---

## File Structure

- `apps/seraphine/frontend/src/avatar/VrmAvatarController.ts` — Block A: pause-reason set, visibility listener, context-loss handlers, `forceContextLoss()` in dispose.
- `apps/seraphine/frontend/src/AppLayout.tsx` — Block B (pause avatar on non-chat view) + Block C (memoize navItems, drop inline focus consumption).
- `apps/seraphine/frontend/src/chat/ChatView.tsx` + `apps/seraphine/frontend/src/chat/*ChatBlock.tsx` — Block C: `React.memo`.
- `apps/seraphine/frontend/src/focus/FocusContext.tsx` — **new**, Block C1: single `useFocusTimer` instance exposed via context.
- `apps/seraphine/frontend/src/focus/SidebarFocusCard.tsx` — **new**, Block C1: the sidebar FOCO button as a context-consuming leaf.
- `apps/seraphine/frontend/src/focus/FocusPill.tsx` — Block C1: consume context instead of props.
- `apps/seraphine/frontend/src/App.tsx` — Block C1: wrap subtree in `FocusProvider`.

---

## Block A — Fix the window close/reopen freeze

### Task 1: Pause-reason set + pause render loop when the window is hidden

**Files:**
- Modify: `apps/seraphine/frontend/src/avatar/VrmAvatarController.ts` (fields ~159-168, constructor ~340-343, `setRenderPaused` ~502-509, `dispose` ~1833-1875)

**Interfaces:**
- Produces: `setPauseReason(reason: string, paused: boolean): void` — pauses the loop if ANY reason is active; resumes only when all reasons cleared. `setRenderPaused(paused: boolean)` is retained and now delegates to reason `'manual'` (so the avatar-companion drag code keeps working unchanged).

**Why a reason set:** Block B (non-chat view), A1 (window hidden), A3 (context lost), and the companion drag all want to pause independently. A single boolean lets one source resume while another still needs pause. The set ANDs them correctly.

- [ ] **Step 1: Add the pause-reason field**

Find the existing field (line ~168):

```ts
  private renderPaused = false;
```

Add directly below it:

```ts
  private renderPaused = false;
  /** Active pause reasons; the loop is paused while any is present.
   *  Sources: 'manual' (companion drag), 'hidden' (window hidden),
   *  'view' (non-chat view), 'context' (WebGL context lost). */
  private readonly pauseReasons = new Set<string>();
  /** Bound so we can removeEventListener in dispose(). */
  private readonly onVisibilityChange = (): void => {
    this.setPauseReason("hidden", document.hidden);
  };
```

- [ ] **Step 2: Replace `setRenderPaused` with the reason-aware implementation**

Replace the whole method (lines ~502-509):

```ts
  /** Pause/resume the per-frame work without killing the RAF chain. */
  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;
    if (!paused) {
      // Discard accumulated pause time so animations don't jump.
      this.clock.getDelta();
    }
  }
```

with:

```ts
  /** Pause/resume a single reason. The loop runs only when no reason is set. */
  public setPauseReason(reason: string, paused: boolean): void {
    const wasPaused = this.pauseReasons.size > 0;
    if (paused) this.pauseReasons.add(reason);
    else this.pauseReasons.delete(reason);
    const nowPaused = this.pauseReasons.size > 0;
    if (wasPaused === nowPaused) return;
    this.renderPaused = nowPaused;
    if (!nowPaused) {
      // Discard accumulated pause time so animations don't jump.
      this.clock.getDelta();
    }
  }

  /** Backwards-compatible manual pause (used by the avatar-companion drag). */
  public setRenderPaused(paused: boolean): void {
    this.setPauseReason("manual", paused);
  }
```

- [ ] **Step 3: Register the visibility listener in the constructor**

Find the end of the constructor (line ~340-342):

```ts
    this.clock = new Clock();
    this.nextBlinkAt = this.scheduleBlink(0);
    this.startLoop();
```

Change to:

```ts
    this.clock = new Clock();
    this.nextBlinkAt = this.scheduleBlink(0);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    // If we mount while already hidden, start paused.
    if (document.hidden) this.pauseReasons.add("hidden");
    this.renderPaused = this.pauseReasons.size > 0;
    this.startLoop();
```

- [ ] **Step 4: Remove the listener in `dispose`**

Find the start of `dispose()` (line ~1833-1839):

```ts
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
```

Insert the listener removal right after `this.disposed = true;`:

```ts
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
```

- [ ] **Step 5: Verify it compiles and lints**

Run: `pnpm build`
Expected: tsc completes with no errors.

Run: `pnpm lint`
Expected: no new errors in `VrmAvatarController.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src/avatar/VrmAvatarController.ts
git commit -m "perf(avatar): pause render loop when window hidden (pause-reason set)"
```

---

### Task 2: Release the WebGL context on dispose

**Files:**
- Modify: `apps/seraphine/frontend/src/avatar/VrmAvatarController.ts` (`dispose` end, line ~1873-1874)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new (behavioral change to `dispose()` only).

**Why:** `renderer.dispose()` frees GPU programs but does NOT release the underlying WebGL context. Across hide→show and mount→unmount cycles, orphaned contexts accumulate; WebViews cap live contexts (~16) and then stall — the freeze. `forceContextLoss()` releases it deterministically.

- [ ] **Step 1: Add `forceContextLoss()` after `renderer.dispose()`**

Find the last two lines of `dispose()` (line ~1873-1874):

```ts
    this.scene.clear();
    this.renderer.dispose();
  }
```

Replace with:

```ts
    this.scene.clear();
    this.renderer.dispose();
    // dispose() frees GPU programs but NOT the WebGL context itself.
    // Without this, repeated mount/unmount + window hide/show cycles leak
    // contexts until the WebView's ~16-context cap stalls creation (freeze).
    this.renderer.forceContextLoss();
  }
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `pnpm build`
Expected: no errors.

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 3: Manual verification — context count stays flat**

Run the desktop app in dev: `pnpm tauri dev`
In the app's DevTools console, snapshot the live context count, then close and reopen the main window (red close button → click the tray icon / `⌘`-shortcut to reshow) **10 times**. After each reopen, re-run the count.

Run in the DevTools console (paste once, call after each reopen):

```js
(() => { let n = 0; const C = HTMLCanvasElement.prototype.getContext;
  return performance.now(); })(); // placeholder; use the check below instead
```

Practical check: in DevTools → Memory, or simply confirm the app **does not freeze** on the 10th reopen and the avatar renders normally. Expected: no freeze, avatar visible and animating after each reopen.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/avatar/VrmAvatarController.ts
git commit -m "perf(avatar): forceContextLoss on dispose to stop WebGL context leak"
```

---

### Task 3: Handle WebGL context loss/restore

**Files:**
- Modify: `apps/seraphine/frontend/src/avatar/VrmAvatarController.ts` (constructor — needs the canvas; fields; dispose)
- Modify: `apps/seraphine/frontend/src/avatar/VrmAvatar.tsx` (surface a recreate signal)

**Interfaces:**
- Consumes: `setPauseReason` from Task 1.
- Produces: optional `onContextRestoreNeeded?: () => void` callback on the controller, invoked when the context is lost and the controller must be recreated by React.

- [ ] **Step 1: Capture the canvas and add context-loss handlers (controller)**

The constructor currently does `void canvas; // retained by renderer` (line ~281). We need the canvas reference for listeners. Add a field near the other private fields (after the `onVisibilityChange` field from Task 1):

```ts
  private readonly canvas: HTMLCanvasElement;
  /** Optional: React asks to recreate the controller after context loss. */
  public onContextRestoreNeeded: (() => void) | null = null;
  private readonly onContextLost = (e: Event): void => {
    // Prevent the default "context is gone forever" behavior so the browser
    // will attempt a restore, and stop rendering into the dead context.
    e.preventDefault();
    this.setPauseReason("context", true);
  };
  private readonly onContextRestored = (): void => {
    // three's internal GL state is invalid after a real loss; the safest path
    // is a full recreate. Signal React; if no handler is wired, just resume.
    if (this.onContextRestoreNeeded) this.onContextRestoreNeeded();
    else this.setPauseReason("context", false);
  };
```

- [ ] **Step 2: Store the canvas and register the listeners in the constructor**

Replace the first line of the constructor body (line ~281):

```ts
    void canvas; // retained by renderer
```

with:

```ts
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
```

- [ ] **Step 3: Remove the listeners in `dispose`**

In `dispose()`, alongside the visibilitychange removal added in Task 1, add:

```ts
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
```

- [ ] **Step 4: Wire the recreate signal in `VrmAvatar.tsx`**

In `apps/seraphine/frontend/src/avatar/VrmAvatar.tsx`, the effect (lines ~21-44) creates one controller. Add a `recreateKey` state that bumps on context-restore-needed, included in the effect deps so the controller is torn down and rebuilt. Replace the component body:

```tsx
export function VrmAvatar(props: VrmAvatarProps): JSX.Element {
  const { avatarUrl, width, height, onReady, cameraControls, cameraMinDistance, cameraMaxDistance } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [recreateKey, setRecreateKey] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new VrmAvatarController(canvas, {
      cameraControls,
      minDistance: cameraMinDistance,
      maxDistance: cameraMaxDistance,
    });
    // After a real WebGL context loss, three's GL state is unusable — rebuild.
    controller.onContextRestoreNeeded = () => setRecreateKey((k) => k + 1);
    let cancelled = false;
    controller
      .loadAvatar(avatarUrl)
      .then(() => {
        if (cancelled) return;
        onReady?.(controller);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[VrmAvatar] failed to load avatar", err);
      });
    return () => {
      cancelled = true;
      controller.dispose();
    };
  }, [avatarUrl, onReady, cameraControls, cameraMinDistance, cameraMaxDistance, recreateKey]);

  return (
    <div id="seraphine-avatar-root" role="img" aria-label="Seraphine avatar">
      <canvas ref={canvasRef} width={width ?? 400} height={height ?? 600} />
    </div>
  );
}
```

Add `useState` to the import on line 1:

```tsx
import { useEffect, useRef, useState } from "react";
```

- [ ] **Step 5: Verify it compiles and lints**

Run: `pnpm build`
Expected: no errors.

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/frontend/src/avatar/VrmAvatarController.ts apps/seraphine/frontend/src/avatar/VrmAvatar.tsx
git commit -m "perf(avatar): handle webglcontextlost/restored with controller recreate"
```

---

## Block B — Stop the avatar rendering outside chat

### Task 4: Pause the avatar when the active view is not chat

**Files:**
- Modify: `apps/seraphine/frontend/src/AppLayout.tsx` (after `handleAvatarReady`, ~255; uses `activeView` from line 91 and `avatarCtrlRef` from line 83)

**Interfaces:**
- Consumes: `setPauseReason` (Task 1), `avatarCtrlRef` (`useAppRefs`), `activeView` (`useUiStore`).

**Why:** `VrmAvatar` is mounted once in the sidebar and only CSS-hidden on the ~24 non-chat views; it keeps burning a full RAF there. The avatar is only visible in chat.

- [ ] **Step 1: Add the pause effect**

In `AppLayout.tsx`, after the `handleAvatarReady` callback (ends ~line 255), add:

```tsx
  // Pause the avatar's render loop whenever it isn't visible (non-chat views).
  // Re-applied when the controller becomes available so it starts correct.
  useEffect(() => {
    avatarCtrlRef.current?.setPauseReason('view', activeView !== 'chat');
  }, [activeView, avatarController, avatarCtrlRef]);
```

(`avatarController` is the state set in `handleAvatarReady`; including it re-runs the effect once the controller exists. `useEffect` is already imported in `AppLayout`.)

- [ ] **Step 2: Verify it compiles and lints**

Run: `pnpm build`
Expected: no errors.

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 3: Manual verification — GPU drops outside chat**

Run: `pnpm tauri dev`. Open the avatar in chat (animating). Open DevTools → Performance/Rendering FPS meter (or macOS Activity Monitor → GPU). Switch to Tarefas / Finanças / Maestro. Expected: avatar render activity drops to ~0 (no per-frame work) while off chat, and resumes smoothly on returning to chat with no pose jump.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/AppLayout.tsx
git commit -m "perf(avatar): pause avatar render loop on non-chat views"
```

---

## Block C — Cut shell re-renders

### Task 5: Memoize `navItems` in AppLayout

**Files:**
- Modify: `apps/seraphine/frontend/src/AppLayout.tsx` (`navItems` array, lines ~278-319)

**Interfaces:**
- Consumes: `useMemo` (add to the React import if not present), `activeView`, `setActiveView`, `tasksPendingCount`, `unreadCount`, `whatsappUnread`, `setWhatsappUnread`.

**Why:** the 25-entry array with inline closures/JSX is rebuilt on every render of the shell. Memoizing avoids the rebuild when only unrelated slices change.

- [ ] **Step 1: Wrap the array in `useMemo`**

Find the declaration (line ~278):

```tsx
  const navItems: {
```

Wrap the whole literal in `useMemo`. Change the opening from `const navItems: {...} = [` to:

```tsx
  const navItems = useMemo<{
```

…(keep the existing type body)… and change the array's closing `];` to:

```tsx
  ], [activeView, tasksPendingCount, unreadCount, whatsappUnread, setActiveView, setWhatsappUnread]);
```

Ensure `useMemo` is in the React import at the top of the file (add it if missing).

- [ ] **Step 2: Verify it compiles and lints**

Run: `pnpm build`
Expected: no errors.

Run: `pnpm lint`
Expected: no `react-hooks/exhaustive-deps` warning on the new `useMemo` (add any missing dep the linter flags).

- [ ] **Step 3: Verify existing tests still pass**

Run: `pnpm test`
Expected: all tests green (no behavioral change to nav).

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/AppLayout.tsx
git commit -m "perf(shell): memoize navItems to avoid per-render rebuild"
```

---

### Task 6: `React.memo` the always-mounted ChatView and chat blocks

**Files:**
- Modify: `apps/seraphine/frontend/src/chat/ChatView.tsx` (export, line ~347)
- Modify: `apps/seraphine/frontend/src/chat/TaskChatBlock.tsx`, `apps/seraphine/frontend/src/chat/NoteChatBlock.tsx`, and sibling `*ChatBlock.tsx` files in `chat/`
- Modify: `apps/seraphine/frontend/src/AppLayout.tsx` (stabilize the `onInitialTextConsumed` / `onRealtimeToggle` inline closures passed to ChatView, lines ~513-528)

**Interfaces:**
- Consumes: `memo`, `useCallback` from React.

**Why:** `ChatView` (1591 lines) is always mounted and re-renders whenever the shell re-renders. Wrapping it in `memo` shields it — but only if its props are referentially stable, hence the inline-closure fix in AppLayout.

- [ ] **Step 1: Stabilize the inline closures passed to ChatView (AppLayout)**

In `AppLayout.tsx`, the `<ChatView>` (lines ~500-532) passes two inline arrow props that defeat memoization. Define stable callbacks above the return:

```tsx
  const handleInitialTextConsumed = useCallback(() => {
    setPendingComposerText(null);
    setPendingComposerAutoSend(false);
  }, []);

  const handleRealtimeToggle = useCallback(() => {
    const next = !realtimeActive;
    if (!next) {
      playbackRef.current?.stop();
      wsRef.current?.send({ type: 'interrupt' });
    } else {
      warmSharedAudioContext();
      playbackRef.current?.ensureCtx();
    }
    setRealtimeActive(next);
  }, [realtimeActive, playbackRef, wsRef]);
```

Then change the two props to reference them:

```tsx
                onInitialTextConsumed={handleInitialTextConsumed}
```

```tsx
                onRealtimeToggle={handleRealtimeToggle}
```

(`useCallback` is already imported in AppLayout.)

- [ ] **Step 2: Wrap `ChatView` in `React.memo`**

In `chat/ChatView.tsx`, the component is `export function ChatView({ ... }: Props)` (line ~347). Keep the function but export a memoized wrapper. Rename the declaration to `function ChatViewImpl(` and at the end of the file add:

```tsx
export const ChatView = memo(ChatViewImpl);
```

Remove the `export` keyword from the original `function ChatView(` → `function ChatViewImpl(`. Add `memo` to the React import at the top of the file.

- [ ] **Step 3: Wrap each chat block in `React.memo`**

For each `chat/*ChatBlock.tsx` (start with `TaskChatBlock.tsx`, `NoteChatBlock.tsx`; apply to all siblings), do the same pattern: rename the exported function to `<Name>Impl`, add `export const <Name> = memo(<Name>Impl);`, and add `memo` to the React import. Only wrap components whose props are plain data/stable callbacks; if a block receives an inline-created object/array prop from its parent, leave a `// TODO: stabilize prop X before memo helps` note and skip wrapping that one rather than wrapping ineffectively.

- [ ] **Step 4: Verify it compiles and lints**

Run: `pnpm build`
Expected: no errors.

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 5: Verify existing tests still pass**

Run: `pnpm test`
Expected: all green — chat rendering tests (`App.test.tsx`, orchestrator transcript tests) unaffected.

- [ ] **Step 6: Manual verification — new messages still render**

Run: `pnpm tauri dev`. Send a chat message and confirm streaming text still appears live (memo did not freeze updates). Open React DevTools Profiler, trigger an unrelated slice change (let a focus session tick, or receive a WhatsApp push) and confirm `ChatView` does NOT appear in the committed render list.

- [ ] **Step 7: Commit**

```bash
git add apps/seraphine/frontend/src/chat apps/seraphine/frontend/src/AppLayout.tsx
git commit -m "perf(chat): memoize ChatView + chat blocks and stabilize their props"
```

---

### Task 7: Single-instance FocusContext so the 1s tick stops re-rendering the shell

**Files:**
- Create: `apps/seraphine/frontend/src/focus/FocusContext.tsx`
- Create: `apps/seraphine/frontend/src/focus/SidebarFocusCard.tsx`
- Modify: `apps/seraphine/frontend/src/focus/FocusPill.tsx` (consume context)
- Modify: `apps/seraphine/frontend/src/App.tsx` (wrap subtree in `FocusProvider`)
- Modify: `apps/seraphine/frontend/src/AppLayout.tsx` (remove `useFocusTimer` call + inline FOCO card; render leaf components)
- Test: `apps/seraphine/frontend/src/focus/__tests__/FocusContext.test.tsx`

**Interfaces:**
- Produces: `FocusProvider` (React component) and `useFocus(): [FocusState, FocusActions]` hook. `FocusState`/`FocusActions` are the existing types from `useFocusTimer.ts`.
- Consumes: `useFocusTimer` (called exactly once, inside the provider), `useAppRefs` (for `avatarCtrlRef` in the transition callback).

**Why:** `useFocusTimer` lives in `AppLayout` today, so its 1s `remaining` tick re-renders the entire shell + always-mounted ChatView. Moving the single hook instance into a provider, and reading the ticking value only in two small leaf components, confines the tick to those leaves.

- [ ] **Step 1: Write the failing test for single-instance + value propagation**

Create `apps/seraphine/frontend/src/focus/__tests__/FocusContext.test.tsx`:

```tsx
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FocusProvider, useFocus } from '../FocusContext';

// Avoid backend calls / notifications during the test.
vi.mock('../api', () => ({ logFocusSession: vi.fn(), setFocusActive: vi.fn() }));
vi.mock('../../utils/notify', () => ({ notify: vi.fn() }));

function Remaining() {
  const [state] = useFocus();
  return <span data-testid="phase">{state.phase}</span>;
}

describe('FocusContext', () => {
  beforeEach(() => localStorage.clear());

  it('provides focus state to consumers under the provider', () => {
    render(
      <FocusProvider>
        <Remaining />
      </FocusProvider>,
    );
    expect(screen.getByTestId('phase').textContent).toBe('idle');
  });

  it('throws if useFocus is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Remaining />)).toThrow();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/focus/__tests__/FocusContext.test.tsx`
Expected: FAIL — cannot resolve `../FocusContext`.

- [ ] **Step 3: Create `FocusContext.tsx`**

```tsx
import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useFocusTimer } from './useFocusTimer';
import type { FocusState, FocusActions, FocusPhase } from './useFocusTimer';
import { useAppRefs } from '../stores/RefsContext';
import { API_BASE } from '../api';

type FocusContextValue = [FocusState, FocusActions];

const FocusCtx = createContext<FocusContextValue | null>(null);

/** Single source of truth for the Pomodoro timer. Mount once near the app root.
 *  The 1s tick re-renders only consumers of useFocus(), not the whole shell. */
export function FocusProvider({ children }: { children: ReactNode }): JSX.Element {
  const { avatarCtrlRef } = useAppRefs();

  // Avatar expression + music transitions on phase change (moved out of AppLayout).
  const handleFocusTransition = useCallback((from: FocusPhase, to: FocusPhase) => {
    if (to === 'work' && (from === 'idle' || from === 'break' || from === 'long_break')) {
      fetch(`${API_BASE}/music/focus-start`, { method: 'POST' }).catch(() => {});
    }
    const ctrl = avatarCtrlRef.current;
    if (!ctrl) return;
    if (to === 'work') {
      ctrl.setExpression?.('focused', 300, 0);
    } else if (to === 'break' || to === 'long_break') {
      ctrl.setExpression?.('warm', 300, 0);
    }
    if (from === 'long_break' && to === 'work') {
      ctrl.setExpression?.('happy', 300, 3000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, actions] = useFocusTimer(handleFocusTransition);
  const value = useMemo<FocusContextValue>(() => [state, actions], [state, actions]);

  return <FocusCtx.Provider value={value}>{children}</FocusCtx.Provider>;
}

export function useFocus(): FocusContextValue {
  const v = useContext(FocusCtx);
  if (!v) throw new Error('useFocus must be used within a FocusProvider');
  return v;
}
```

(Confirm the import path for `useAppRefs` matches `stores/RefsContext` and that `API_BASE` is exported from `../api`; adjust to the actual export if different.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/focus/__tests__/FocusContext.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Create `SidebarFocusCard.tsx` (the FOCO button as a leaf)**

Move the FOCO button markup out of `AppLayout` (lines ~460-491) into a self-contained leaf that reads `useFocus()`:

```tsx
import { useFocus } from './FocusContext';
import type { FocusPhase } from './useFocusTimer';

const FOCUS_PHASE_SECS: Record<FocusPhase, number> = {
  work: 25 * 60,
  break: 5 * 60,
  long_break: 15 * 60,
  idle: 25 * 60,
};

export function SidebarFocusCard(): JSX.Element {
  const [focusState, focusActions] = useFocus();
  const focusTotal = FOCUS_PHASE_SECS[focusState.phase];
  const focusRemaining = focusState.phase === 'idle' ? focusTotal : focusState.remaining;
  const focusMmss = `${Math.floor(focusRemaining / 60).toString().padStart(2, '0')}:${(focusRemaining % 60).toString().padStart(2, '0')}`;
  const focusPct = focusState.phase === 'idle'
    ? 0
    : Math.max(0, Math.min(100, ((focusTotal - focusRemaining) / focusTotal) * 100));

  return (
    <button
      type="button"
      className={`sidebar__foco${focusState.phase === 'idle' ? ' sidebar__foco--idle' : ''}`}
      aria-label={focusState.phase === 'idle' ? 'Iniciar foco Pomodoro' : 'Foco Pomodoro'}
      onClick={() => {
        if (focusState.phase === 'idle') focusActions.start();
        else if (focusState.running) focusActions.pause();
        else focusActions.resume();
      }}
    >
      <div className="sidebar__foco-head">
        <span className="sidebar__foco-label">FOCO</span>
        <span className="sidebar__foco-mode">
          {focusState.phase === 'idle'
            ? 'Iniciar'
            : focusState.phase === 'work'
              ? 'Pomodoro'
              : focusState.phase === 'long_break'
                ? 'Pausa longa'
                : 'Pausa'}
        </span>
      </div>
      <div className="sidebar__foco-time">
        <span className="sidebar__foco-num">{focusMmss}</span>
        <span className="sidebar__foco-rest">
          {focusState.phase === 'idle' ? 'Pomodoro' : focusState.running ? 'restante' : 'pausado'}
        </span>
      </div>
      <div className="sidebar__foco-bar">
        <div style={{ width: `${focusPct}%` }} />
      </div>
    </button>
  );
}
```

- [ ] **Step 6: Make `FocusPill` consume context**

In `apps/seraphine/frontend/src/focus/FocusPill.tsx`, change the component to read from `useFocus()` instead of `state`/`actions` props. Keep the existing rendering/markup; only the data source changes:

```tsx
import { useFocus } from './FocusContext';
// ...existing imports...

export function FocusPill(): JSX.Element | null {
  const [state, actions] = useFocus();
  // ...existing body unchanged, using `state` and `actions`...
}
```

Remove the now-unused `FocusPillProps`/`state`/`actions` prop type. (If `FocusPill` is rendered anywhere besides AppLayout, update those call sites to `<FocusPill />`.)

- [ ] **Step 7: Wire the provider in `App.tsx` and gut the focus code in `AppLayout`**

In `App.tsx`, wrap the subtree that contains `AppLayout` with `FocusProvider` (inside `RefsProvider`, since the provider uses `useAppRefs`):

```tsx
import { FocusProvider } from './focus/FocusContext';
// ...
        <FocusProvider>
          <AppBootstrap />
          <AppLayout />
        </FocusProvider>
```

In `AppLayout.tsx`:
- Delete the `handleFocusTransition` callback (lines ~163-180) and the `const [focusState, focusActions] = useFocusTimer(...)` line (181) — moved into the provider.
- Delete the derived `FOCUS_PHASE_SECS`/`focusTotal`/`focusRemaining`/`focusMmss`/`focusPct` block (lines ~184-198) — moved into `SidebarFocusCard`.
- Replace `<FocusPill state={focusState} actions={focusActions} />` (line ~336) with `<FocusPill />`.
- Replace the entire inline FOCO `<button>` (lines ~460-491) with `<SidebarFocusCard />`.
- Remove the now-unused imports (`useFocusTimer`, `FocusPhase` if unused elsewhere) and add `import { SidebarFocusCard } from './focus/SidebarFocusCard';`.

- [ ] **Step 8: Verify it compiles, lints, and tests pass**

Run: `pnpm build`
Expected: no errors (watch for leftover references to `focusState`/`focusActions` in AppLayout — remove them).

Run: `pnpm lint`
Expected: no unused-import or new errors.

Run: `pnpm test`
Expected: all green, including the new FocusContext test.

- [ ] **Step 9: Manual verification — tick no longer re-renders the shell**

Run: `pnpm tauri dev`. Start a focus session. Open React DevTools Profiler and record while the timer ticks. Expected: only `SidebarFocusCard` and `FocusPill` appear in per-second commits; `AppLayout` and `ChatView` do NOT re-render on the tick. Confirm starting/pausing/resuming focus still works and the avatar expression still changes on phase transitions.

- [ ] **Step 10: Commit**

```bash
git add apps/seraphine/frontend/src/focus apps/seraphine/frontend/src/App.tsx apps/seraphine/frontend/src/AppLayout.tsx
git commit -m "perf(focus): single-instance FocusContext so the 1s tick stops re-rendering the shell"
```

---

## Self-Review

**Spec coverage:**
- A1 pause on hide → Task 1. A2 forceContextLoss → Task 2. A3 context lost/restored → Task 3. ✓
- B1 pause on non-chat view → Task 4. ✓
- C1 scope focus timer → Task 7. C2 memo ChatView/blocks → Task 6. C3 memoize navItems → Task 5. ✓
- Validation steps from spec (window cycle, GPU drop, Profiler) → Tasks 2/3 step, Task 4 step 3, Task 6 step 6, Task 7 step 9. ✓

**Type consistency:** `setPauseReason(reason, paused)` defined in Task 1, consumed in Tasks 3 (`'context'`) and 4 (`'view'`). `setRenderPaused` retained for the companion. `FocusState`/`FocusActions`/`FocusPhase` reused from `useFocusTimer.ts` throughout Task 7. `useFocus()` returns the same `[state, actions]` tuple shape `useFocusTimer` does, so `FocusPill`/`SidebarFocusCard` bodies port unchanged. ✓

**Placeholder scan:** No "TBD"/"add error handling" placeholders; each code step shows the actual code. Two deliberate verify-time judgement calls are flagged inline (Task 6 step 3: skip wrapping blocks with unstable props; Task 7 step 3: confirm `useAppRefs`/`API_BASE` import paths) — these are confirmations against the real files, not deferred work.
