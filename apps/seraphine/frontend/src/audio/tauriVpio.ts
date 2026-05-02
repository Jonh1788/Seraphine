/**
 * Frontend wrapper around the Rust VoiceProcessingIO audio unit
 * (`vpio_*` tauri commands). One instance = one mic + speaker session
 * with Apple's AEC + noise suppression + AGC.
 *
 * Used by the realtime voice path only. PTT keeps using cpal because
 * there's no concurrent playback to cancel, and cpal's code path is
 * proven. VPIO and cpal can't run simultaneously (they both want the
 * default input device), so callers must stop one before starting the
 * other.
 */

import type { UnlistenFn } from '@tauri-apps/api/event';
import { onDeviceChange } from './deviceChange';

type ChunkListener = (pcm: Int16Array) => void;
type PlaybackListener = (pcm: Int16Array) => void;

/** True if running inside the Tauri desktop shell (`__TAURI_INTERNALS__`). */
export function isTauriVpioAvailable(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== 'undefined';
}

export class TauriVpioSession {
  private listeners = new Set<ChunkListener>();
  private playbackListeners = new Set<PlaybackListener>();
  private unlistenMic: UnlistenFn | null = null;
  private unlistenPlayback: UnlistenFn | null = null;
  private unlistenDebug: UnlistenFn | null = null;
  private unlistenDebugFmt: UnlistenFn | null = null;
  private unlistenStatus: UnlistenFn | null = null;
  private _unlistenBound: UnlistenFn | null = null;
  private _unlistenBindWarn: UnlistenFn | null = null;
  private running = false;

