export class PCMPlayback {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];

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
    const audioBuf = this.ctx.createBuffer(1, float.length, 24000);
    audioBuf.copyToChannel(float, 0);

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
    const wait = this.nextStartTime - this.ctx.currentTime;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
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
    void this.ctx.close();
  }
}
