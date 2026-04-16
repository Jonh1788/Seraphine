/**
 * Mic capture with downsampling to 16 kHz PCM16.
 *
 * Uses the shared AudioContext to avoid creating a second context
 * that deadlocks CoreAudio on macOS.
 *
 * In Tauri (desktop) mode, delegates to TauriMicCapture which uses
 * native CoreAudio via cpal — because WKWebView doesn't expose
 * navigator.mediaDevices on macOS.
 */
import { getSharedAudioContext } from './sharedContext';
import { TauriMicCapture, isTauriMicAvailable } from './tauriMic';

type ChunkListener = (pcm: Int16Array) => void;

const TARGET_RATE = 16000;

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  /** Silent sink so the ScriptProcessorNode runs without playing mic audio. */
  private silentGain: GainNode | null = null;
  private listeners = new Set<ChunkListener>();
  /** Tauri native capture — used when running inside desktop app. */
  private tauri: TauriMicCapture | null = null;

  async start(): Promise<void> {
    // Desktop (Tauri): use native Rust/cpal capture
    if (isTauriMicAvailable()) {
      this.tauri = new TauriMicCapture();
      this.tauri.onChunk((pcm) => {
        this.listeners.forEach((cb) => cb(pcm));
      });
      await this.tauri.start();
      return;
    }

    // Browser: Web Audio API
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Reuse the shared AudioContext (never create a new one).
    this.ctx = getSharedAudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    const processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    const inRate = this.ctx.sampleRate;

    processor.onaudioprocess = (ev: AudioProcessingEvent): void => {
      const input = ev.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(input, inRate, TARGET_RATE);
      const pcm = new Int16Array(resampled.length);
      for (let i = 0; i < resampled.length; i += 1) {
        const s = Math.max(-1, Math.min(1, resampled[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.listeners.forEach((cb) => cb(pcm));
    };

    // Connect processor to a silent GainNode instead of ctx.destination
    // to avoid playing the mic input through speakers (feedback loop).
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(this.ctx.destination);

    this.source.connect(processor);
    processor.connect(this.silentGain);
  }

  stop(): void {
    // Tauri path
    if (this.tauri) {
      void this.tauri.stop();
      this.tauri = null;
      return;
    }
    // Disconnect audio nodes but do NOT close the shared AudioContext.
    this.processor?.disconnect();
    this.source?.disconnect();
    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch { /* ignore */ }
      this.silentGain = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.processor = null;
    this.source = null;
    this.stream = null;
    // Keep this.ctx reference but don't close it — it's shared.
    this.ctx = null;
  }

  onChunk(cb: ChunkListener): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }
}

function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
