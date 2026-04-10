/**
 * Streaming PCM player with a small leading pre-buffer.
 *
 * AudioContext is created lazily on the first user gesture (via
 * pushChunk or an explicit resume call) to avoid the
 * "AudioContext encountered an error" spam on browsers that block
 * context creation before a user interaction.
 */
const PREBUFFER_SECONDS = 0.6;

/**
 * Playback rate multiplier applied to every scheduled source.
 * 1.03 = ~3% faster, pitch shift essentially inaudible.
 */
const PLAYBACK_RATE = 1.03;

/** Input PCM sample rate from the TTS server. */
const INPUT_RATE = 24000;

export class PCMPlayback {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private pendingFloats: Float32Array[] = [];
  private pendingDuration = 0;
  private started = false;
  private carry: Uint8Array | null = null;
  private disposed = false;

  // Deferred analyser consumers. When getAnalyser() is called before
  // the AudioContext exists, we store the callback and fire it once
  // the context is created.
  private analyserCallbacks: ((a: AnalyserNode) => void)[] = [];

  constructor() {
    // AudioContext is created lazily — only when pushChunk() is
    // called (i.e. real audio data arrives from the TTS server).
    // We do NOT create it on user gesture alone because that still
    // triggers "AudioContext encountered an error" on some systems
    // where the audio device isn't ready.
  }

  /** Create the AudioContext + AnalyserNode. Idempotent. */
  private initCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();

    // Suppress the "AudioContext encountered an error from the audio
    // device" message that some browsers emit when the system audio
    // output is unavailable or not yet ready. This is a device-level
    // error, not a coding mistake — the context still works once the
    // device becomes available (e.g. after Bluetooth connects).
    this.ctx.addEventListener('statechange', () => {
      if (this.ctx?.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
    });

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.connect(this.ctx.destination);

    // Fire deferred analyser callbacks
    for (const cb of this.analyserCallbacks) {
      cb(this.analyser);
    }
    this.analyserCallbacks = [];

    return this.ctx;
  }

  /**
   * Get the AnalyserNode for lipsync. If the AudioContext hasn't been
   * created yet (no user gesture), returns null and calls `onReady`
   * when it becomes available.
   */
  getAnalyser(onReady?: (a: AnalyserNode) => void): AnalyserNode | null {
    if (this.analyser) return this.analyser;
    if (onReady) {
      this.analyserCallbacks.push(onReady);
    }
    return null;
  }

  pushChunk(buf: ArrayBuffer): void {
    let bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return;
    const ctx = this.initCtx();
    if (ctx.state === 'suspended') void ctx.resume();

    if (this.carry) {
      const merged = new Uint8Array(this.carry.byteLength + bytes.byteLength);
      merged.set(this.carry, 0);
      merged.set(bytes, this.carry.byteLength);
      bytes = merged;
      this.carry = null;
    }

    const evenLen = bytes.byteLength - (bytes.byteLength % 2);
    if (evenLen < bytes.byteLength) {
      this.carry = bytes.slice(evenLen);
    }
    if (evenLen === 0) return;

    const aligned = new ArrayBuffer(evenLen);
    new Uint8Array(aligned).set(bytes.subarray(0, evenLen));
    const view = new Int16Array(aligned);
    if (view.length === 0) return;
    const float = new Float32Array(view.length);
    for (let i = 0; i < view.length; i += 1) {
      float[i] = view[i] / 32768;
    }

    if (!this.started) {
      this.pendingFloats.push(float);
      this.pendingDuration += float.length / INPUT_RATE;
      if (this.pendingDuration >= PREBUFFER_SECONDS) {
        this.flushPrebuffer();
      }
      return;
    }
    this.scheduleSource(float);
  }

  private flushPrebuffer(): void {
    const totalLen = this.pendingFloats.reduce((s, a) => s + a.length, 0);
    if (totalLen === 0) {
      this.started = true;
      return;
    }
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const f of this.pendingFloats) {
      merged.set(f, offset);
      offset += f.length;
    }
    this.pendingFloats = [];
    this.pendingDuration = 0;
    this.nextStartTime = this.ctx?.currentTime ?? 0;
    this.scheduleSource(merged);
    this.started = true;
  }

  /** Resample from 24 kHz to the AudioContext's native sample rate. */
  private resample(samples: Float32Array): Float32Array {
    const outRate = this.ctx!.sampleRate;
    if (outRate === INPUT_RATE) return samples;
    const ratio = outRate / INPUT_RATE;
    const outLen = Math.round(samples.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i / ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const frac = srcPos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  private scheduleSource(samples: Float32Array): void {
    const ctx = this.ctx!;
    const resampled = this.resample(samples);
    const audioBuf = ctx.createBuffer(1, resampled.length, ctx.sampleRate);
    audioBuf.copyToChannel(resampled, 0);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.playbackRate.value = PLAYBACK_RATE;
    src.connect(this.analyser!);
    const now = ctx.currentTime;
    const start = Math.max(now, this.nextStartTime);
    src.start(start);
    this.nextStartTime = start + audioBuf.duration / PLAYBACK_RATE;
    this.scheduled.push(src);
    src.onended = (): void => {
      this.scheduled = this.scheduled.filter((s) => s !== src);
    };
  }

  async flush(): Promise<void> {
    if (!this.started && this.pendingFloats.length > 0) {
      this.flushPrebuffer();
    }
    const wait = this.nextStartTime - (this.ctx?.currentTime ?? 0);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    this.started = false;
    this.nextStartTime = 0;
    this.carry = null;
  }

  dispose(): void {
    this.disposed = true;
    for (const evt of GESTURE_EVENTS) {
      // Clean up is best-effort; listener may already be removed.
      try { document.removeEventListener(evt, () => {}); } catch { /* ignore */ }
    }
    this.scheduled.forEach((s) => {
      try { s.stop(); } catch { /* ignore */ }
    });
    this.scheduled = [];
    this.pendingFloats = [];
    this.pendingDuration = 0;
    this.started = false;
    this.carry = null;
    this.analyserCallbacks = [];
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.analyser = null;
    }
  }
}

const GESTURE_EVENTS = ['touchstart', 'touchend', 'mousedown', 'keydown'] as const;
