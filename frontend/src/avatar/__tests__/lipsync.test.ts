import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, envelopeToVisemes } from "../lipsync";

describe("envelopeToVisemes", () => {
  const sum = (w: { aa: number; ih: number; ou: number; closed: number }): number =>
    w.aa + w.ih + w.ou + w.closed;

  it("fully closed below 0.05", () => {
    const w = envelopeToVisemes(0);
    expect(w).toEqual({ aa: 0, ih: 0, ou: 0, closed: 1 });
    const w2 = envelopeToVisemes(0.049);
    expect(w2.closed).toBe(1);
  });

  it("blends toward aa in [0.05, 0.20)", () => {
    const w = envelopeToVisemes(0.125);
    expect(w.aa).toBeGreaterThan(0);
    expect(w.aa).toBeLessThan(1);
    expect(w.ih).toBe(0);
    expect(w.ou).toBe(0);
    expect(w.closed).toBeGreaterThan(0);
  });

  it("blends from aa to ih in [0.20, 0.40)", () => {
    const w = envelopeToVisemes(0.3);
    expect(w.aa).toBeGreaterThan(0);
    expect(w.ih).toBeGreaterThan(0);
    expect(w.ou).toBe(0);
    // roughly halfway
    expect(Math.abs(w.aa - w.ih)).toBeLessThan(0.1);
  });

  it("is fully ou at or above 0.40", () => {
    const w = envelopeToVisemes(0.4);
    expect(w).toEqual({ aa: 0, ih: 0, ou: 1, closed: 0 });
    const w2 = envelopeToVisemes(1.5);
    expect(w2.ou).toBe(1);
  });

  it("handles boundary 0.05 deterministically", () => {
    const w = envelopeToVisemes(0.05);
    expect(w.aa).toBe(0);
    expect(w.closed).toBe(1);
  });

  it("handles boundary 0.20 deterministically", () => {
    const w = envelopeToVisemes(0.2);
    // transitions into [aa, ih) at t=0 → aa=1, ih=0
    expect(w.aa).toBe(1);
    expect(w.ih).toBe(0);
    expect(w.closed).toBe(0);
  });

  it("handles boundary 0.40 deterministically", () => {
    const w = envelopeToVisemes(0.4);
    expect(w.ou).toBe(1);
  });

  it("weights always sum to <=1 (and closed makes total 1)", () => {
    const samples = [0, 0.02, 0.05, 0.1, 0.19, 0.2, 0.25, 0.3, 0.39, 0.4, 0.6, 1];
    for (const r of samples) {
      const w = envelopeToVisemes(r);
      expect(w.aa + w.ih + w.ou).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(sum(w) - 1)).toBeLessThan(1e-9);
      expect(w.aa).toBeGreaterThanOrEqual(0);
      expect(w.ih).toBeGreaterThanOrEqual(0);
      expect(w.ou).toBeGreaterThanOrEqual(0);
      expect(w.closed).toBeGreaterThanOrEqual(0);
    }
  });

  it("respects custom thresholds", () => {
    const w = envelopeToVisemes(0.5, { closed: 0.1, aa: 0.3, ih: 0.6 });
    expect(w.aa).toBeGreaterThan(0);
    expect(w.ih).toBeGreaterThan(0);
  });

  it("DEFAULT_THRESHOLDS matches spec", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ closed: 0.05, aa: 0.2, ih: 0.4 });
  });
});
