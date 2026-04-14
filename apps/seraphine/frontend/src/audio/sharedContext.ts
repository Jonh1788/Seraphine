/**
 * Singleton AudioContext shared across playback and mic capture.
 *
 * macOS CoreAudio deadlocks when multiple AudioContexts compete for
 * the hardware audio layer (HAL).  A single shared context avoids this.
 */

let ctx: AudioContext | null = null;

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
