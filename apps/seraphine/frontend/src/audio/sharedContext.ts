/**
 * Singleton AudioContext shared across playback and mic capture.
 *
 * macOS CoreAudio deadlocks when multiple AudioContexts compete for
 * the hardware audio layer (HAL).  A single shared context avoids this.
 *
 * Recreation: WebKit (WKWebView) has a known zombie state where the
 * AudioContext stays `state==='running'` after an output device change
 * (AirPods connect/disconnect) but the underlying audio session is
 * dead — scheduled sources play silently and `onended` never fires.
 * `devicechange` is the only reliable signal, so we listen for it and
 * recreate the context, notifying subscribers so they can rebuild their
 * graphs against the fresh context.
 */

import { onDeviceChange } from './deviceChange';

let ctx: AudioContext | null = null;
const recreateCallbacks = new Set<(ctx: AudioContext) => void>();
let devicechangeSubscribed = false;

function ensureDeviceChangeSubscription(): void {
  if (devicechangeSubscribed) return;
  devicechangeSubscribed = true;
  onDeviceChange(() => {
    console.log('[sharedContext] devicechange — recreating AudioContext');
    void recreateSharedAudioContext();
  });
}

/**
 * Get or create the shared AudioContext.
 * Eagerly resumes if suspended. Safe to call multiple times.
 */
export function getSharedAudioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    ensureDeviceChangeSubscription();
  }
  if (ctx.state === 'suspended') {
    // Fire resume eagerly; callers that need it settled should await it.
    ctx.resume().catch((err) => console.warn('[sharedContext] resume failed:', err));
  }
  return ctx;
}

/**
 * Eagerly create the AudioContext on a user gesture so it starts in
 * 'running' state. Call this from a click/touch/keydown handler.
 */
export function warmSharedAudioContext(): void {
  getSharedAudioContext();
}

/**
 * Subscribe to AudioContext recreation. The callback receives the fresh
 * context. Returns an unsubscribe function.
 */
export function subscribeContextRecreated(cb: (ctx: AudioContext) => void): () => void {
  recreateCallbacks.add(cb);
  return () => {
    recreateCallbacks.delete(cb);
  };
}

/**
 * Tear down the current shared AudioContext and create a fresh one.
 * Notifies all subscribers with the new context. Triggered automatically
 * by `devicechange` and on demand by the playback stuck-pending watchdog.
 */
export async function recreateSharedAudioContext(): Promise<AudioContext> {
  const old = ctx;
  ctx = null;
  if (old && old.state !== 'closed') {
    try {
      await old.close();
    } catch (err) {
      console.warn('[sharedContext] close failed:', err);
    }
  }
  const fresh = getSharedAudioContext();
  for (const cb of recreateCallbacks) {
    try {
      cb(fresh);
    } catch (err) {
      console.warn('[sharedContext] recreate callback failed:', err);
    }
  }
  return fresh;
}
