/**
 * Streaming PCM player using Web Audio AudioBufferSourceNode.
 *
 * History: a previous implementation used chained HTMLAudioElement +
 * MediaElementAudioSourceNode. That worked on Chrome but stuttered on
 * Safari/PWA (WebKit has known issues with chained <audio> elements
 * routed through the Web Audio graph — audio would cut out mid-utterance
 * — and AudioBufferSourceNode is the canonical gapless-streaming path).
 *
 * Now: we decode each PCM segment straight into an AudioBuffer and
 * schedule it on the AudioContext timeline. Each source's start time is
 * `max(ctx.currentTime, lastScheduledEnd)` so segments play gapless even
 * if one lands late. AnalyserNode connects naturally for lipsync.
 */
import { FFTAnalyser } from './fftAnalyser';
import {
  getSharedAudioContext,
  recreateSharedAudioContext,
  subscribeContextRecreated,
} from './sharedContext';
import type { TauriVpioSession } from './tauriVpio';

/** Input PCM sample rate from the TTS server. */
const INPUT_RATE = 24000;

/**
 * First segment is small so the player starts making sound almost
 * immediately. 0.2s is short enough to feel instant and large enough
 * that decoded playback doesn't stutter on initial load.
 */
const FIRST_SEGMENT_SECONDS = 0.2;
const FIRST_SEGMENT_SAMPLES = Math.floor(FIRST_SEGMENT_SECONDS * INPUT_RATE);
/**
 * Subsequent segments are larger to reduce decode/schedule churn. The
 * first segment is already playing by the time these are built, so their
 * size affects throughput, not perceived latency.
 */
const NEXT_SEGMENT_SECONDS = 1.0;
const NEXT_SEGMENT_SAMPLES = Math.floor(NEXT_SEGMENT_SECONDS * INPUT_RATE);

/**
 * Playback speed multiplier. Keep at 1.0 when the TTS backend applies
 * server-side speed. Applied via AudioBufferSourceNode.playbackRate.
 */
let PLAYBACK_RATE = 1.0;

export class PCMPlayback {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private carry: Uint8Array | null = null;

  /** Accumulated raw s16le bytes waiting to become a segment. */
  private accumBytes: Uint8Array[] = [];
  private accumSamples = 0;
  /**
   * First segment per utterance uses the small threshold for fast TTFB;
   * subsequent segments use the larger threshold. Reset on each flush/reset.
   */
  private firstSegmentEmitted = false;

  /** AudioContext timeline position of the end of the last scheduled buffer. */
  private lastScheduledEnd = 0;
  /** Currently scheduled sources so we can stop them on barge-in. */
  private scheduledSources: Set<AudioBufferSourceNode> = new Set();
  /** Number of buffers awaiting `onended` — when this hits 0 with no pending
   *  accumulator bytes, playback of this utterance is complete. */
  private pending = 0;

  private flushResolve: (() => void) | null = null;
  private flushing = false;

  private analyserCallbacks: ((a: AnalyserNode) => void)[] = [];

  /**
   * When set, `pushChunk` forwards the raw bytes to the VoiceProcessingIO
   * Rust session instead of scheduling through Web Audio. This is used by
   * the realtime flow on macOS so AEC has the TTS signal as reference.
   * Web Audio output is skipped entirely in that mode to avoid double
   * playback.
   */
  private vpioSink: TauriVpioSession | null = null;

  /**
   * JS-side FFT analyser, used for lipsync when in VPIO mode. The Web
   * Audio `AnalyserNode` on our graph sees no audio in VPIO mode
   * (playback bypasses Web Audio), so we run a parallel analyser fed
   * from `vpio-playback-chunk` events — those fire from the Rust render
   * callback at the moment the samples are handed to the speaker, so
   * lipsync stays in lock-step with the actual audio instead of leading
   * it by the WS→ring latency. `getAnalyser()` returns this one while
   * VPIO is active.
   */
  private jsAnalyser = new FFTAnalyser(1024);
  private vpioPlaybackUnsub: (() => void) | null = null;

