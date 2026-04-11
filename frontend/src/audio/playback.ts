/**
 * Streaming PCM player using HTMLAudioElement.
 *
 * Previous approaches using Web Audio API (AudioBufferSourceNode,
 * ScriptProcessorNode) all crashed macOS CoreAudio. This approach
 * bypasses the Web Audio graph entirely:
 *
 * 1. Accumulate s16le PCM chunks into a buffer
 * 2. When enough data arrives, wrap it in a WAV header
 * 3. Create a Blob URL and play it via an <audio> element
 * 4. Chain successive audio elements for gapless playback
 *
 * The AnalyserNode for lipsync uses a separate MediaElementSource
 * from the playing <audio> element.
 */
import { getSharedAudioContext } from './sharedContext';

/** Input PCM sample rate from the TTS server. */
const INPUT_RATE = 24000;

/**
 * First segment is small so the player starts making sound almost
 * immediately. Previous value was 1.5s, meaning the user waited a full
 * 1.5 seconds of accumulated PCM before hearing the first byte — a
 * massive TTFB hit. 0.35s is short enough to feel instant and still
 * large enough that HTMLAudioElement doesn't stutter on initial load.
 */
const FIRST_SEGMENT_SECONDS = 0.35;
const FIRST_SEGMENT_SAMPLES = Math.floor(FIRST_SEGMENT_SECONDS * INPUT_RATE);
/**
 * Subsequent segments are larger to reduce blob-URL churn. The first
 * segment is already playing by the time these are built, so their
 * size affects gapless continuity, not perceived latency.
 */
const NEXT_SEGMENT_SECONDS = 1.0;
const NEXT_SEGMENT_SAMPLES = Math.floor(NEXT_SEGMENT_SECONDS * INPUT_RATE);

/**
 * Playback speed multiplier. Keep at 1.0 when the TTS backend applies
 * server-side speed (e.g. ElevenLabs voice_settings.speed). Using
 * HTMLAudioElement.playbackRate > 1 pitch-shifts the voice and makes
 * it sound cartoonish; server-side speed preserves pitch.
 */
const PLAYBACK_RATE = 1.0;

export class PCMPlayback {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private carry: Uint8Array | null = null;

  /** Accumulated raw s16le bytes waiting to become a segment. */
  private accumBytes: Uint8Array[] = [];
  private accumSamples = 0;
  /**
   * First segment per utterance uses the small threshold for fast TTFB;
   * subsequent segments use the larger threshold. Reset to false on
   * every new utterance via `flush()` / `reset()`.
   */
  private firstSegmentEmitted = false;

  /** Queue of WAV blob URLs ready to play. */
  private queue: string[] = [];
  /** Currently playing audio element. */
  private currentAudio: HTMLAudioElement | null = null;
  private currentSource: MediaElementAudioSourceNode | null = null;
  /** Whether we're actively playing through the queue. */
  private playing = false;
  /** Guard against double-calling playNext from onerror + play().catch */
  private playNextScheduled = false;

  private flushResolve: (() => void) | null = null;
  private flushing = false;

  private analyserCallbacks: ((a: AnalyserNode) => void)[] = [];

  constructor() {}

  /**
   * Lazily initialise the AudioContext and AnalyserNode.
   * MUST be called from a user-gesture context the first time so the
   * browser lets the AudioContext start in "running" state.
   */
  ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    this.ctx = getSharedAudioContext();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.connect(this.ctx.destination);

    console.log('[PCMPlayback] AudioContext created, state:', this.ctx.state);

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

  /** Convert accumulated PCM into a WAV blob URL and enqueue for playback. */
  private flushAccumToSegment(): void {
    if (this.accumSamples === 0) return;

    // Merge all accumulated byte arrays
    const totalBytes = this.accumBytes.reduce((s, a) => s + a.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const a of this.accumBytes) {
      merged.set(a, offset);
      offset += a.byteLength;
    }
    this.accumBytes = [];
    this.accumSamples = 0;
    // Any subsequent segment in this utterance uses the larger threshold.
    this.firstSegmentEmitted = true;

    // Create WAV blob
    const wav = createWavBlob(merged, INPUT_RATE);
    const url = URL.createObjectURL(wav);
    this.queue.push(url);

    console.log('[PCMPlayback] segment created, queue length:', this.queue.length, 'bytes:', totalBytes);

    // Start playback if not already playing
    if (!this.playing) {
      this.playing = true;
      this.playNext();
    }
  }

  /** Play the next segment from the queue. */
  private playNext(): void {
    this.playNextScheduled = false;

    // Clean up previous
    if (this.currentSource) {
      try { this.currentSource.disconnect(); } catch { /* ignore */ }
      this.currentSource = null;
    }
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      if (this.currentAudio.src) URL.revokeObjectURL(this.currentAudio.src);
      this.currentAudio = null;
    }