  /**
   * Watchdog state — the render callback in the Rust VPIO unit fires
   * continuously (~every 42 ms), even during silence, and each firing
   * emits `vpio-playback-chunk`. If we stop receiving events while the
   * session is still "running" (sleep/wake, audio device teardown,
   * driver bug), the audio unit is dead in the water. Watchdog
   * reinitializes it so the user doesn't have to toggle realtime off
   * and back on.
   */
  private lastPlaybackChunkAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private restartInFlight = false;
  /**
   * Output device change handler. macOS VPIO binds devices once in
   * `vpio_start` (no `AudioObjectAddPropertyListener`), so when the
   * default output changes (AirPods, headphones) the unit keeps writing
   * to the original device. devicechange triggers a stop/start so VPIO
   * picks up the new default.
   */
  private deviceChangeUnsub: (() => void) | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    // Subscribe BEFORE invoking start so we don't miss the first chunk.
    this.unlistenMic = await listen<number[]>('mic-pcm-chunk', (event) => {
      const arr = event.payload;
      const pcm = new Int16Array(arr);
      this.listeners.forEach((cb) => cb(pcm));
    });
    // Playback-chunk events fire from the Rust render callback every
    // ~42 ms with the samples just handed to the speaker. Used by the
    // PCMPlayback JS analyser to drive lipsync in step with the actual
    // audio instead of WS arrival time.
    this.unlistenPlayback = await listen<number[]>('vpio-playback-chunk', (event) => {
      this.lastPlaybackChunkAt = Date.now();
      if (this.playbackListeners.size === 0) return;
      const arr = event.payload;
      const pcm = new Int16Array(arr);
      this.playbackListeners.forEach((cb) => cb(pcm));
    });
    // Diagnostic events from the Rust audio thread (first 20 callbacks).
    this.unlistenDebug = await listen<Record<string, unknown>>('vpio-debug', (event) => {
      console.log('[vpio][rust] cb', event.payload);
    });
    // Negotiated stream formats emitted right after AudioUnitInitialize.
    this.unlistenDebugFmt = await listen<Record<string, unknown>[]>('vpio-debug-formats', (event) => {
      console.log('[vpio][rust] negotiated formats', event.payload);
    });
    // Periodic ring health status (first 20 events, ~200ms interval).
    this.unlistenStatus = await listen<Record<string, unknown>>('vpio-playback-status', (event) => {
      console.log('[vpio][rust] playback-status', event.payload);
    });
    // Device bind result — confirm which input/output devices were selected.
    const unlistenBound = await listen<Record<string, unknown>>('vpio-bound-devices', (event) => {
      console.log('[vpio][rust] bound-devices', event.payload);
    });
    // Per-element binding fallback warning — means VPIO output is on the
    // mic device (no speaker), so TTS will route through Web Audio instead.
    const unlistenBindWarn = await listen<Record<string, unknown>>('vpio-bind-warning', (event) => {
      console.warn('[vpio][rust] bind warning — per-element bind failed, falling back to input device on both buses:', event.payload);
    });
    // Clean up these one-shot diagnostic listeners after VPIO starts.
    // They fire during vpio_start so they'll have emitted by the time
    // the invoke returns. Store them for cleanup just in case.
    this._unlistenBound = unlistenBound;
    this._unlistenBindWarn = unlistenBindWarn;
    try {
      await invoke('vpio_start');
    } catch (err) {
      this.unlistenMic?.();
      this.unlistenMic = null;
      this.unlistenPlayback?.();
      this.unlistenPlayback = null;
      this.unlistenDebug?.();
      this.unlistenDebug = null;
      this.unlistenDebugFmt?.();
      this.unlistenDebugFmt = null;
      this.unlistenStatus?.();
      this.unlistenStatus = null;
      this._unlistenBound?.();
      this._unlistenBound = null;
      this._unlistenBindWarn?.();
      this._unlistenBindWarn = null;
      throw err;
    }
    this.running = true;
    this.lastPlaybackChunkAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog();
    }, 3000);
    this.deviceChangeUnsub = onDeviceChange(() => {
      void this.handleDeviceChange();
    });
    console.log('[vpio] session started — AEC + NS + AGC active');
  }

  private async handleDeviceChange(): Promise<void> {
    if (!this.running || this.restartInFlight) return;
    this.restartInFlight = true;
    console.log('[vpio] devicechange — restarting audio unit to pick up new default device');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vpio_stop');
      if (!this.running) return;
      await invoke('vpio_start');
      this.lastPlaybackChunkAt = Date.now();
      console.log('[vpio] devicechange: audio unit restarted');
    } catch (err) {
      console.warn('[vpio] devicechange: restart failed:', err);
    } finally {
      this.restartInFlight = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.deviceChangeUnsub) {
      this.deviceChangeUnsub();
      this.deviceChangeUnsub = null;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vpio_stop');
    } catch (err) {
      console.warn('[vpio] stop failed:', err);
    }
    this.unlistenMic?.();
    this.unlistenMic = null;
    this.unlistenPlayback?.();
    this.unlistenPlayback = null;
    this.unlistenDebug?.();
    this.unlistenDebug = null;
    this.unlistenDebugFmt?.();
    this.unlistenDebugFmt = null;
    this.unlistenStatus?.();
    this.unlistenStatus = null;
    this._unlistenBound?.();
    this._unlistenBound = null;
    this._unlistenBindWarn?.();
    this._unlistenBindWarn = null;
    this.listeners.clear();
    this.playbackListeners.clear();
    console.log('[vpio] session stopped');
  }

  private async runWatchdog(): Promise<void> {
    if (!this.running || this.restartInFlight) return;
    const elapsed = Date.now() - this.lastPlaybackChunkAt;
    if (elapsed <= 4000) return;

    this.restartInFlight = true;
    console.warn(
      `[vpio] watchdog: render callback silent for ${elapsed} ms — restarting audio unit`,
    );
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vpio_stop');
      if (!this.running) return; // external stop raced us
      await invoke('vpio_start');
      this.lastPlaybackChunkAt = Date.now();
      console.log('[vpio] watchdog: audio unit restarted');
    } catch (err) {
      console.warn('[vpio] watchdog: restart failed:', err);
    } finally {
      this.restartInFlight = false;
    }
  }

  onChunk(cb: ChunkListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Subscribe to samples at the moment they leave the audio unit for
   *  the speaker. Payload is i16 @ 24 kHz mono. */
  onPlaybackChunk(cb: PlaybackListener): () => void {
    this.playbackListeners.add(cb);
    return () => {
      this.playbackListeners.delete(cb);
    };
  }

  /** Queue s16le 24 kHz mono PCM for playback through the VPIO output. */
  async playChunk(pcm: Uint8Array): Promise<void> {
    if (!this.running) {
      console.warn('[vpio] playChunk(%d bytes) DROPPED — session not running', pcm.byteLength);
      return;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      // Array.from(pcm) converts the Uint8Array to a plain number[] that
      // Tauri's JSON IPC can serialise as Vec<u8>.
      await invoke('vpio_play_chunk', { pcm: Array.from(pcm) });
      console.log('[vpio] playChunk(%d bytes) queued OK', pcm.byteLength);
    } catch (err) {
      console.warn('[vpio] play_chunk failed:', err);
    }
  }

  /** Drop every queued sample (barge-in). */
  async flushOutput(): Promise<void> {
    console.log('[vpio] flushOutput() called, running=%s', this.running);
    console.trace('[vpio] flushOutput() stack');
    if (!this.running) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // Query ring size BEFORE flushing so we can see how much was dropped.
      let ringBefore = -1;
      try {
        ringBefore = await invoke<number>('vpio_ring_len');
      } catch { /* ignore */ }
      await invoke('vpio_flush_output');
      console.log('[vpio] flushOutput() completed — ring_before_flush=%d', ringBefore);
    } catch (err) {
      console.warn('[vpio] flush_output failed:', err);
    }
  }

  /** Query the current output ring length (samples at 24 kHz). */
  async ringLen(): Promise<number> {
    if (!this.running) return 0;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<number>('vpio_ring_len');
    } catch {
      return 0;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
