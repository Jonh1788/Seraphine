/**
 * Thin wrapper around `@ricky0123/vad-web` (MicVAD) that emits typed
 * callbacks and exposes the mic AnalyserNode so a waveform visualiser
 * can render the live user audio.
 *
 * The VAD runs at 16 kHz / 512-sample frames (Silero legacy model) and
 * uses the shared AudioContext so it never fights CoreAudio for the
 * HAL lock on macOS.
 */
import * as ort from 'onnxruntime-web';
import { MicVAD } from '@ricky0123/vad-web';
import { getSharedAudioContext } from '../audio/sharedContext';
import { computeRmsFloat32 } from './gating';
import { isTauriMicAvailable } from '../audio/tauriMic';

// Disable threaded wasm worker. onnxruntime-web's default path spawns
// `new Worker(new URL('./ort-wasm-simd-threaded.mjs', ...))` for
// multithreaded inference. Vite's dev server resolves that URL to
// `/ort/ort-wasm-simd-threaded.mjs` (our public/ asset), tries to
// transform it as a module, and errors out because public files can't
// be imported from source. Silero VAD is ~1.5MB and runs comfortably
// single-threaded — disabling the worker sidesteps the whole problem.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
// wasm binaries are still served from /public/ort as static files.
ort.env.wasm.wasmPaths = '/ort/';

export interface RealtimeVADOptions {
  /** Fires when Silero commits to an actual speech segment. */
  onSpeechStart: () => void;
  /** Fires when redemption frames confirm speech has ended. */
  onSpeechEnd: (audio: Float32Array) => void;
  /** Fires for every processed frame (16 kHz, 512 samples). */
  onAudioFrame?: (frame: Float32Array) => void;
  /** Fires if speech started but was below `minSpeechFrames` (ignored chirp). */
  onMisfire?: () => void;
}

/**
 * Pre-started mic source. When provided, the VAD skips its own mic boot
 * and only subscribes to `onChunk`. Used so the VPIO session (which
 * already owns the mic for AEC purposes) is the single mic source in
 * realtime mode — preventing cpal/VPIO from both grabbing the default
 * input device.
 */
export interface ExternalMicSource {
  onChunk(cb: (pcm: Int16Array) => void): () => void;
}

export interface RealtimeVAD {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** AnalyserNode fed by the mic stream (for waveform rendering). */
  getAnalyser: () => AnalyserNode | null;
  /** True once `start()` has resolved and the VAD is listening. */
  isListening: () => boolean;
  /**
   * Mute the mic tracks (no audio enters VAD) without tearing down the
   * pipeline. Used now exclusively by the manual mute toggle — the
   * auto-mute-during-TTS workaround was replaced by the software AEC
   * gate in gating.ts, which keeps the mic live so barge-in works.
   */
  suspendForPlayback: () => void;
  /** Re-enable mic tracks after a manual mute toggle / cleanup. */
  resumeAfterPlayback: () => void;
  /** True when the mic tracks are currently hard-muted. */
  isSuspended: () => boolean;
  /**
   * Latest smoothed mic RMS on a 0..1 scale. Updated on every VAD
   * frame (~every 32ms at 16kHz/512 samples). Used by the barge-in
   * gating logic in `RealtimeController` to discount echo from the
   * speakers. Returns 0 while the mic is suspended.
   */
  getMicRms: () => number;
}

