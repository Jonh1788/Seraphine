/**
 * Onion skin: gera LineSegments representando a pose de um keyframe
 * vizinho (antes ou depois do tempo atual) como silhueta translucida.
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Vector3,
  type Object3D,
} from 'three';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { interpolateBoneAtTime, PICKABLE_BONES, type KfDeg } from './labUtils';

export const BONE_CONNECTIONS: [string, string][] = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'leftShoulder'], ['leftShoulder', 'leftUpperArm'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['chest', 'rightShoulder'], ['rightShoulder', 'rightUpperArm'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'],
  ['leftLowerLeg', 'leftFoot'],
  ['hips', 'rightUpperLeg'], ['rightUpperLeg', 'rightLowerLeg'],
  ['rightLowerLeg', 'rightFoot'],
];

export function createOnionLines(
  vrm: any,
  keyframes: KfDeg[],
  time: number,
  controller: VrmAvatarController,
  direction: 'before' | 'after',
): LineSegments | null {
  const allTimes = [...new Set(keyframes.map(kf => kf.time))].sort((a, b) => a - b);
  let targetTime: number | null = null;
  if (direction === 'before') {
    for (let i = allTimes.length - 1; i >= 0; i--) {
      if (allTimes[i] < time - 0.01) { targetTime = allTimes[i]; break; }
    }
  } else {
    for (const t of allTimes) {
      if (t > time + 0.01) { targetTime = t; break; }
    }
  }
  if (targetTime === null) return null;

  const savedDeltas = new Map<string, { x: number; y: number; z: number }>();
  for (const bone of PICKABLE_BONES) {
    savedDeltas.set(bone, controller.getBoneDelta(bone));
  }

  const positions: number[] = [];
  // Wrap the temporary pose write in try/finally so a throw during
  // sampling (e.g. updateMatrixWorld → bad bone) cannot leave the
  // controller stuck on the onion-skin pose. Restore always runs.
  try {
    const byBone = new Map<string, KfDeg[]>();
    for (const kf of keyframes) {
      let arr = byBone.get(kf.bone);
      if (!arr) { arr = []; byBone.set(kf.bone, arr); }
      arr.push(kf);
    }
    for (const [bone, boneKfs] of byBone) {
      const sorted = [...boneKfs].sort((a, b) => a.time - b.time);
      const delta = interpolateBoneAtTime(sorted, targetTime);
      controller.setBoneDelta(bone, delta);
    }

    vrm.scene.updateMatrixWorld(true);
    const wp = new Vector3();
    for (const [parentName, childName] of BONE_CONNECTIONS) {
      const parentNode = vrm.humanoid?.getRawBoneNode(parentName as any) as Object3D | null | undefined;
      const childNode = vrm.humanoid?.getRawBoneNode(childName as any) as Object3D | null | undefined;
      if (!parentNode || !childNode) continue;
      parentNode.getWorldPosition(wp);
      positions.push(wp.x, wp.y, wp.z);
      childNode.getWorldPosition(wp);
      positions.push(wp.x, wp.y, wp.z);
    }
  } finally {
    for (const [bone, delta] of savedDeltas) {
      controller.setBoneDelta(bone, delta);
    }
  }

  if (positions.length === 0) return null;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const color = direction === 'before' ? 0x3b82f6 : 0xf97316;
  const mat = new LineBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false });
  const lines = new LineSegments(geom, mat);
  lines.renderOrder = 998;
  return lines;
}
