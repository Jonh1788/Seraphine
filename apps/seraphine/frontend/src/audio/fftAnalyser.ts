/**
 * JS-side AnalyserNode look-alike driven by raw Float32 PCM samples.
 *
 * Used in places where we can't plug into Web Audio — the VPIO path
 * (TTS/mic go through the Rust audio unit for AEC) and the realtime mic
 * waveform (cpal/VPIO events live outside Web Audio). Consumers cast to
 * `AnalyserNode` at the boundary; the shape matches what our avatar
 * lipsync, the Waveform visualiser, and the bot-RMS gate actually read:
 * `fftSize`, `frequencyBinCount`, `getFloatTimeDomainData`,
 * `getByteTimeDomainData`, `getByteFrequencyData`.
 *
 * Keeps a power-of-two ring buffer of the most recent `fftSize` samples
 * and runs a Hann-windowed radix-2 FFT in JS on demand. At 1024 FFT
 * every ~16 ms the cost is well under 1 % on an M4 Max.
 */
export class FFTAnalyser {
  readonly fftSize: number;
  readonly frequencyBinCount: number;
  /** Mimic AnalyserNode defaults — consumers read these but rarely set them. */
  readonly smoothingTimeConstant = 0.7;
  readonly minDecibels = -90;
  readonly maxDecibels = -20;

  private readonly ring: Float32Array;
  private ringPos = 0;
  private readonly smoothed: Float32Array;
  private readonly window: Float32Array;

  constructor(fftSize = 1024) {
    if ((fftSize & (fftSize - 1)) !== 0 || fftSize < 32) {
      throw new Error(`FFTAnalyser: fftSize must be a power of 2 ≥ 32 (got ${fftSize})`);
    }
    this.fftSize = fftSize;
    this.frequencyBinCount = fftSize / 2;
    this.ring = new Float32Array(fftSize);
    this.smoothed = new Float32Array(this.frequencyBinCount);
    this.window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i += 1) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
    }
  }

  /** Append samples to the ring. Older samples fall off. */
  push(samples: Float32Array): void {
    const N = this.fftSize;
    let p = this.ringPos;
    for (let i = 0; i < samples.length; i += 1) {
      this.ring[p] = samples[i];
      p += 1;
      if (p >= N) p = 0;
    }
    this.ringPos = p;
  }

  /** Fill `buf` with the most recent samples in chronological order (oldest first). */
  getFloatTimeDomainData(buf: Float32Array): void {
    const N = this.fftSize;
    const n = Math.min(buf.length, N);
    for (let i = 0; i < n; i += 1) {
      const idx = (this.ringPos + i) % N;
      buf[i] = this.ring[idx];
    }
  }

  /** 8-bit view of time-domain samples — 128 = silence, 0/255 = full amplitude. */
  getByteTimeDomainData(buf: Uint8Array): void {
    const N = this.fftSize;
    const n = Math.min(buf.length, N);
    for (let i = 0; i < n; i += 1) {
      const idx = (this.ringPos + i) % N;
      let s = this.ring[idx] * 128 + 128;
      if (s < 0) s = 0;
      else if (s > 255) s = 255;
      buf[i] = s | 0;
    }
  }

  /** 8-bit log-magnitude spectrum with EMA smoothing (like AnalyserNode). */
  getByteFrequencyData(buf: Uint8Array): void {
    const N = this.fftSize;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      const idx = (this.ringPos + i) % N;
      real[i] = this.ring[idx] * this.window[i];
    }
    fftRadix2(real, imag);
    const bins = Math.min(buf.length, this.frequencyBinCount);
    const alpha = this.smoothingTimeConstant;
    const range = this.maxDecibels - this.minDecibels;
    for (let i = 0; i < bins; i += 1) {
      const mag = Math.hypot(real[i], imag[i]) / N;
      const db = 20 * Math.log10(mag + 1e-12);
      let n = (db - this.minDecibels) / range;
      if (n < 0) n = 0;
      else if (n > 1) n = 1;
      this.smoothed[i] = this.smoothed[i] * alpha + n * (1 - alpha);
      buf[i] = Math.floor(this.smoothed[i] * 255);
    }
  }

  reset(): void {
    this.ring.fill(0);
    this.smoothed.fill(0);
    this.ringPos = 0;
  }
}

/** In-place iterative radix-2 Cooley–Tukey FFT. `real.length` must be a power of 2. */
function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const N = real.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i += 1) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = real[i]; real[i] = real[j]; real[j] = t;
      t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k;
        const b = a + half;
        const tr = real[b] * cr - imag[b] * ci;
        const ti = real[b] * ci + imag[b] * cr;
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
