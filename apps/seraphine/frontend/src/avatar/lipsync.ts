import type { VRM } from "@pixiv/three-vrm";
import { getSharedAudioContext } from "../audio/sharedContext";

export interface LipsyncOptions {
  thresholds?: { closed: number; aa: number; ih: number };
  alpha?: number;
  debug?: boolean;
}

export interface VisemeWeights {
  aa: number;
  ih: number;
  ou: number;
  closed: number;
  /** Optional — only set in blend regions; absent in closed / fully-ou edge cases. */
  ee?: number;
  /** Optional — only set in blend regions; absent in closed / fully-ou edge cases. */
  oh?: number;
}

export const DEFAULT_THRESHOLDS = { closed: 0.05, aa: 0.2, ih: 0.4 } as const;

type Thresholds = { closed: number; aa: number; ih: number };

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Map an RMS envelope value to viseme weights.
 *
 * Deterministic piecewise interpolation across three thresholds:
 *   - r < closed       → fully closed (closed=1)
 *   - closed ≤ r < aa  → blend closed → aa
 *   - aa     ≤ r < ih  → blend aa → ih
 *   - r ≥ ih           → fully `ou` (closed=0)
 *
 * `aa + ih + ou + closed` always equals 1. `ee` and `oh` are not driven
 * by amplitude alone — they are set by phoneme-aware paths if any, and
 * are absent from this function's output (callers should treat missing
 * keys as 0).
 */
export function envelopeToVisemes(
  rms: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): VisemeWeights {
  const r = Math.max(0, rms);
  const { closed: closedTh, aa: aaTh, ih: ihTh } = thresholds;

  if (r < closedTh) {
    return { aa: 0, ih: 0, ou: 0, closed: 1 };
  }

  if (r < aaTh) {
    // Blend closed → aa across [closedTh, aaTh).
    const span = aaTh - closedTh;
    const t = span > 0 ? clamp01((r - closedTh) / span) : 1;
    return { aa: t, ih: 0, ou: 0, closed: 1 - t };
  }

  if (r < ihTh) {
    // Blend aa → ih across [aaTh, ihTh).
    const span = ihTh - aaTh;
    const t = span > 0 ? clamp01((r - aaTh) / span) : 1;
    return { aa: 1 - t, ih: t, ou: 0, closed: 0 };
  }

  // r >= ihTh: fully ou.
  return { aa: 0, ih: 0, ou: 1, closed: 0 };
}

function u8ToFloat32(chunk: Uint8Array): Float32Array {
  // Ensure we have an even number of bytes; trim trailing odd byte.
  const byteLen = chunk.byteLength - (chunk.byteLength % 2);
  // Copy to a fresh ArrayBuffer to guarantee alignment.
  const aligned = new Uint8Array(byteLen);
  aligned.set(chunk.subarray(0, byteLen));
  const i16 = new Int16Array(aligned.buffer, 0, byteLen / 2);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / 32768;
  }
  return f32;
}

/**
 * Play a PCM (s16le, 24kHz, mono) stream while driving VRM viseme blendshapes.
 * Resolves when the stream is drained and playback has caught up.
 */
export async function playAudioWithLipSync(
  stream: ReadableStream<Uint8Array>,
  vrm: VRM | null,
  opts: LipsyncOptions = {},
): Promise<void> {
  const thresholds = opts.thresholds ?? { ...DEFAULT_THRESHOLDS };
  const alpha = opts.alpha ?? 0.3;

  // Share the global AudioContext to avoid macOS HAL contention from
  // spinning up a second context (CoreAudio deadlocks when multiple
  // contexts compete for the hardware). The shared context's sampleRate
  // may not be 24 kHz — that's fine; AudioBufferSourceNode resamples on
  // playback. We still build buffers at the input rate (24 kHz) so the
  // PCM is decoded correctly.
  const audioCtx = getSharedAudioContext();

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(audioCtx.destination);

  const timeData = new Float32Array(analyser.fftSize);
  let smoothed = 0;
  let rafId = 0;
  let stopped = false;

  const setViseme = (name: "aa" | "ih" | "ou", value: number): void => {
    vrm?.expressionManager?.setValue(name, value);
  };

  const tick = (): void => {
    if (stopped) return;
    const anyAnalyser = analyser as AnalyserNode & {
      getFloatTimeDomainData(array: Float32Array): void;
    };
    anyAnalyser.getFloatTimeDomainData(timeData);
    let sumSq = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = timeData[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / timeData.length);
    smoothed = alpha * rms + (1 - alpha) * smoothed;
    const w = envelopeToVisemes(smoothed, thresholds);
    setViseme("aa", w.aa);
    setViseme("ih", w.ih);
    setViseme("ou", w.ou);
    if (opts.debug) {
      // eslint-disable-next-line no-console
      console.debug("[lipsync]", { rms, smoothed, w });
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  let nextStartTime = audioCtx.currentTime;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength < 2) continue;
      const f32 = u8ToFloat32(value);
      if (f32.length === 0) continue;
      const buffer = audioCtx.createBuffer(1, f32.length, 24000);
      buffer.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0, 0);
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      const startAt = Math.max(nextStartTime, audioCtx.currentTime);
      src.start(startAt);
      nextStartTime = startAt + buffer.duration;
    }
  } finally {
    reader.releaseLock();
  }

  // Wait for playback to finish
  const waitMs = Math.max(0, (nextStartTime - audioCtx.currentTime) * 1000) + 50;
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

  stopped = true;
  cancelAnimationFrame(rafId);
  // reset visemes to closed
  vrm?.expressionManager?.setValue("aa", 0);
  vrm?.expressionManager?.setValue("ih", 0);
  vrm?.expressionManager?.setValue("ou", 0);

  // Disconnect our analyser so it stops pulling samples; do NOT close
  // the AudioContext — it's the shared singleton owned by sharedContext.
  try {
    analyser.disconnect();
  } catch {
    // ignore
  }
}
