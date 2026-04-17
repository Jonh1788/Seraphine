/**
 * Tauri-compatible VAD using Silero ONNX directly on PCM from
 * TauriMicCapture. Matches the quality of @ricky0123/vad-web's MicVAD
 * but skips getUserMedia (unavailable in WKWebView).
 */

import * as ort from 'onnxruntime-web';
import { MicCapture } from '../audio/micCapture';
import type { RealtimeVAD, RealtimeVADOptions } from './vad';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;                   // Silero legacy uses 512 samples at 16kHz
const MS_PER_FRAME = (FRAME_SIZE / SAMPLE_RATE) * 1000; // 32ms

// Silero thresholds (same as @ricky0123/vad-web defaults)
const POSITIVE_SPEECH_THRESHOLD = 0.7;
const NEGATIVE_SPEECH_THRESHOLD = 0.3;

const MIN_SPEECH_FRAMES = Math.ceil(200 / MS_PER_FRAME);   // 200ms
const REDEMPTION_FRAMES = Math.ceil(750 / MS_PER_FRAME);   // 750ms
const PRE_SPEECH_FRAMES = Math.ceil(64 / MS_PER_FRAME);    // 64ms

// Silero legacy model I/O
// Inputs: input (f32[1, 512]), h (f32[2, 1, 64]), c (f32[2, 1, 64]), sr (i64 scalar)
// Outputs: output (probability), hn, cn (new states)

let modelPromise: Promise<ort.InferenceSession> | null = null;
function getModel(): Promise<ort.InferenceSession> {
  if (!modelPromise) {
    // ORT env already configured in realtime/vad.ts (wasm paths etc.)
    modelPromise = ort.InferenceSession.create('/vad/silero_vad_legacy.onnx', {
      executionProviders: ['wasm'],
    });
  }
  return modelPromise;
}

