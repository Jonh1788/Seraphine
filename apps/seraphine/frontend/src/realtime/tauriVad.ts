/**
 * Tauri-compatible VAD using Silero ONNX directly on PCM from
 * TauriMicCapture. Matches the quality of @ricky0123/vad-web's MicVAD
 * but skips getUserMedia (unavailable in WKWebView).
 */

import * as ort from 'onnxruntime-web';
import { FFTAnalyser } from '../audio/fftAnalyser';
import { MicCapture } from '../audio/micCapture';
import type { ExternalMicSource, RealtimeVAD, RealtimeVADOptions } from './vad';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;                   // Silero legacy uses 512 samples at 16kHz
const MS_PER_FRAME = (FRAME_SIZE / SAMPLE_RATE) * 1000; // 32ms

// Silero thresholds (same as @ricky0123/vad-web defaults)
const POSITIVE_SPEECH_THRESHOLD = 0.7;
const NEGATIVE_SPEECH_THRESHOLD = 0.3;

const MIN_SPEECH_FRAMES = Math.ceil(200 / MS_PER_FRAME);   // 200ms
// 500ms of silence before declaring "speech ended". 750ms (Silero/MicVAD
// default) was a perceptible "she's slow" pause in realtime conversation
// — humans pause ~250-400ms mid-sentence, so 500ms still survives natural
// pauses while shaving ~250ms off every reply's floor latency.
const REDEMPTION_FRAMES = Math.ceil(500 / MS_PER_FRAME);   // 500ms
const PRE_SPEECH_FRAMES = Math.ceil(64 / MS_PER_FRAME);    // 64ms

// Silero legacy model I/O
// Inputs: input (f32[1, 512]), h (f32[2, 1, 64]), c (f32[2, 1, 64]), sr (i64 scalar)
// Outputs: output (probability), hn, cn (new states)
//
// NOTA: a InferenceSession é criada POR INSTÂNCIA de VAD (não módulo-global).
// ORT-Web não aceita session.run() concorrentes; quando compartilhávamos uma
// única session entre wake-word VAD e realtime VAD, a transição (tear-down
// de um + boot do outro) disparava session.run paralelos e causava "Session
// already started" / "Session mismatch" / "Out of bounds memory access" no
// ort-wasm-simd-threaded.jsep.mjs. Per-instance isola o estado LSTM e a
// serialização interna do ORT por session resolve o problema.

// Lock module-level pra serializar create/release de InferenceSession.
// ORT-Web compartilha estado WASM global entre sessions — se uma release()
// estiver em voo quando um create() roda (usuario fecha+reabre realtime
// rapido), o WASM fica em estado inconsistente e os proximos session.run()
// falham com "Session already started" / "Session mismatch". Encadeamos
// todas as operacoes de ciclo de vida numa unica Promise pra garantir que
// nunca se sobrepoem.
let sessionLifecycleLock: Promise<void> = Promise.resolve();

function withSessionLock<T>(op: () => Promise<T>): Promise<T> {
  const prev = sessionLifecycleLock;
  let release!: () => void;
  sessionLifecycleLock = new Promise<void>((r) => {
    release = r;
  });
  return prev
    .catch(() => {
      /* swallow previous failure; we just need serialization */
    })
    .then(op)
    .finally(() => release());
}

