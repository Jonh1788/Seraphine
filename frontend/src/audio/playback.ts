/**
 * Streaming PCM player with a small leading pre-buffer.
 *
 * The current TTS upstream (Qwen3-TTS-12Hz with Triton-accelerated
 * kernels) generates audio at RTF ~0.33 warm — about 3x faster than
 * realtime. So each sentence's TTS wall time lands well ahead of the
 * previous sentence's playback end, leaving the scheduler comfortably
 * ahead. The cushion only needs to absorb brief jitter, not an RTF > 1
 * producer gap.
 *
 * 0.6 s is enough to swallow normal network / server jitter without
 * adding noticeable time-to-first-audio. If we ever regress to an
 * RTF > 1 upstream, bump this back up (we had 2.5 s for the non-Triton
 * build of the same server).
 */
const PREBUFFER_SECONDS = 0.6;

/**
 * Playback rate multiplier applied to every scheduled source.
 *
 * The Qwen3-TTS server has no speed/rate field, so we accelerate
 * client-side via Web Audio `AudioBufferSourceNode.playbackRate`.
 * This is a simple resample — it also raises pitch slightly (tape-
 * speed-up effect), but up to ~1.2x the shift is imperceptible for
 * natural speech. Above 1.25 voices start to sound chipmunk.
 *
 * 1.15 = ~15% faster, still sounds natural.
 *
 * IMPORTANT: with rate > 1, a buffer of `duration` seconds plays in
 * `duration / rate` wall seconds. The scheduler's `nextStartTime`
 * bookkeeping must use the SHORTENED wall duration, otherwise
 * consecutive chunks leave an audible gap of `duration * (1 - 1/rate)`
 * between them.
 */
const PLAYBACK_RATE = 1.15;

export class PCMPlayback {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private pendingFloats: Float32Array[] = [];
  private pendingDuration = 0;
  private started = false;
  // The vllm-omni raw PCM path delivers HTTP chunks at arbitrary byte
  // boundaries — sometimes odd-sized — so a single 16-bit sample can be
  // split across two pushChunk() calls. We buffer a single trailing byte
  // here and prepend it to the next chunk to keep alignment.
  private carry: Uint8Array | null = null;

  constructor() {
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ sampleRate: 24000 });
  }

  pushChunk(buf: ArrayBuffer): void {
    let bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return;

    if (this.carry) {
      const merged = new Uint8Array(this.carry.byteLength + bytes.byteLength);
      merged.set(this.carry, 0);
      merged.set(bytes, this.carry.byteLength);
      bytes = merged;
      this.carry = null;
    }

    const evenLen = bytes.byteLength - (bytes.byteLength % 2);
    if (evenLen < bytes.byteLength) {
      // Stash the trailing odd byte for the next chunk.
      this.carry = bytes.slice(evenLen);
    }
    if (evenLen === 0) return;

    // Copy the aligned bytes into a fresh ArrayBuffer so the Int16Array
    // view is guaranteed 2-byte aligned regardless of the source buffer
    // (slice() / Uint8Array views can be byteOffset-misaligned).
    const aligned = new ArrayBuffer(evenLen);
    new Uint8Array(aligned).set(bytes.subarray(0, evenLen));
    const view = new Int16Array(aligned);
    if (view.length === 0) return;
    const float = new Float32Array(view.length);
    for (let i = 0; i < view.length; i += 1) {
      float[i] = view[i] / 32768;
    }

    if (!this.started) {
      // Buffer until we have PREBUFFER_SECONDS, then schedule the whole
      // accumulated buffer as one source and switch to streaming mode.
      this.pendingFloats.push(float);
      this.pendingDuration += float.length / 24000;
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
    this.nextStartTime = this.ctx.currentTime;
    this.scheduleSource(merged);
    this.started = true;
  }

  private scheduleSource(samples: Float32Array): void {
    const audioBuf = this.ctx.createBuffer(1, samples.length, 24000);
    audioBuf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = audioBuf;
    src.playbackRate.value = PLAYBACK_RATE;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    const start = Math.max(now, this.nextStartTime);
    src.start(start);
    // Wall-clock duration is compressed by the playback rate.
    this.nextStartTime = start + audioBuf.duration / PLAYBACK_RATE;
    this.scheduled.push(src);
    src.onended = (): void => {
      this.scheduled = this.scheduled.filter((s) => s !== src);
    };
  }

  async flush(): Promise<void> {
    // Force-drain any remaining pre-buffer when the upstream finishes
    // before reaching the cushion threshold (e.g. very short replies).
    if (!this.started && this.pendingFloats.length > 0) {
      this.flushPrebuffer();
    }
    const wait = this.nextStartTime - this.ctx.currentTime;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    // Reset for the next utterance so the cushion logic re-engages.
    this.started = false;
    this.nextStartTime = 0;
    this.carry = null;
  }

  dispose(): void {
    this.scheduled.forEach((s) => {
      try {
        s.stop();
      } catch {
        // ignore
      }
    });
    this.scheduled = [];
    this.pendingFloats = [];
    this.pendingDuration = 0;
    this.started = false;
    this.carry = null;
    void this.ctx.close();
  }
}
