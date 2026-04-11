/**
 * Thin wrapper around `@ricky0123/vad-web` (MicVAD) that emits typed
 * callbacks and exposes the mic AnalyserNode so a waveform visualiser
 * can render the live user audio.
 *
 * The VAD runs at 16 kHz / 512-sample frames (Silero legacy model) and
 * uses the shared AudioContext so it never fights CoreAudio for the
 * HAL lock on macOS.
 */
import { MicVAD } from '@ricky0123/vad-web';
import { getSharedAudioContext } from '../audio/sharedContext';

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

export interface RealtimeVAD {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** AnalyserNode fed by the mic stream (for waveform rendering). */
  getAnalyser: () => AnalyserNode | null;
  /** True once `start()` has resolved and the VAD is listening. */
  isListening: () => boolean;
}

export async function createRealtimeVAD(
  opts: RealtimeVADOptions,
): Promise<RealtimeVAD> {
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

  // At 16 kHz / 512-sample frames, each frame is 32 ms.
  // The original brief specified these in frames; convert to ms:
  //   minSpeechFrames: 4   -> 128 ms
  //   redemptionFrames: 8  -> 256 ms
  //   preSpeechPadFrames: 1 -> 32 ms
  const vad = await MicVAD.new({
    audioContext,
    model: 'legacy',
    positiveSpeechThreshold: 0.7,
    negativeSpeechThreshold: 0.3,
    minSpeechMs: 128,
    redemptionMs: 256,
    preSpeechPadMs: 32,
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
      if (opts.onAudioFrame) {
        try { opts.onAudioFrame(frame); } catch (err) { console.error('[realtime-vad] onAudioFrame:', err); }
      }
    },
  });

  let listening = false;

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
  };
}
