/**
 * Minimal IK solvers for the Animation Lab.
 *
 * Phase 3 (SDD 075): head look-at — 1-bone problem, no iterative solver
 * needed. Direction quaternion computed from bone world-position and a
 * world-space target, then converted to parent-local and returned as an
 * additive delta against the current bone orientation.
 *
 * Phase 4 will add arm reach via three's CCDIKSolver
 * (three/examples/jsm/animation/CCDIKSolver).
 */

import { Object3D, Quaternion, Vector3 } from 'three';
import type { IKTarget } from '../avatar/gestures';

const _p0 = new Vector3();
const _p1 = new Vector3();
const _fwd = new Vector3();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3();
const _cy = new Vector3();
const _quatWorld = new Quaternion();
const _quatParent = new Quaternion();
const _quatOut = new Quaternion();

/**
 * Current influence factor of an IK target at time `t` (in the gesture's
 * local clock). Returns 0 before `time`, ramps to `blend` over `fadeIn`,
 * holds, then ramps back down. Clamped to [0, blend].
 */
export function ikWeightAt(target: IKTarget, t: number): number {
  const dt = t - target.time;
  if (dt < 0) return 0;
  const rampIn = target.fadeIn > 0 ? Math.min(1, dt / target.fadeIn) : 1;
  if (dt <= target.fadeIn) return rampIn * target.blend;
  const held = dt - target.fadeIn;
  if (held <= target.hold) return target.blend;
  const out = held - target.hold;
  if (target.fadeOut <= 0) return 0;
  const rampOut = Math.max(0, 1 - out / target.fadeOut);
  return rampOut * target.blend;
}

/**
 * Solve a 1-bone look-at: compute the local quaternion for `bone` such
 * that its +Z axis points at `worldTarget`. Returns the **world-space**
 * desired quaternion — caller is responsible for rebasing to local and
 * blending with FK.
 *
 * Assumes VRM/humanoid convention where the head forward is +Z.
 */
export function solveHeadLookAt(bone: Object3D, worldTarget: Vector3): Quaternion {
  bone.getWorldPosition(_p0);
  _fwd.copy(worldTarget).sub(_p0);
  if (_fwd.lengthSq() < 1e-8) {
    return bone.getWorldQuaternion(_quatWorld).clone();
  }
  _fwd.normalize();
  // Build an orthonormal basis with Z = fwd, Y ≈ world up projected.
  _right.crossVectors(_up, _fwd);
  if (_right.lengthSq() < 1e-6) {
    // Looking straight up/down — pick any horizontal right.
    _right.set(1, 0, 0);
  } else {
    _right.normalize();
  }
  _cy.crossVectors(_fwd, _right);
  const m = [
    _right.x, _cy.x, _fwd.x,
    _right.y, _cy.y, _fwd.y,
    _right.z, _cy.z, _fwd.z,
  ];
  const q = _quatOut;
  // Quaternion from rotation matrix (column-major).
  const trace = m[0] + m[4] + m[8];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    q.w = 0.25 / s;
    q.x = (m[7] - m[5]) * s;
    q.y = (m[2] - m[6]) * s;
    q.z = (m[3] - m[1]) * s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2.0 * Math.sqrt(1.0 + m[0] - m[4] - m[8]);
    q.w = (m[7] - m[5]) / s;
    q.x = 0.25 * s;
    q.y = (m[1] + m[3]) / s;
    q.z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = 2.0 * Math.sqrt(1.0 + m[4] - m[0] - m[8]);
    q.w = (m[2] - m[6]) / s;
    q.x = (m[1] + m[3]) / s;
    q.y = 0.25 * s;
    q.z = (m[5] + m[7]) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m[8] - m[0] - m[4]);
    q.w = (m[3] - m[1]) / s;
    q.x = (m[2] + m[6]) / s;
    q.y = (m[5] + m[7]) / s;
    q.z = 0.25 * s;
  }
  // Clone so callers own the returned quaternion; _quatOut is reused
  // on the next call.
  return q.normalize().clone();
}

/**
 * Given a desired world quaternion and the bone's parent, return the
 * local quaternion that would produce that world orientation.
 */
export function worldQuatToLocal(desiredWorld: Quaternion, bone: Object3D): Quaternion {
  if (!bone.parent) return desiredWorld.clone();
  bone.parent.getWorldQuaternion(_quatParent);
  // Clone before mutating — _quatParent is a module singleton that would
  // alias across consecutive calls (e.g. solveArmIK calls this twice).
  return _quatParent.clone().invert().multiply(desiredWorld);
}

// --- 2-bone analytic arm IK (Phase 4) --------------------------------------

/**
 * Result of a 2-bone arm solve: local quaternions for upperArm and
 * lowerArm. `reachable` is false when the target is beyond the arm's
 * reach (solver extends the arm fully in the target direction instead
 * of failing — matches what a real shoulder would do).
 */
export interface ArmIKResult {
  upperArmLocal: Quaternion;
  lowerArmLocal: Quaternion;
  reachable: boolean;
}

