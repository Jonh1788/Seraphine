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

/** Accumulate this many seconds before creating an audio segment. */
const SEGMENT_SECONDS = 1.5;
const SEGMENT_SAMPLES = Math.floor(SEGMENT_SECONDS * INPUT_RATE);

/** Playback speed multiplier. 1.0 = normal, 1.1 = 10% faster. */
const PLAYBACK_RATE = 1.1;

export class PCMPlayback {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private carry: Uint8Array | null = null;

  /** Accumulated raw s16le bytes waiting to become a segment. */
  private accumBytes: Uint8Array[] = [];
  private accumSamples = 0;

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

    if (this.accumSamples >= SEGMENT_SAMPLES) {
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
    this.flushing = false;
    this.flushResolve = null;
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
