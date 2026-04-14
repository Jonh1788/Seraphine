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
import { getSharedAudioContext } from './sharedContext';

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

  constructor() {}

  /**
   * Lazily initialise the AudioContext, AnalyserNode, and Gain.
   * MUST be called from a user-gesture context the first time so the
   * browser lets the AudioContext start in "running" state.
   */
  ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    this.ctx = getSharedAudioContext();

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;

    // Source chain: AudioBufferSourceNode → gain → analyser → destination.
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    console.log('[PCMPlayback] AudioContext created, state:', this.ctx.state);

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
    };
    try {
      this.ctx.addEventListener('statechange', onStateChange);
    } catch {
      /* old browsers */
    }

    for (const cb of this.analyserCallbacks) {
      cb(this.analyser);
    }
    this.analyserCallbacks = [];
    return this.ctx;
  }

  getAnalyser(onReady?: (a: AnalyserNode) => void): AnalyserNode | null {
    if (this.analyser) return this.analyser;
    if (onReady) this.analyserCallbacks.push(onReady);
    return null;
  }

  pushChunk(buf: ArrayBuffer): void {
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return;

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
      this.flushAccumToSegment();
    }
  }

  /** Convert accumulated PCM into an AudioBuffer and schedule for playback. */
  private flushAccumToSegment(): void {
    if (this.accumSamples === 0) return;
    const ctx = this.ensureCtx();

    // Merge all accumulated byte arrays
    const totalBytes = this.accumBytes.reduce((s, a) => s + a.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const a of this.accumBytes) {
      merged.set(a, offset);
      offset += a.byteLength;
    }
    const sampleCount = this.accumSamples;
    this.accumBytes = [];
    this.accumSamples = 0;
    this.firstSegmentEmitted = true;

    // Pre-kick ctx if suspended (macOS/Safari).
    if (ctx.state !== 'running') {
      ctx.resume().catch((err) =>
        console.warn('[PCMPlayback] pre-schedule resume failed:', err),
      );
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
    this.flushAccumToSegment();
  }

  async flush(): Promise<void> {
    // Drain any remaining accumulated data
    this.flushAccumToSegment();

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
  }

  /**
   * Stop all in-flight playback immediately (barge-in).
   *
   * Stops every scheduled source node, clears the accumulator, drops any
   * pending promise. Keeps ctx/analyser alive for reuse.
   */
  stop(): void {
    this.carry = null;
    this.accumBytes = [];
    this.accumSamples = 0;

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
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch { /* */ }
      this.analyser = null;
    }
    if (this.gain) {
      try { this.gain.disconnect(); } catch { /* */ }
      this.gain = null;
    }
    this.analyserCallbacks = [];
    this.ctx = null;
  }
}
