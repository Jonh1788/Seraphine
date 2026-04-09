/**
 * Streaming PCM player with a small leading pre-buffer.
 *
 * The TTS upstream (Voxtral 4B MLX) generates audio at RTF ~1.3 — slightly
 * slower than realtime — so chunks arrive in bursts with gaps between them.
 * If we schedule each chunk back-to-back the player catches up to the
 * buffer head and stalls, producing audible pauses.
 *
 * Fix: hold playback until we have at least PREBUFFER_SECONDS of audio
 * accumulated. After that initial cushion, each new chunk lands ahead of
 * the play head by roughly that cushion, absorbing the upstream jitter.
 *
 * If the upstream falls behind by more than the cushion the player will
 * eventually starve again — there is no way around an upstream RTF > 1
 * without increasing the cushion or speeding up the producer.
 */
const PREBUFFER_SECONDS = 0.6;

export class PCMPlayback {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private pendingFloats: Float32Array[] = [];
  private pendingDuration = 0;
  private started = false;

  constructor() {
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ sampleRate: 24000 });
  }

  pushChunk(buf: ArrayBuffer): void {
    const view = new Int16Array(buf);
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
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    const start = Math.max(now, this.nextStartTime);
    src.start(start);
    this.nextStartTime = start + audioBuf.duration;
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
    void this.ctx.close();
  }
}