    if (this.queue.length === 0) {
      this.playing = false;
      // If flushing and no more segments, we're done
      if (this.flushing) {
        this.flushing = false;
        if (this.flushResolve) {
          const r = this.flushResolve;
          this.flushResolve = null;
          r();
        }
      }
      return;
    }

    const url = this.queue.shift()!;
    const audio = new Audio(url);
    audio.playbackRate = PLAYBACK_RATE;
    this.currentAudio = audio;

    // Flag to prevent double-advancing from onerror + play().catch
    let advanced = false;
    const advance = (): void => {
      if (advanced) return;
      advanced = true;
      URL.revokeObjectURL(url);
      // Schedule playNext asynchronously to avoid stack buildup
      if (!this.playNextScheduled) {
        this.playNextScheduled = true;
        queueMicrotask(() => this.playNext());
      }
    };

    audio.onended = () => {
      console.log('[PCMPlayback] segment ended');
      advance();
    };

    audio.onerror = (ev) => {
      console.warn('[PCMPlayback] audio error:', ev);
      advance();
    };

    // Try to connect to AnalyserNode for lipsync, but NEVER let this
    // prevent audio from playing. createMediaElementSource() re-routes
    // the element output through the AudioContext graph, so the context
    // MUST be running for sound to come out.
    let connectedToGraph = false;
    const ctx = this.ctx;
    if (ctx && this.analyser && ctx.state === 'running') {
      try {
        const source = ctx.createMediaElementSource(audio);
        source.connect(this.analyser);
        this.currentSource = source;
        connectedToGraph = true;
        console.log('[PCMPlayback] connected to analyser graph');
      } catch (err) {
        console.warn('[PCMPlayback] createMediaElementSource failed, playing directly:', err);
        // Audio element will play directly to speakers (no analyser)
      }
    }

    console.log('[PCMPlayback] playing segment, connectedToGraph:', connectedToGraph,
      'ctx state:', ctx?.state ?? 'none');

    audio.play().then(() => {
      console.log('[PCMPlayback] play() started successfully');
    }).catch((err) => {
      console.warn('[PCMPlayback] play() rejected:', err);
      // If autoplay is truly blocked, do NOT silently skip all segments.
      // Instead, wait for a user gesture. But if we just keep advancing
      // we'll drain the entire queue without playing anything.
      // Only advance if this is a non-recoverable error.
      advance();
    });
  }

  /**
   * Push any PCM bytes currently sitting in the accumulator into a
   * queued segment WITHOUT waiting for playback to drain. Safe to call
   * repeatedly — does not touch `flushResolve` / `flushing`, so it
   * won't collide with a concurrent `flush()` awaiting full drain.
   *
   * Used by per-sentence `tts_end` handlers that want the tail of each
   * sentence to play but don't need to block on it.
   */
  flushPending(): void {
    this.flushAccumToSegment();
  }

  async flush(): Promise<void> {
    // Drain any remaining accumulated data
    this.flushAccumToSegment();

    if (!this.playing && this.queue.length === 0) {
      this.reset();
      return;
    }

    // Wait for all segments to finish playing
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
  }

  /**
   * Stop all in-flight playback immediately (barge-in).
   *
   * Clears the pending queue, pauses and releases the currently playing
   * <audio> element, and drops any accumulated PCM bytes. Does NOT touch
   * the AudioContext or AnalyserNode, so the instance stays reusable for
   * the next turn.
   */
  stop(): void {
    // Pending accumulator
    this.carry = null;
    this.accumBytes = [];
    this.accumSamples = 0;

    // Drain queued segments
    for (const url of this.queue) {
      URL.revokeObjectURL(url);
    }
    this.queue = [];

    // Tear down the playing element without disposing the graph
    if (this.currentSource) {
      try { this.currentSource.disconnect(); } catch { /* ignore */ }
      this.currentSource = null;
    }
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      try { this.currentAudio.pause(); } catch { /* ignore */ }
      if (this.currentAudio.src) URL.revokeObjectURL(this.currentAudio.src);
      this.currentAudio = null;
    }

    this.playing = false;
    this.playNextScheduled = false;

    // If a flush() was awaiting, release it
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
    // Stop current playback
    if (this.currentSource) {
      try { this.currentSource.disconnect(); } catch { /* ignore */ }
    }
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      if (this.currentAudio.src) URL.revokeObjectURL(this.currentAudio.src);
    }
    // Clear queue
    for (const url of this.queue) {
      URL.revokeObjectURL(url);
    }
    this.queue = [];
    this.currentAudio = null;
    this.currentSource = null;
    this.playing = false;
    this.reset();
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch { /* ignore */ }
      this.analyser = null;
    }
    this.analyserCallbacks = [];
    this.ctx = null;
  }
}

/** Create a WAV Blob from raw s16le PCM data. */
function createWavBlob(pcm: Uint8Array, sampleRate: number): Blob {
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + pcm.byteLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);  // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);

  // Copy PCM data
  new Uint8Array(buffer, headerSize).set(pcm);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
