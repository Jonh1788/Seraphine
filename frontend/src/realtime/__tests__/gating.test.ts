import { describe, expect, it } from 'vitest';
import {
  MIC_OVER_PLAYBACK_RATIO,
  MIN_MIC_RMS,
  computeRmsByteTimeDomain,
  computeRmsFloat32,
  shouldAllowBargeIn,
} from '../gating';

describe('shouldAllowBargeIn', () => {
  it('allows barge-in when mic is much louder than playback', () => {
    // mic >> playback, both above floor
    expect(shouldAllowBargeIn(0.10, 0.05)).toBe(true);
  });

  it('rejects barge-in when mic and playback are equal', () => {
    // Equal levels look like pure echo -> reject
    expect(shouldAllowBargeIn(0.05, 0.05)).toBe(false);
  });

  it('rejects barge-in when both are below the mic floor (silent room)', () => {
    expect(shouldAllowBargeIn(0.001, 0.0)).toBe(false);
  });

  it('rejects barge-in when mic is below floor even if playback is silent', () => {
    // Breathing / fan hum in a quiet moment between sentences — playback
    // momentarily 0 but mic hasn't actually picked up speech yet.
    expect(shouldAllowBargeIn(MIN_MIC_RMS * 0.9, 0.0)).toBe(false);
  });

  it('allows barge-in when playback is silent and mic clears the floor', () => {
    expect(shouldAllowBargeIn(MIN_MIC_RMS * 1.5, 0.0)).toBe(true);
  });

  it('rejects barge-in when mic is above floor but below the ratio', () => {
    // Playback = 0.05, ratio threshold = 0.05 * 1.6 = 0.08
    // Mic at 0.08 does NOT exceed 0.08 — reject (strict >)
    expect(shouldAllowBargeIn(0.08, 0.05, 1.6)).toBe(false);
  });

  it('allows barge-in when mic clears the ratio with a lower ratio', () => {
    // Playback = 0.05, ratio threshold = 0.05 * 1.4 = 0.07
    // Mic at 0.08 > 0.07 — allow
    expect(shouldAllowBargeIn(0.08, 0.05, 1.4)).toBe(true);
  });

  it('uses the default ratio constant when not provided', () => {
    // Playback = 0.04, default threshold = 0.04 * 1.5 = 0.06
    expect(shouldAllowBargeIn(0.061, 0.04)).toBe(true);
    expect(shouldAllowBargeIn(0.059, 0.04)).toBe(false);
  });

  it('rejects NaN / Infinity defensively', () => {
    expect(shouldAllowBargeIn(Number.NaN, 0.05)).toBe(false);
    expect(shouldAllowBargeIn(0.1, Number.NaN)).toBe(false);
    expect(shouldAllowBargeIn(Number.POSITIVE_INFINITY, 0.05)).toBe(false);
  });

  it('uses default MIC_OVER_PLAYBACK_RATIO = 1.5', () => {
    expect(MIC_OVER_PLAYBACK_RATIO).toBe(1.5);
  });

  it('uses default MIN_MIC_RMS = 0.015', () => {
    expect(MIN_MIC_RMS).toBe(0.015);
  });
});

describe('computeRmsFloat32', () => {
  it('returns 0 for empty input', () => {
    expect(computeRmsFloat32(new Float32Array(0))).toBe(0);
  });

  it('returns 0 for all-zero buffer', () => {
    expect(computeRmsFloat32(new Float32Array(512))).toBe(0);
  });

  it('returns 1 for a full-scale DC signal', () => {
    const f = new Float32Array(8).fill(1);
    expect(computeRmsFloat32(f)).toBeCloseTo(1, 6);
  });

  it('returns ~0.707 for a full-scale sine', () => {
    const N = 1024;
    const f = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      f[i] = Math.sin((2 * Math.PI * i) / N);
    }
    expect(computeRmsFloat32(f)).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

describe('computeRmsByteTimeDomain', () => {
  it('returns 0 for a centred (all-128) buffer', () => {
    const b = new Uint8Array(512).fill(128);
    expect(computeRmsByteTimeDomain(b)).toBe(0);
  });

  it('returns ~1 for a full-scale square wave', () => {
    const N = 256;
    const b = new Uint8Array(N);
    for (let i = 0; i < N; i += 1) b[i] = i % 2 === 0 ? 0 : 255;
    // Values map to roughly -1 and ~0.9921 -> RMS ~= 0.996
    const r = computeRmsByteTimeDomain(b);
    expect(r).toBeGreaterThan(0.99);
    expect(r).toBeLessThanOrEqual(1);
  });

  it('returns 0 for empty input', () => {
    expect(computeRmsByteTimeDomain(new Uint8Array(0))).toBe(0);
  });
});
