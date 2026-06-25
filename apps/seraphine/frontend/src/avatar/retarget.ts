import { Quaternion } from "three";

/**
 * Rebase an animated local rotation from a source rig (e.g. Mixamo) onto a
 * target rig with a different rest pose. Returns parentRestWorld · q · restWorldInverse.
 * Inputs are not mutated.
 */
export function rebaseQuaternion(
  q: Quaternion,
  parentRestWorld: Quaternion,
  restWorldInverse: Quaternion,
): Quaternion {
  return parentRestWorld.clone().multiply(q).multiply(restWorldInverse);
}

/** VRM 0.x faces -Z; flip the x and z components of a quaternion track value. */
export function applyVrm0QuatFlip(q: Quaternion): Quaternion {
  return new Quaternion(-q.x, q.y, -q.z, q.w);
}

/** In-place hips: drop horizontal translation, keep vertical scaled by the height ratio. */
export function scaleHipsInPlace(
  y: number,
  hipsPositionScale: number,
): [number, number, number] {
  return [0, y * hipsPositionScale, 0];
}
