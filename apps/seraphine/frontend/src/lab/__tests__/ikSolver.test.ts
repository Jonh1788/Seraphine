/**
 * Tests for the IK solvers (SDD 075 Phase 3/4).
 *
 * Focus areas:
 *  - solveHeadLookAt produces unit quaternions for sane targets.
 *  - The multi-target weighted-average algorithm used by VrmAvatarController
 *    stays normalized (no NaN, no over-rotation) when fed 2+ inputs.
 *    This mirrors the exact math in applyPostUpdate's IK head loop.
 *  - solveArmIK no-ops cleanly when the target sits on top of the shoulder.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { solveHeadLookAt, solveArmIK, worldQuatToLocal } from '../ikSolver';

function makeHead(): Object3D {
  const root = new Object3D();
  const head = new Object3D();
  head.position.set(0, 1.5, 0);
  root.add(head);
  root.updateMatrixWorld(true);
  return head;
}

/**
 * Mirror of the loop body in VrmAvatarController.applyPostUpdate's IK
 * head pass. Kept here as a small testable function so we can exercise
 * the weighted-average math without spinning up a full VRM.
 */
function blendHeadTargets(
  head: Object3D,
  targets: Array<{ worldTarget: Vector3; weight: number }>,
): Quaternion {
  const qFk = head.quaternion.clone();
  const accum = new Quaternion(0, 0, 0, 0);
  let totalWeight = 0;
  for (const { worldTarget, weight } of targets) {
    if (weight <= 0) continue;
    head.updateWorldMatrix(true, false);
    const desiredWorld = solveHeadLookAt(head, worldTarget);
    const desiredLocal = worldQuatToLocal(desiredWorld, head);
    const dot =
      accum.x * desiredLocal.x +
      accum.y * desiredLocal.y +
      accum.z * desiredLocal.z +
      accum.w * desiredLocal.w;
    const sign = dot < 0 ? -1 : 1;
    accum.x += sign * weight * desiredLocal.x;
    accum.y += sign * weight * desiredLocal.y;
    accum.z += sign * weight * desiredLocal.z;
    accum.w += sign * weight * desiredLocal.w;
    totalWeight += weight;
  }
  const out = qFk.clone();
  if (totalWeight > 0) {
    const lenSq =
      accum.x * accum.x + accum.y * accum.y + accum.z * accum.z + accum.w * accum.w;
    if (lenSq > 1e-8) {
      accum.normalize();
      out.slerp(accum, Math.min(totalWeight, 1));
    }
  }
  return out;
}

describe('solveHeadLookAt', () => {
  it('returns a unit quaternion for a target in front of the head', () => {
    const head = makeHead();
    const q = solveHeadLookAt(head, new Vector3(0, 1.5, 5));
    const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(len).toBeCloseTo(1, 5);
    expect(Number.isFinite(q.x)).toBe(true);
  });

  it('handles a target collapsed onto the bone without NaN', () => {
    const head = makeHead();
    const q = solveHeadLookAt(head, new Vector3(0, 1.5, 0));
    expect(Number.isFinite(q.x)).toBe(true);
    expect(Number.isFinite(q.w)).toBe(true);
  });
});

describe('weighted-average head IK (multi-target)', () => {
  it('produces a unit quaternion with two targets', () => {
    const head = makeHead();
    const result = blendHeadTargets(head, [
      { worldTarget: new Vector3(1, 1.5, 5), weight: 0.5 },
      { worldTarget: new Vector3(-1, 1.5, 5), weight: 0.5 },
    ]);
    const len = Math.sqrt(
      result.x * result.x + result.y * result.y + result.z * result.z + result.w * result.w,
    );
    expect(len).toBeCloseTo(1, 5);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(Number.isFinite(result.z)).toBe(true);
    expect(Number.isFinite(result.w)).toBe(true);
  });

  it('order of targets does not affect the final orientation', () => {
    const headA = makeHead();
    const headB = makeHead();
    const t1 = { worldTarget: new Vector3(2, 1.5, 4), weight: 0.7 };
    const t2 = { worldTarget: new Vector3(-1, 2.0, 3), weight: 0.3 };
    const a = blendHeadTargets(headA, [t1, t2]);
    const b = blendHeadTargets(headB, [t2, t1]);
    // Quaternions q and -q represent the same rotation; compare by absolute dot.
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    expect(dot).toBeCloseTo(1, 4);
  });

  it('three identical targets yield the same orientation as one', () => {
    const headA = makeHead();
    const headB = makeHead();
    const target = new Vector3(0.5, 1.6, 4);
    const single = blendHeadTargets(headA, [{ worldTarget: target, weight: 1 }]);
    const triple = blendHeadTargets(headB, [
      { worldTarget: target, weight: 0.34 },
      { worldTarget: target, weight: 0.33 },
      { worldTarget: target, weight: 0.33 },
    ]);
    const dot = Math.abs(
      single.x * triple.x + single.y * triple.y + single.z * triple.z + single.w * triple.w,
    );
    expect(dot).toBeCloseTo(1, 4);
  });

  it('zero-weight targets are skipped without NaN', () => {
    const head = makeHead();
    const result = blendHeadTargets(head, [
      { worldTarget: new Vector3(1, 1.5, 5), weight: 0 },
      { worldTarget: new Vector3(-1, 1.5, 5), weight: 0 },
    ]);
    // No effective weight -> stays at FK base (identity here).
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.z).toBe(0);
    expect(result.w).toBe(1);
  });
});

describe('solveArmIK', () => {
  it('returns identity quats and reachable=false when target collapses on shoulder', () => {
    const root = new Object3D();
    const shoulder = new Object3D();
    const elbow = new Object3D();
    const hand = new Object3D();
    shoulder.position.set(0, 1.4, 0);
    elbow.position.set(0.3, 0, 0);
    hand.position.set(0.3, 0, 0);
    root.add(shoulder);
    shoulder.add(elbow);
    elbow.add(hand);
    root.updateMatrixWorld(true);

    const shoulderWorld = new Vector3();
    shoulder.getWorldPosition(shoulderWorld);
    const result = solveArmIK(shoulder, elbow, hand, shoulderWorld.clone(), new Vector3(1, 0, 0));
    expect(result.reachable).toBe(false);
    expect(Number.isFinite(result.upperArmLocal.x)).toBe(true);
    expect(Number.isFinite(result.lowerArmLocal.w)).toBe(true);
    // Identity quaternion: (0,0,0,1).
    expect(result.upperArmLocal.w).toBe(1);
    expect(result.lowerArmLocal.w).toBe(1);
  });
});