  /**
   * Watchdog state — see `startWatchdog()`. Long-running sessions on
   * macOS/WebKit can drop the AudioContext into `suspended` /
   * `interrupted` after device switches, sleep/wake, Siri grabbing audio
   * focus, etc. The statechange listener tries resume, but if the
   * browser rejects (no user gesture, window unfocused) the context stays
   * stuck forever — new segments log "segment scheduled" but never play.
   * The watchdog retries resume on an interval and re-anchors the
   * gapless-scheduling cursor if it drifted past real time.
   */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogResumeFailures = 0;
  /**
   * Last observed ctx.currentTime. Usado pra detectar o bug do WebKit
   * onde currentTime volta pra tras apos suspend/resume. Drift positivo
   * grande NAO e sintoma de bug — e consequencia normal de TTS streamar
   * o PCM muito mais rapido que realtime. So cancelamos sources quando
   * currentTime efetivamente REGRIDE.
   */
  private lastSeenCurrentTime = 0;
  /**
   * Counter for the stuck-pending watchdog. WebKit has a zombie state
   * after AirPods disconnect/connect where ctx.state stays 'running' and
   * currentTime advances normally, but scheduled sources play silently
   * and `onended` never fires — pending grows unbounded while audio is
   * dead. When pending > 0 and currentTime crosses lastScheduledEnd by
   * 0.5s for 2 consecutive watchdog ticks (~6s), we force-recreate the
   * AudioContext to break out of zombie state.
   */
  private stuckPendingTicks = 0;
  private contextRecreatedUnsub: (() => void) | null = null;

  constructor() {}

