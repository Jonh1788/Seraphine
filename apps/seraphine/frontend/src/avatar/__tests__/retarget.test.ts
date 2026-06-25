import { describe, it, expect } from 'vitest';
import { Quaternion } from 'three';
import { rebaseQuaternion, applyVrm0QuatFlip, scaleHipsInPlace } from '../retarget';

describe('rebaseQuaternion', () => {
  it('returns the input rotation unchanged when both rest poses are identity', () => {
    const q = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as any, 0.5);
    const out = rebaseQuaternion(q, new Quaternion(), new Quaternion());
    expect(out.x).toBeCloseTo(q.x, 6);
    expect(out.y).toBeCloseTo(q.y, 6);
    expect(out.z).toBeCloseTo(q.z, 6);
    expect(out.w).toBeCloseTo(q.w, 6);
  });

  it('does not mutate its inputs', () => {
    const q = new Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    const before = q.clone();
    rebaseQuaternion(q, new Quaternion(0, 0, 0.2, 0.98).normalize(), new Quaternion(0, 0.1, 0, 0.99).normalize());
    expect(q.equals(before)).toBe(true);
  });

  it('composes parentRest · q · restInverse', () => {
    const parent = new Quaternion(0, 0, 0.2588, 0.9659); // ~30deg about Z
    const rest = new Quaternion(0, 0.3827, 0, 0.9239);   // ~45deg about Y
    const q = new Quaternion(0.2588, 0, 0, 0.9659);      // ~30deg about X
    const expected = parent.clone().multiply(q).multiply(rest.clone().invert());
    const out = rebaseQuaternion(q, parent, rest.clone().invert());
    expect(out.x).toBeCloseTo(expected.x, 6);
    expect(out.y).toBeCloseTo(expected.y, 6);
    expect(out.z).toBeCloseTo(expected.z, 6);
    expect(out.w).toBeCloseTo(expected.w, 6);
  });
});

describe('applyVrm0QuatFlip', () => {
  it('negates x and z, keeps y and w', () => {
    const out = applyVrm0QuatFlip(new Quaternion(0.1, 0.2, 0.3, 0.4));
    expect(out.x).toBeCloseTo(-0.1, 6);
    expect(out.y).toBeCloseTo(0.2, 6);
    expect(out.z).toBeCloseTo(-0.3, 6);
    expect(out.w).toBeCloseTo(0.4, 6);
  });
});

describe('scaleHipsInPlace', () => {
  it('zeroes X and Z and scales Y', () => {
    expect(scaleHipsInPlace(2, 0.5)).toEqual([0, 1, 0]);
  });
});