export async function createTauriRealtimeVAD(
  opts: RealtimeVADOptions,
): Promise<RealtimeVAD> {
  const session = await getModel();
  const mic = new MicCapture();
  let listening = false;
  let suspended = false;
  let offChunk: (() => void) | null = null;

  // LSTM state (persists across frames)
  let h = new Float32Array(2 * 1 * 64);
  let c = new Float32Array(2 * 1 * 64);
  const sr = BigInt64Array.from([BigInt(SAMPLE_RATE)]);

  // Pre-roll sliding window
  const preBuffer: Float32Array[] = [];
  let utterance: Float32Array[] = [];

  let inSpeech = false;
  let speechFrames = 0;
  let silenceFrames = 0;
  let micRmsSmoothed = 0;
  // Debug: log a cada ~3s (~94 frames de 32ms) o estado do VAD pra
  // diagnosticar "eterno Ouvindo". Se rms=0 → mic não chega aqui.
  // Se rms>0 mas prob~0 → Silero não detecta. Se prob alto sem trigger
  // → threshold/redemption mal calibrado.
  let diagFrames = 0;
  let diagMaxProb = 0;

  const i16ToFloat32 = (pcm: Int16Array): Float32Array => {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      out[i] = pcm[i] / 32768.0;
    }
    return out;
  };

  const rms = (frame: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  };

  const runSilero = async (frame: Float32Array): Promise<number> => {
    const inputs = {
      input: new ort.Tensor('float32', frame, [1, FRAME_SIZE]),
      h: new ort.Tensor('float32', h, [2, 1, 64]),
      c: new ort.Tensor('float32', c, [2, 1, 64]),
      sr: new ort.Tensor('int64', sr, []),
    };
    const results = await session.run(inputs);
    // Update state. ORT-Web tensors podem apontar pra um WASM arena
    // compartilhado — usar .buffer.slice() pegava a heap inteira,
    // gerando arrays com tamanho errado e estado LSTM corrompido (Silero
    // ficava com prob ~0 pra sempre, eterno "Ouvindo"). .slice(0) no
    // próprio Float32Array copia respeitando byteOffset/length corretos.
    h = (results.hn.data as Float32Array).slice(0);
    c = (results.cn.data as Float32Array).slice(0);
    const prob = (results.output.data as Float32Array)[0];
    return prob;
  };

  const processFrame = async (frame: Float32Array): Promise<void> => {
    if (suspended) return;

    const energy = rms(frame);
    micRmsSmoothed = micRmsSmoothed * 0.7 + energy * 0.3;

    if (opts.onAudioFrame) {
      try { opts.onAudioFrame(frame); } catch (err) { console.error('[tauri-vad] frame:', err); }
    }

    // Run Silero inference
    let prob: number;
    try {
      prob = await runSilero(frame);
    } catch (err) {
      console.error('[tauri-vad] silero inference failed:', err);
      return;
    }

    diagFrames += 1;
    if (prob > diagMaxProb) diagMaxProb = prob;
    if (diagFrames >= 94) {
      console.log(
        `[tauri-vad] diag: rms=${micRmsSmoothed.toFixed(4)} maxProb=${diagMaxProb.toFixed(3)} inSpeech=${inSpeech}`,
      );
      diagFrames = 0;
      diagMaxProb = 0;
    }

    if (!inSpeech) {
      if (prob > POSITIVE_SPEECH_THRESHOLD) {
        speechFrames += 1;
        preBuffer.push(frame);
        if (preBuffer.length > PRE_SPEECH_FRAMES) preBuffer.shift();

        if (speechFrames >= MIN_SPEECH_FRAMES) {
          inSpeech = true;
          silenceFrames = 0;
          utterance = [...preBuffer];
          preBuffer.length = 0;
          try { opts.onSpeechStart(); } catch (err) { console.error('[tauri-vad] speechStart:', err); }
        }
      } else {
        if (speechFrames > 0 && speechFrames < MIN_SPEECH_FRAMES) {
          try { opts.onMisfire?.(); } catch { /* ignore */ }
        }
        speechFrames = 0;
        preBuffer.push(frame);
        if (preBuffer.length > PRE_SPEECH_FRAMES) preBuffer.shift();
      }
    } else {
      utterance.push(frame);

      if (prob < NEGATIVE_SPEECH_THRESHOLD) {
        silenceFrames += 1;
        if (silenceFrames >= REDEMPTION_FRAMES) {
          const total = utterance.reduce((n, f) => n + f.length, 0);
          const audio = new Float32Array(total);
          let off = 0;
          for (const f of utterance) {
            audio.set(f, off);
            off += f.length;
          }
          inSpeech = false;
          speechFrames = 0;
          silenceFrames = 0;
          utterance = [];
          try { opts.onSpeechEnd(audio); } catch (err) { console.error('[tauri-vad] speechEnd:', err); }
        }
      } else {
        silenceFrames = 0;
      }
    }
  };

  // Serialize frame processing to avoid overlapping async runs
  let processing = false;
  const pending: Float32Array[] = [];
  const pump = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    while (pending.length > 0) {
      const frame = pending.shift()!;
      await processFrame(frame);
    }
    processing = false;
  };

  let accumulator: Float32Array = new Float32Array(0);
  const pushChunk = (pcm: Int16Array): void => {
    const floats = i16ToFloat32(pcm);
    const merged = new Float32Array(accumulator.length + floats.length);
    merged.set(accumulator, 0);
    merged.set(floats, accumulator.length);
    let off = 0;
    while (merged.length - off >= FRAME_SIZE) {
      pending.push(merged.slice(off, off + FRAME_SIZE));
      off += FRAME_SIZE;
    }
    accumulator = merged.slice(off);
    void pump();
  };

  return {
    start: async () => {
      if (listening) return;
      // Reset LSTM state
      h = new Float32Array(2 * 1 * 64);
      c = new Float32Array(2 * 1 * 64);
      await mic.start();
      offChunk = mic.onChunk(pushChunk);
      listening = true;
    },
    stop: async () => {
      listening = false;
      offChunk?.();
      offChunk = null;
      mic.stop();
      preBuffer.length = 0;
      utterance = [];
      pending.length = 0;
      accumulator = new Float32Array(0);
      inSpeech = false;
      speechFrames = 0;
      silenceFrames = 0;
    },
    getAnalyser: () => null,
    isListening: () => listening,
    suspendForPlayback: () => {
      suspended = true;
      micRmsSmoothed = 0;
    },
    resumeAfterPlayback: () => {
      suspended = false;
    },
    isSuspended: () => suspended,
    getMicRms: () => (suspended ? 0 : micRmsSmoothed),
  };
}
