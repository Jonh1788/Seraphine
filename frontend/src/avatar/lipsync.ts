import type { VRM } from "@pixiv/three-vrm";

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
 * Pure and deterministic. Weights are normalized so aa+ih+ou+closed === 1
 * and aa+ih+ou <= 1.
 */
export function envelopeToVisemes(
  rms: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): VisemeWeights {
  const r = Math.max(0, rms);
  const { closed, aa, ih } = thresholds;

  let aaW = 0;
  let ihW = 0;
  let ouW = 0;

  if (r < closed) {
    // fully closed
  } else if (r < aa) {
    // blend toward aa linearly across [closed, aa)
    const t = (r - closed) / (aa - closed);
    aaW = clamp01(t);
  } else if (r < ih) {
    // blend toward ih linearly across [aa, ih)
    const t = (r - aa) / (ih - aa);
    aaW = clamp01(1 - t);
    ihW = clamp01(t);
  } else {
    ouW = 1;
  }

  const sum = aaW + ihW + ouW;
  const capped = sum > 1 ? 1 : sum;
  if (sum > 1) {
    const k = 1 / sum;
    aaW *= k;
    ihW *= k;
    ouW *= k;
  }
  const closedW = 1 - capped;
  return { aa: aaW, ih: ihW, ou: ouW, closed: closedW };
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

  const AudioCtxCtor: typeof AudioContext =
    typeof window !== "undefined" && "AudioContext" in window
      ? window.AudioContext
      : (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext;
  const audioCtx = new AudioCtxCtor({ sampleRate: 24000 });

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(audioCtx.destination);

  const timeData = new Float32Array(analyser.fftSize);
  let smoothed = 0;
  let rafId = 0;
  let stopped = false;

  const setViseme = (name: "aa" | "ih" | "ou" | "neutral", value: number): void => {
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
      buffer.copyToChannel(f32, 0, 0);
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

  try {
    await audioCtx.close();
  } catch {
    // ignore
  }
}