  /** Route TTS output to the VPIO sink. Pass `null` to restore Web Audio. */
  setVpioSink(sink: TauriVpioSession | null): void {
    console.log('[PCMPlayback] setVpioSink called —', sink ? 'VPIO sink SET' : 'VPIO sink CLEARED (Web Audio mode)');
    console.trace('[PCMPlayback] setVpioSink stack');
    const prev = this.activeAnalyser();
    // Unsubscribe any previous playback-chunk listener before swapping.
    this.vpioPlaybackUnsub?.();
    this.vpioPlaybackUnsub = null;
    this.vpioSink = sink;
    if (sink) {
      this.jsAnalyser.reset();
      // Feed the JS analyser from samples that actually reached the
      // speaker. Payload is i16 @ 24 kHz mono; convert once and push.
      this.vpioPlaybackUnsub = sink.onPlaybackChunk((pcm) => {
        const floats = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i += 1) {
          floats[i] = pcm[i] / 32768;
        }
        this.jsAnalyser.push(floats);
      });
    }
    const now = this.activeAnalyser();
    // Consumers (VrmAvatarController, RealtimeController's bot analyser)
    // attach once via `getAnalyser(cb)`, so when the sink toggles and the
    // active analyser changes, re-fire every registered callback so they
    // re-attach to the right source.
    if (prev !== now && now) {
      for (const cb of this.analyserCallbacks) {
        try { cb(now); } catch { /* */ }
      }
    }
  }

  /** The analyser consumers should be reading from right now. */
  private activeAnalyser(): AnalyserNode | null {
    if (this.vpioSink) {
      return this.jsAnalyser as unknown as AnalyserNode;
    }
    return this.analyser;
  }

  /**
   * Lazily initialise the AudioContext, AnalyserNode, and Gain.
   * MUST be called from a user-gesture context the first time so the
   * browser lets the AudioContext start in "running" state.
   */
  ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    this.ctx = getSharedAudioContext();
    this.attachToContext(this.ctx);

    if (!this.contextRecreatedUnsub) {
      this.contextRecreatedUnsub = subscribeContextRecreated((newCtx) => {
        this.handleContextRecreated(newCtx);
      });
    }

    this.startWatchdog();
    return this.ctx;
  }

  /**
   * Build the gain → analyser → destination graph against `ctx` and
   * wire the statechange listener. Called on first `ensureCtx` and
   * again on every shared-context recreation.
   */
  private attachToContext(ctx: AudioContext): void {
    this.gain = ctx.createGain();
    this.gain.gain.value = 1.0;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;

    // Source chain: AudioBufferSourceNode → gain → analyser → destination.
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    console.log('[PCMPlayback] AudioContext attached, state:', ctx.state);

    // macOS/Safari can drop the AudioContext into 'suspended' or
    // 'interrupted' between utterances. Auto-resume so the next buffer
    // has a running context to schedule against.
    const onStateChange = (): void => {
      const state = this.ctx?.state;
      console.log('[PCMPlayback] ctx statechange:', state);
      if (state === 'suspended' || state === 'interrupted') {
        this.ctx?.resume().catch((err) =>
          console.warn('[PCMPlayback] resume on statechange failed:', err),
        );
      }
      // Proactive drift check: when coming back to 'running' after a
      // suspend/resume cycle, currentTime may have jumped backwards
      // relative to lastScheduledEnd (WebKit quirk). Catch this
      // immediately instead of waiting for the 3s watchdog interval.
      if (state === 'running' && this.ctx) {
        const now = this.ctx.currentTime;
        if (now < this.lastSeenCurrentTime - 1) {
          console.warn(
            `[PCMPlayback] statechange→running: currentTime regressed ${this.lastSeenCurrentTime.toFixed(2)}→${now.toFixed(2)}s — cancelling orphaned sources`,
          );
          this.cancelOrphanedSources();
        }
        this.lastSeenCurrentTime = now;
      }
    };
    try {
      ctx.addEventListener('statechange', onStateChange);
    } catch {
      /* old browsers */
    }

    // Fire registered callbacks so avatar/bot-RMS subscribers attach.
    const active = this.activeAnalyser();
    if (active) {
      for (const cb of this.analyserCallbacks) {
        try { cb(active); } catch { /* */ }
      }
    }
  }

  /**
   * Shared AudioContext was torn down (devicechange or stuck-pending
   * watchdog) — drop in-flight state and rebuild the graph against the
   * fresh context so the next TTS chunk schedules correctly.
   */
  private handleContextRecreated(newCtx: AudioContext): void {
    console.log('[PCMPlayback] context recreated — rebuilding graph');

    // Old scheduled sources are orphaned (they belong to a closed ctx).
    for (const src of this.scheduledSources) {
      try { src.onended = null; } catch { /* */ }
      try { src.disconnect(); } catch { /* */ }
    }
    this.scheduledSources.clear();
    this.pending = 0;
    this.lastScheduledEnd = 0;
    this.lastSeenCurrentTime = newCtx.currentTime;
    this.stuckPendingTicks = 0;
    this.watchdogResumeFailures = 0;

    if (this.flushing) {
      this.flushing = false;
      if (this.flushResolve) {
        const r = this.flushResolve;
        this.flushResolve = null;
        r();
      }
    }

    // Disconnect old graph nodes — they reference the closed context.
    if (this.gain) {
      try { this.gain.disconnect(); } catch { /* */ }
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch { /* */ }
    }

    this.ctx = newCtx;
    this.attachToContext(newCtx);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog();
    }, 3000);
  }

  private async runWatchdog(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    // 1) Stuck state — attempt to resume, warn if persistently failing.
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* resume can reject in unfocused windows; just retry next tick */
      }
      if ((ctx.state as AudioContextState) !== 'running') {
        this.watchdogResumeFailures += 1;
        if (
          this.watchdogResumeFailures === 1 ||
          this.watchdogResumeFailures % 10 === 0
        ) {
          console.warn(
            `[PCMPlayback] watchdog: ctx state=${ctx.state} — ${this.watchdogResumeFailures} failed resume attempts`,
          );
        }
      } else {
        if (this.watchdogResumeFailures > 0) {
          console.log('[PCMPlayback] watchdog: ctx recovered');
        }
        this.watchdogResumeFailures = 0;
      }
      return;
    }
    this.watchdogResumeFailures = 0;

    // 2) Scheduling drift — if `lastScheduledEnd` got far ahead of real
    // time (can happen after suspend/resume on WebKit where currentTime
    // semantics diverge), cancel orphaned sources and re-anchor so the
    // next segment starts "now" instead of decades in the future.
    // Detecta regressao de currentTime (WebKit bug pos-suspend/resume).
    // NAO usamos drift "lastScheduledEnd - currentTime" porque TTS que
    // streama PCM mais rapido que realtime agenda muitos segundos no
    // futuro — e comportamento normal, nao sintoma de bug.
    const now = ctx.currentTime;
    if (now < this.lastSeenCurrentTime - 1) {
      console.warn(
        `[PCMPlayback] watchdog: currentTime regressed ${this.lastSeenCurrentTime.toFixed(2)}→${now.toFixed(2)}s — cancelling orphaned sources`,
      );
      this.cancelOrphanedSources();
    }
    this.lastSeenCurrentTime = now;

    // 3) Stuck-pending detector — WebKit zombie state after AirPods
    // disconnect/connect. ctx.state stays 'running', currentTime
    // advances, but scheduled sources play silently and `onended`
    // never fires. devicechange normally catches this preemptively;
    // this watchdog is the fallback when devicechange doesn't fire
    // (some WKWebView contexts) or fires after the failure.
    if (
      this.pending > 0 &&
      this.lastScheduledEnd > 0 &&
      now > this.lastScheduledEnd + 0.5
    ) {
      this.stuckPendingTicks += 1;
      console.warn(
        `[PCMPlayback] watchdog: stuck pending=${this.pending} (currentTime=${now.toFixed(2)} > lastEnd=${this.lastScheduledEnd.toFixed(2)}+0.5) — tick ${this.stuckPendingTicks}/2`,
      );
      if (this.stuckPendingTicks >= 2) {
        this.stuckPendingTicks = 0;
        console.warn('[PCMPlayback] watchdog: forcing AudioContext recreation (zombie state)');
        await recreateSharedAudioContext();
        // handleContextRecreated fires via subscription.
      }
    } else {
      this.stuckPendingTicks = 0;
    }
  }

  /**
   * Cancel all scheduled AudioBufferSourceNodes that haven't played yet,
   * clear the set, resolve any pending flush promise, and re-anchor
   * `lastScheduledEnd` to `ctx.currentTime`.
   *
   * Called by the watchdog and the proactive `statechange→running`
   * listener when scheduling drift exceeds the threshold. Unlike
   * `stop()`, this preserves the accumulator so new chunks arriving
   * after the re-anchor rebuild the schedule from scratch.
   */
  private cancelOrphanedSources(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const count = this.scheduledSources.size;
    for (const src of this.scheduledSources) {
      try { src.onended = null; } catch { /* */ }
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* */ }
    }
    this.scheduledSources.clear();
    this.pending = 0;
    this.lastScheduledEnd = ctx.currentTime;
    // Re-sincroniza o tracker de regressao com o estado atual pra
    // nao re-disparar no proximo tick.
    this.lastSeenCurrentTime = ctx.currentTime;

    console.log(
      `[PCMPlayback] cancelled ${count} orphaned source(s) — re-anchored to ${ctx.currentTime.toFixed(3)}`,
    );

    // A pending flush() is waiting for pending to hit 0. Since we just
    // cancelled everything, resolve it now — there is nothing left playing.
    if (this.flushing) {
      this.flushing = false;
      if (this.flushResolve) {
        const r = this.flushResolve;
        this.flushResolve = null;
        r();
      }
    }
  }

  getAnalyser(onReady?: (a: AnalyserNode) => void): AnalyserNode | null {
    // Keep the callback persistent so `setVpioSink` can re-fire it when
    // the active analyser swaps between Web Audio and the JS FFT.
    if (onReady) this.analyserCallbacks.push(onReady);
    const active = this.activeAnalyser();
    if (active && onReady) {
      try { onReady(active); } catch { /* */ }
    }
    return active;
  }

  pushChunk(buf: ArrayBuffer): void {
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return;

    // VPIO sink: forward raw s16le bytes straight to the Rust output
    // ring. The JS analyser is fed separately via `vpio-playback-chunk`
    // events from the render callback so lipsync aligns with actual
    // playback time, not WS arrival time.
    if (this.vpioSink) {
      // DEBUG: log EVERY chunk, not just the first, so we can count
      // exactly how many arrive and confirm they all route to VPIO.
      console.log('[PCMPlayback] pushChunk(%d bytes) -> vpio', bytes.byteLength);
      let input = bytes;
      if (this.carry) {
        const merged = new Uint8Array(this.carry.byteLength + bytes.byteLength);
        merged.set(this.carry, 0);
        merged.set(bytes, this.carry.byteLength);
        input = merged;
        this.carry = null;
      }
      const evenLen = input.byteLength - (input.byteLength % 2);
      if (evenLen < input.byteLength) {
        this.carry = input.slice(evenLen);
      }
      if (evenLen === 0) return;
      void this.vpioSink.playChunk(input.slice(0, evenLen));
      return;
    }

    // Web Audio path (no VPIO sink).
    // DEBUG: log EVERY chunk so we can see if any chunks fall through
    // to Web Audio when they should have gone to VPIO.
    console.log('[PCMPlayback] pushChunk(%d bytes) -> webaudio', bytes.byteLength);

    // Handle carry byte from odd-sized previous chunk
    let input = bytes;
    if (this.carry) {
      const merged = new Uint8Array(this.carry.byteLength + bytes.byteLength);
      merged.set(this.carry, 0);
      merged.set(bytes, this.carry.byteLength);
      input = merged;
      this.carry = null;
    }

    const evenLen = input.byteLength - (input.byteLength % 2);
    if (evenLen < input.byteLength) {
      this.carry = input.slice(evenLen);
    }
    if (evenLen === 0) return;

    this.accumBytes.push(input.slice(0, evenLen));
    this.accumSamples += evenLen / 2;

    const threshold = this.firstSegmentEmitted
      ? NEXT_SEGMENT_SAMPLES
      : FIRST_SEGMENT_SAMPLES;
    if (this.accumSamples >= threshold) {
      void this.flushAccumToSegment();
    }
  }

  /** Convert accumulated PCM into an AudioBuffer and schedule for playback. */
  private async flushAccumToSegment(): Promise<void> {
    if (this.accumSamples === 0) return;

    // Snapshot atomically before any await so concurrent pushChunk calls
    // don't race — JS is single-threaded up to the first await below.
    const chunks = this.accumBytes;
    const sampleCount = this.accumSamples;
    this.accumBytes = [];
    this.accumSamples = 0;
    this.firstSegmentEmitted = true;

    const ctx = this.ensureCtx();

    // WebKit/Safari/WKWebView silently DROPS sources scheduled against a
    // suspended context while `resume()` is still in flight — the segment
    // log still appears but no audio plays. Await the resume before we
    // schedule so ctx.state === 'running' and ctx.currentTime is real.
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('[PCMPlayback] resume failed, dropping segment:', err);
        return;
      }
      if ((ctx.state as AudioContextState) !== 'running') {
        console.warn('[PCMPlayback] ctx not running after resume; dropping segment');
        return;
      }
    }

    // Merge all snapshotted byte arrays
    const totalBytes = chunks.reduce((s, a) => s + a.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const a of chunks) {
      merged.set(a, offset);
      offset += a.byteLength;
    }

    // Decode s16le → Float32 AudioBuffer (mono, 24kHz).
    const buffer = ctx.createBuffer(1, sampleCount, INPUT_RATE);
    const channel = buffer.getChannelData(0);
    // Use DataView for correct little-endian int16 decoding.
    const dv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = dv.getInt16(i * 2, true) / 0x8000;
    }

    // Schedule the source at max(now + tiny lead, lastScheduledEnd).
    // A 20ms lead on the very first segment covers Safari's initial start
    // latency so we don't begin mid-glitch.
    const now = ctx.currentTime;
    const lead = this.lastScheduledEnd > 0 ? 0 : 0.02;
    const startAt = Math.max(now + lead, this.lastScheduledEnd);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = PLAYBACK_RATE;
    src.connect(this.gain!);

    this.scheduledSources.add(src);
    this.pending += 1;
    src.onended = () => {
      this.scheduledSources.delete(src);
      try { src.disconnect(); } catch { /* */ }
      this.pending -= 1;
      if (this.pending === 0 && this.accumSamples === 0 && this.flushing) {
        this.flushing = false;
        if (this.flushResolve) {
          const r = this.flushResolve;
          this.flushResolve = null;
          r();
        }
      }
    };

    try {
      src.start(startAt);
    } catch (err) {
      console.warn('[PCMPlayback] source.start failed:', err);
      this.scheduledSources.delete(src);
      this.pending -= 1;
      return;
    }

    this.lastScheduledEnd = startAt + buffer.duration / PLAYBACK_RATE;

    console.log(
      '[PCMPlayback] segment scheduled — dur=%s start=%s end=%s pending=%d',
      buffer.duration.toFixed(3),
      startAt.toFixed(3),
      this.lastScheduledEnd.toFixed(3),
      this.pending,
    );
  }

  /** Set playback speed at runtime. */
  setPlaybackRate(rate: number): void {
    PLAYBACK_RATE = rate;
    // Apply to any currently-scheduled sources.
    for (const src of this.scheduledSources) {
      try {
        src.playbackRate.value = rate;
      } catch {
        /* */
      }
    }
  }

  flushPending(): void {
    // VPIO path has no per-utterance accumulator — everything is already
    // on its way to the Rust ring.
    if (this.vpioSink) return;
    void this.flushAccumToSegment();
  }

  async flush(): Promise<void> {
    // VPIO path: wait for the Rust output ring to drain so the user
    // hears the full utterance before the state machine transitions to
    // `listening`. Without this, turn_end → flush → immediate reset
    // flips the state while audio is still playing, opening the door
    // for false-positive barge-in on the AEC residual of the tail.
    if (this.vpioSink) {
      const sink = this.vpioSink;
      console.log('[PCMPlayback] flush() VPIO path — polling ring until empty');
      // Poll every 80ms until the ring is empty or 8s timeout.
      const deadline = Date.now() + 8000;
      let polls = 0;
      while (Date.now() < deadline) {
        const len = await sink.ringLen();
        polls += 1;
        if (polls <= 5 || polls % 10 === 0) {
          console.log('[PCMPlayback] flush() poll #%d — ring_len=%d', polls, len);
        }
        if (len <= 0) break;
        await new Promise<void>((r) => setTimeout(r, 80));
      }
      console.log('[PCMPlayback] flush() VPIO drain done after %d polls — calling reset()', polls);
      this.reset();
      return;
    }

    // Drain any remaining accumulated data
    await this.flushAccumToSegment();

    if (this.pending === 0) {
      this.reset();
      return;
    }

    // Wait for all scheduled buffers to finish.
    this.flushing = true;
    await new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      // Safety timeout
      setTimeout(() => {
        if (this.flushing) {
          this.flushing = false;
          this.flushResolve = null;
          resolve();
        }
      }, 30000);
    });
    this.reset();
  }

  private reset(): void {
    this.carry = null;
    this.accumBytes = [];
    this.accumSamples = 0;
    this.firstSegmentEmitted = false;
    this.flushing = false;
    this.flushResolve = null;
    this.lastScheduledEnd = 0;
    // Re-ancora o tracker de regressao ao currentTime atual — entre
    // utterances o ctx pode ter avancado muito, nao e regressao.
    if (this.ctx) this.lastSeenCurrentTime = this.ctx.currentTime;
  }

  /**
   * Stop all in-flight playback immediately (barge-in).
   *
   * Stops every scheduled source node, clears the accumulator, drops any
   * pending promise. Keeps ctx/analyser alive for reuse.
   */
  stop(): void {
    console.log('[PCMPlayback] stop() called');
    console.trace('[PCMPlayback] stop() stack');
    this.carry = null;
    this.accumBytes = [];
    this.accumSamples = 0;

    // VPIO path: also drain Rust's ring so the user hears silence
    // immediately on barge-in.
    if (this.vpioSink) {
      console.log('[PCMPlayback] stop() -> calling vpioSink.flushOutput()');
      void this.vpioSink.flushOutput();
    }

    for (const src of this.scheduledSources) {
      try { src.onended = null; } catch { /* */ }
      try { src.stop(); } catch { /* */ }
      try { src.disconnect(); } catch { /* */ }
    }
    this.scheduledSources.clear();
    this.pending = 0;
    this.lastScheduledEnd = 0;

    if (this.flushing) {
      this.flushing = false;
      if (this.flushResolve) {
        const r = this.flushResolve;
        this.flushResolve = null;
        r();
      }
    }
  }

  dispose(): void {
    this.stop();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.contextRecreatedUnsub) {
      this.contextRecreatedUnsub();
      this.contextRecreatedUnsub = null;
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch { /* */ }
      this.analyser = null;
    }
    if (this.gain) {
      try { this.gain.disconnect(); } catch { /* */ }
      this.gain = null;
    }
    this.analyserCallbacks = [];
    // Drop the VPIO playback-chunk subscription if one is active —
    // otherwise the JS analyser keeps receiving samples after dispose
    // and prevents listeners from being garbage-collected.
    this.vpioPlaybackUnsub?.();
    this.vpioPlaybackUnsub = null;
    this.ctx = null;
  }
}
