/**
 * Utilitarios compartilhados do Animation Lab: constantes, tipos e funcoes
 * de conversao rad/deg, interpolacao, selecao e mirror de keyframes.
 */
import type { GestureDefinition, GestureKeyframe, GestureLayer, IKTarget } from '../avatar/gestures';

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

export const PICKABLE_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/**
 * Outliner indentation levels (parent=0, children=1, grandchildren=2...).
 * Keeps the bone tree visually organized without re-reading the humanoid.
 */
export const BONE_INDENT: Record<string, number> = {
  hips: 0,
  spine: 1, chest: 2, neck: 3, head: 4,
  leftShoulder: 3, leftUpperArm: 4, leftLowerArm: 5, leftHand: 6,
  rightShoulder: 3, rightUpperArm: 4, rightLowerArm: 5, rightHand: 6,
  leftUpperLeg: 1, leftLowerLeg: 2, leftFoot: 3,
  rightUpperLeg: 1, rightLowerLeg: 2, rightFoot: 3,
};

// --- Types ----------------------------------------------------------------

export interface KfDeg {
  bone: string;
  x: number; y: number; z: number;
  time: number;
  tangents?: GestureKeyframe['tangents'];
}

// Module-scope clipboard for internal copy/cut/paste
let _clipboardRef: KfDeg[] = [];
export function getClipboard(): KfDeg[] { return _clipboardRef; }
export function setClipboard(kfs: KfDeg[]): void { _clipboardRef = kfs; }

export function defToDegs(def: GestureDefinition): KfDeg[] {
  return def.keyframes.map(kf => ({
    bone: kf.bone,
    x: +(kf.rotation.x * RAD2DEG).toFixed(1),
    y: +(kf.rotation.y * RAD2DEG).toFixed(1),
    z: +(kf.rotation.z * RAD2DEG).toFixed(1),
    time: kf.time,
    tangents: kf.tangents,
  }));
}

export function degsToGesture(
  name: string, duration: number, kfs: KfDeg[],
  layer: GestureLayer = 'full',
  ikTargets: IKTarget[] = [],
): GestureDefinition {
  return {
    name,
    duration,
    version: 2,
    layer,
    keyframes: kfs.map(k => ({
      bone: k.bone,
      rotation: { x: k.x * DEG2RAD, y: k.y * DEG2RAD, z: k.z * DEG2RAD },
      time: k.time,
      tangents: k.tangents,
    })),
    ikTargets: ikTargets.length > 0 ? ikTargets : undefined,
  };
}

/** Swap 'left'/'right' prefix in a bone name. Returns undefined if not mirrorable. */
export function mirrorBone(bone: string): string | undefined {
  if (bone.startsWith('left')) return 'right' + bone.slice(4);
  if (bone.startsWith('right')) return 'left' + bone.slice(5);
  return undefined;
}

/** Mirror a degree vector: flip Y and Z, keep X (flex axis). */
export function mirrorDeg(kf: KfDeg): KfDeg | null {
  const mb = mirrorBone(kf.bone);
  if (!mb) return null;
  return { ...kf, bone: mb, y: -kf.y, z: -kf.z };
}

export function generateTsCode(name: string, duration: number, kfs: KfDeg[]): string {
  const constName = `GESTURE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const kfLines = kfs.map(k => {
    const rx = k.x !== 0 ? `DEG(${k.x})` : '0';
    const ry = k.y !== 0 ? `DEG(${k.y})` : '0';
    const rz = k.z !== 0 ? `DEG(${k.z})` : '0';
    return `  { bone: "${k.bone}", rotation: { x: ${rx}, y: ${ry}, z: ${rz} }, time: ${k.time} },`;
  });
  return `export const ${constName}: GestureDefinition = {\n  name: "${name}",\n  duration: ${duration},\n  keyframes: [\n${kfLines.join('\n')}\n  ],\n};`;
}

// --- Scrub interpolation --------------------------------------------------

export function interpolateBoneAtTime(
  kfs: KfDeg[],
  time: number,
): { x: number; y: number; z: number } {
  if (kfs.length === 0) return { x: 0, y: 0, z: 0 };
  if (kfs.length === 1 || time <= kfs[0].time) return { x: kfs[0].x * DEG2RAD, y: kfs[0].y * DEG2RAD, z: kfs[0].z * DEG2RAD };
  const last = kfs[kfs.length - 1];
  if (time >= last.time) return { x: last.x * DEG2RAD, y: last.y * DEG2RAD, z: last.z * DEG2RAD };
  for (let i = 0; i < kfs.length - 1; i++) {
    if (time >= kfs[i].time && time <= kfs[i + 1].time) {
      const a = kfs[i];
      const b = kfs[i + 1];
      const span = b.time - a.time;
      const t = span > 0 ? (time - a.time) / span : 0;
      const s = t * t * (3 - 2 * t); // smoothstep
      return {
        x: (a.x + (b.x - a.x) * s) * DEG2RAD,
        y: (a.y + (b.y - a.y) * s) * DEG2RAD,
        z: (a.z + (b.z - a.z) * s) * DEG2RAD,
      };
    }
  }
  return { x: last.x * DEG2RAD, y: last.y * DEG2RAD, z: last.z * DEG2RAD };
}

// --- Selection helpers ----------------------------------------------------

/** Re-resolve a selection set after keyframes array has been re-sorted.
 *  Uses object identity (reference equality) to find new indices. */
export function resolveSelectionAfterSort(
  oldKfs: KfDeg[],
  newKfs: KfDeg[],
  oldSelection: Set<number>,
  oldPrimary: number | null,
): { selection: Set<number>; primaryIdx: number | null } {
  const selectedObjs = new Set<KfDeg>();
  let primaryObj: KfDeg | null = null;
  for (const idx of oldSelection) {
    if (idx < oldKfs.length) selectedObjs.add(oldKfs[idx]);
  }
  if (oldPrimary !== null && oldPrimary < oldKfs.length) {
    primaryObj = oldKfs[oldPrimary];
  }
  const nextSelection = new Set<number>();
  let nextPrimary: number | null = null;
  for (let i = 0; i < newKfs.length; i++) {
    if (selectedObjs.has(newKfs[i])) {
      nextSelection.add(i);
    }
    if (newKfs[i] === primaryObj) {
      nextPrimary = i;
    }
  }
  if (nextSelection.size === 0) nextPrimary = null;
  return { selection: nextSelection, primaryIdx: nextPrimary };
}