export async function createRealtimeVAD(
  opts: RealtimeVADOptions,
  externalMic?: ExternalMicSource,
): Promise<RealtimeVAD> {
  // Desktop (Tauri): WKWebView doesn't expose getUserMedia, so use our
  // native-capture-based VAD with energy detection instead of Silero.
  if (isTauriMicAvailable()) {
    const { createTauriRealtimeVAD } = await import('./tauriVad');
    return createTauriRealtimeVAD(opts, externalMic);
  }

  // Share the AudioContext with mic capture + playback so macOS CoreAudio
  // stays happy with a single HAL consumer.
  const audioContext = getSharedAudioContext();
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch { /* ignore */ }
  }

  // Capture our own mic stream so we can wire an AnalyserNode into it
  // for the waveform visualiser. We hand the same stream to MicVAD via
  // getStream so only one getUserMedia call happens.
  let micStream: MediaStream | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserSource: MediaStreamAudioSourceNode | null = null;

  const ensureMicStream = async (): Promise<MediaStream> => {
    if (micStream && micStream.getTracks().every((t) => t.readyState === 'live')) {
      return micStream;
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      analyserSource = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      analyserSource.connect(analyser);
      // NOTE: intentionally not connecting analyser to ctx.destination,
      // so the mic never feeds back into the speakers.
    } catch (err) {
      console.warn('[realtime-vad] analyser wiring failed:', err);
    }
    return micStream;
  };

  // State for the running mic-RMS EMA used by the barge-in gate. Declared
  // before MicVAD.new so the onFrameProcessed closure captures the
  // already-initialised binding rather than hitting TDZ on early frames.
  let listening = false;
  let suspended = false;
  let micRmsSmoothed = 0;

  // Conversation-tuned VAD timings (16 kHz / 512-sample frames, 32 ms each):
  //   minSpeechMs: 200    — reject sub-200ms chirps (cough, mouse click)
  //   redemptionMs: 750   — tolerate natural mid-sentence pauses up to
  //                         ~750 ms before declaring end-of-utterance.
  //                         Lower values fragmented "fala... pausa... fala"
  //                         into two separate audio_end round-trips.
  //   preSpeechPadMs: 64  — include 64 ms of pre-roll so the first phoneme
  //                         isn't clipped.
  const vad = await MicVAD.new({
    audioContext,
    model: 'legacy',
    positiveSpeechThreshold: 0.7,
    negativeSpeechThreshold: 0.3,
    minSpeechMs: 200,
    redemptionMs: 750,
    preSpeechPadMs: 64,
    submitUserSpeechOnPause: false,
    // Asset paths (served from /public by Vite — see /public/vad, /public/ort).
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/ort/',
    // Feed our pre-created mic stream so we keep a single capture source.
    getStream: async () => ensureMicStream(),
    pauseStream: async (stream) => {
      stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    },
    resumeStream: async (stream) => {
      stream.getAudioTracks().forEach((t) => { t.enabled = true; });
      return stream;
    },
    startOnLoad: false,
    onSpeechStart: () => {
      try { opts.onSpeechStart(); } catch (err) { console.error('[realtime-vad] onSpeechStart:', err); }
    },
    onSpeechEnd: (audio) => {
      try { opts.onSpeechEnd(audio); } catch (err) { console.error('[realtime-vad] onSpeechEnd:', err); }
    },
    onVADMisfire: () => {
      try { opts.onMisfire?.(); } catch (err) { console.error('[realtime-vad] onMisfire:', err); }
    },
    onFrameProcessed: (_probs, frame) => {
      // Update the running mic RMS on every processed frame so the
      // barge-in gate has a sub-50ms-fresh value to compare against
      // playback. When the mic is suspended the frame is silent (all
      // zeros from the muted track), which naturally drags the
      // smoothed value to 0 — good, since we never want a stale loud
      // reading to unblock barge-in after a manual mute.
      const instant = computeRmsFloat32(frame);
      // One-pole EMA (alpha ~0.3) gives a ~100ms effective window at
      // 32ms frames without a ring buffer allocation.
      micRmsSmoothed = micRmsSmoothed * 0.7 + instant * 0.3;
      if (opts.onAudioFrame) {
        try { opts.onAudioFrame(frame); } catch (err) { console.error('[realtime-vad] onAudioFrame:', err); }
      }
    },
  });

  return {
    start: async () => {
      if (listening) return;
      await ensureMicStream();
      await vad.start();
      listening = true;
    },
    stop: async () => {
      listening = false;
      try { await vad.pause(); } catch (err) { console.warn('[realtime-vad] pause failed:', err); }
      try { await vad.destroy(); } catch (err) { console.warn('[realtime-vad] destroy failed:', err); }
      if (analyserSource) {
        try { analyserSource.disconnect(); } catch { /* ignore */ }
        analyserSource = null;
      }
      if (analyser) {
        try { analyser.disconnect(); } catch { /* ignore */ }
        analyser = null;
      }
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
    },
    getAnalyser: () => analyser,
    isListening: () => listening,
    suspendForPlayback: () => {
      suspended = true;
      micRmsSmoothed = 0;
      if (micStream) {
        micStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      }
    },
    resumeAfterPlayback: () => {
      suspended = false;
      if (micStream) {
        micStream.getAudioTracks().forEach((t) => { t.enabled = true; });
      }
    },
    isSuspended: () => suspended,
    getMicRms: () => (suspended ? 0 : micRmsSmoothed),
  };
}