export async function createTauriRealtimeVAD(
  opts: RealtimeVADOptions,
  externalMic?: ExternalMicSource,
): Promise<RealtimeVAD> {
  // ORT env configurado em realtime/vad.ts (wasm paths etc.).
  // Tenta WebGPU primeiro: roda inferência no GPU via Metal, async
  // por natureza, sem bloquear o JS main thread. Se WKWebView não
  // suportar WebGPU (ou o modelo tiver ops não suportados), o ORT
  // cai automaticamente pra wasm. Antes: 100% das inferências (a
  // cada 32ms) bloqueavam o main thread por 5-15ms cada — visível
  // como engasgos de 150-400ms quando combinava com GC do WASM.
  const session = await withSessionLock(() =>
    ort.InferenceSession.create('/vad/silero_vad_legacy.onnx', {
      executionProviders: ['webgpu', 'wasm'],
    }),
  );
  // When an external mic is provided (VPIO session), we don't own the
  // mic lifecycle — just subscribe to its chunks. Otherwise fall back to
  // our own cpal-backed MicCapture.
  const mic = externalMic ? null : new MicCapture();
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

  let disposed = false;

  const runSilero = async (frame: Float32Array): Promise<number> => {
    // Guard: se stop() rolou enquanto um frame estava na fila, a session
    // pode já ter sido release()ada. Chamar session.run() nela gera
    // "Session mismatch" ou acesso a memória inválida do WASM.
    if (disposed) return 0;
    // IMPORTANTE: session.run() tambem vai pelo lock. ORT-Web compartilha
    // o modulo WASM globalmente, entao run() concorrente entre sessions
    // diferentes (ex: VAD antigo drenando enquanto VAD novo ja comecou)
    // corrompe o heap — "Session already started", "Out of bounds memory
    // access", "null is not an object". O lock impede sobreposicao.
    return withSessionLock(async () => {
      if (disposed) return 0;
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
    });
  };

  const processFrame = async (frame: Float32Array): Promise<void> => {
    // Bail out as early as possible if stop() ran. Without this guard the
    // pump can still be mid-await on the previous frame when disposed
    // flips, then resume here and dispatch onSpeechEnd against an
    // already-torn-down VAD. Also re-check after the await below before
    // any callback fires.
    if (disposed) return;
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
    // After the await: if stop() ran while runSilero was in flight, prob
    // is 0 (runSilero returns 0 when disposed) — but treating 0 as silence
    // here would still drive the state machine and could fire
    // onSpeechEnd against partial audio during teardown. Bail out.
    if (disposed) return;

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
    if (disposed) return;
    processing = true;
    while (pending.length > 0) {
      if (disposed) break;
      const frame = pending.shift()!;
      await processFrame(frame);
    }
    processing = false;
  };

  // JS-side analyser for the realtime waveform. Kept off Web Audio on
  // purpose — routing the mic PCM through an AudioBufferSource tail caused
  // static during TTS (audio-thread contention) and echo leakage through
  // the silent-gain output. Waveform only needs frequencyBinCount +
  // getByteFrequencyData, both of which this provides.
  const micAnalyser = new FFTAnalyser(1024);

  let accumulator: Float32Array = new Float32Array(0);
  let chunksLogged = 0;
  const pushChunk = (pcm: Int16Array): void => {
    if (chunksLogged < 3) {
      let maxAbs = 0;
      for (let i = 0; i < pcm.length; i += 1) {
        const v = pcm[i];
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
      }
      console.log(
        '[tauri-vad] pcm chunk: len=%d byteLength=%d maxAbs=%d preview=%o',
        pcm.length,
        pcm.byteLength,
        maxAbs,
        Array.from(pcm.slice(0, 8)),
      );
      chunksLogged += 1;
    }
    const floats = i16ToFloat32(pcm);
    if (!suspended) micAnalyser.push(floats);
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
      micAnalyser.reset();
      if (mic) {
        await mic.start();
        offChunk = mic.onChunk(pushChunk);
      } else if (externalMic) {
        offChunk = externalMic.onChunk(pushChunk);
      }
      listening = true;
    },
    stop: async () => {
      listening = false;
      disposed = true;
      offChunk?.();
      offChunk = null;
      // Only stop the mic we own; the external mic's lifecycle is the
      // caller's responsibility.
      mic?.stop();
      preBuffer.length = 0;
      utterance = [];
      pending.length = 0;
      accumulator = new Float32Array(0);
      inSpeech = false;
      speechFrames = 0;
      silenceFrames = 0;
      micAnalyser.reset();
      // Espera qualquer inferência em voo terminar antes de liberar a
      // session — release() durante um session.run() ativo trava o WASM.
      // O runSilero respeita disposed=true e vira no-op pros frames novos,
      // mas o último que já entrou no await precisa drenar.
      while (processing) {
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      // release() precisa entrar no mesmo lock do create() — senao
      // um create() concorrente (usuario reabre realtime antes do stop
      // terminar) colide no estado WASM global do ORT.
      try {
        await withSessionLock(() => session.release());
      } catch (err) {
        console.warn('[tauri-vad] session release failed:', err);
      }
    },
    getAnalyser: () => micAnalyser as unknown as AnalyserNode,
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