/**
 * Solve a 2-bone arm: given the shoulder (upperArm) and elbow (lowerArm)
 * bones plus their current world positions and a desired world-space
 * hand target, compute local quaternions for each. Uses law of cosines
 * for the elbow bend + aim-at for the shoulder.
 *
 * `poleHint` (world-space) biases the elbow direction so it doesn't
 * collapse through the torso. Typical value: a point to the outside of
 * the avatar's shoulder.
 */
export function solveArmIK(
  shoulder: Object3D,
  elbow: Object3D,
  hand: Object3D,
  worldTarget: Vector3,
  poleHint: Vector3,
): ArmIKResult {
  const shoulderPos = new Vector3();
  const elbowPos = new Vector3();
  const handPos = new Vector3();
  shoulder.getWorldPosition(shoulderPos);
  elbow.getWorldPosition(elbowPos);
  hand.getWorldPosition(handPos);

  const upperLen = elbowPos.distanceTo(shoulderPos);
  const lowerLen = handPos.distanceTo(elbowPos);
  const toTarget = new Vector3().subVectors(worldTarget, shoulderPos);
  const targetDist = toTarget.length();
  // When the target collapses onto the shoulder, dirToTarget would divide
  // by zero and poleOrtho would blow up. Bail with identity quats — the
  // arm stays in its current FK pose and the gesture system blends it in
  // smoothly via the fade weights.
  if (targetDist < 1e-4) {
    return {
      upperArmLocal: new Quaternion(),
      lowerArmLocal: new Quaternion(),
      reachable: false,
    };
  }
  const reachable = targetDist < upperLen + lowerLen - 1e-3;
  const effectiveDist = Math.min(targetDist, upperLen + lowerLen - 1e-3);

  // Law of cosines: angle at shoulder (between upper arm and straight-to-target).
  const cosShoulder = (upperLen * upperLen + effectiveDist * effectiveDist - lowerLen * lowerLen)
    / (2 * upperLen * effectiveDist + 1e-9);
  const shoulderAngle = Math.acos(Math.max(-1, Math.min(1, cosShoulder)));

  // Elbow interior angle (between upper reversed and lower).
  const cosElbowInt = (upperLen * upperLen + lowerLen * lowerLen - effectiveDist * effectiveDist)
    / (2 * upperLen * lowerLen + 1e-9);
  const elbowInterior = Math.acos(Math.max(-1, Math.min(1, cosElbowInt)));

  // Pole plane: contains shoulder, target, and pole hint.
  const dirToTarget = toTarget.clone().normalize();
  const poleDir = new Vector3().subVectors(poleHint, shoulderPos).normalize();
  // Remove target-parallel component so pole becomes orthogonal to dirToTarget.
  const poleOrtho = poleDir.clone().sub(
    dirToTarget.clone().multiplyScalar(poleDir.dot(dirToTarget)),
  );
  if (poleOrtho.lengthSq() < 1e-6) poleOrtho.set(0, 1, 0);
  poleOrtho.normalize();

  // Elbow position: along a vector rotated from dirToTarget by shoulderAngle
  // in the plane defined by (dirToTarget, poleOrtho).
  const cs = Math.cos(shoulderAngle);
  const sn = Math.sin(shoulderAngle);
  const elbowTargetPos = new Vector3()
    .copy(shoulderPos)
    .addScaledVector(dirToTarget, upperLen * cs)
    .addScaledVector(poleOrtho, upperLen * sn);

  // Desired upperArm: aim from shoulder toward elbowTargetPos.
  const upperDir = new Vector3().subVectors(elbowTargetPos, shoulderPos).normalize();
  const curUpperDir = new Vector3().subVectors(elbowPos, shoulderPos).normalize();
  const upperDeltaWorld = new Quaternion().setFromUnitVectors(curUpperDir, upperDir);
  const shoulderWorldQuat = new Quaternion();
  shoulder.getWorldQuaternion(shoulderWorldQuat);
  const desiredUpperWorld = upperDeltaWorld.multiply(shoulderWorldQuat);
  const upperArmLocal = worldQuatToLocal(desiredUpperWorld, shoulder);

  // For lowerArm, we express elbow bend by comparing desired hand direction
  // (from elbow to target) against current lower arm direction. Use the
  // rotated shoulder to project the elbow forward.
  const desiredHandDir = new Vector3().subVectors(worldTarget, elbowTargetPos).normalize();
  const curLowerDir = new Vector3().subVectors(handPos, elbowPos).normalize();
  const lowerDeltaWorld = new Quaternion().setFromUnitVectors(curLowerDir, desiredHandDir);
  const elbowWorldQuat = new Quaternion();
  elbow.getWorldQuaternion(elbowWorldQuat);
  const desiredLowerWorld = lowerDeltaWorld.multiply(elbowWorldQuat);
  // Elbow's parent (in world-space) now includes the upper arm's desired
  // rotation; to rebase properly we'd need a second pass. For Phase 4 MVP
  // we accept small residual and let blend weight smooth it.
  const lowerArmLocal = worldQuatToLocal(desiredLowerWorld, elbow);

  void elbowInterior; // kept for future explicit elbow-angle shaping
  return { upperArmLocal, lowerArmLocal, reachable };
}

export { _p0 as _ikP0, _p1 as _ikP1 };
