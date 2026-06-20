/**
 * Parse a BVH motion capture file into a GestureDefinition.
 *
 * SDD 075 Phase 5: minimum viable import path. Maps common Mixamo /
 * CMU bone names to VRM humanoid names, samples at `sampleHz` frames
 * per second, and produces Euler-delta keyframes compatible with the
 * existing FK pipeline.
 *
 * Not supported in this MVP: translation tracks (hip positions), fingers,
 * retargeting between skeletons with different bind orientations. Users
 * who need precise Mixamo→VRM conversion should retarget in Blender.
 */

import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { Euler, Quaternion } from 'three';
import type { GestureDefinition, GestureKeyframe } from '../avatar/gestures';

/**
 * Minimal Mixamo/common → VRM bone-name map. Key = case-insensitive
 * substring match on BVH bone name; value = VRM humanoid name.
 * Order matters: longest / most-specific patterns first.
 */
const BONE_MAP: Array<[RegExp, string]> = [
  [/hips/i, 'hips'],
  [/spine2|chest/i, 'chest'],
  [/spine1|upperspine/i, 'chest'],
  [/spine/i, 'spine'],
  [/neck/i, 'neck'],
  [/head/i, 'head'],
  [/leftshoulder|lshoulder|left_shoulder/i, 'leftShoulder'],
  [/leftarm|lupperarm|left_arm|leftupperarm/i, 'leftUpperArm'],
  [/leftforearm|llowerarm|left_forearm|leftlowerarm/i, 'leftLowerArm'],
  [/lefthand|lhand|left_hand/i, 'leftHand'],
  [/rightshoulder|rshoulder|right_shoulder/i, 'rightShoulder'],
  [/rightarm|rupperarm|right_arm|rightupperarm/i, 'rightUpperArm'],
  [/rightforearm|rlowerarm|right_forearm|rightlowerarm/i, 'rightLowerArm'],
  [/righthand|rhand|right_hand/i, 'rightHand'],
  [/leftupleg|lupleg|leftupperleg|left_upleg/i, 'leftUpperLeg'],
  [/leftleg|llowerleg|leftlowerleg|left_leg/i, 'leftLowerLeg'],
  [/leftfoot|lfoot|left_foot/i, 'leftFoot'],
  [/rightupleg|rupleg|rightupperleg|right_upleg/i, 'rightUpperLeg'],
  [/rightleg|rlowerleg|rightlowerleg|right_leg/i, 'rightLowerLeg'],
  [/rightfoot|rfoot|right_foot/i, 'rightFoot'],
];

function mapBoneName(bvhName: string): string | null {
  for (const [re, vrm] of BONE_MAP) {
    if (re.test(bvhName)) return vrm;
  }
  return null;
}

export interface BVHImportOptions {
  /** Target keyframe rate (per second). Default 15. */
  sampleHz?: number;
  /** Clamp the imported gesture to this many seconds. Default = full clip. */
  maxDurationSec?: number;
  /** Name to assign the resulting gesture. */
  name?: string;
}

/**
 * Load a BVH file (from a File or ArrayBuffer) and convert to a gesture.
 * Returns the parsed GestureDefinition ready to load into the lab.
 */
export async function importBVH(
  source: File | ArrayBuffer | string,
  opts: BVHImportOptions = {},
): Promise<GestureDefinition> {
  const text =
    source instanceof File ? await source.text()
    : source instanceof ArrayBuffer ? new TextDecoder().decode(source)
    : source;

  const loader = new BVHLoader();
  const result = loader.parse(text);
  const clip = result.clip;
  const sampleHz = opts.sampleHz ?? 15;
  const clipDuration = Math.min(clip.duration, opts.maxDurationSec ?? clip.duration);
  if (clipDuration <= 0) {
    throw new Error('BVH clip has zero duration');
  }

  // Each track is `boneName.quaternion` (from BVHLoader). Index tracks by
  // their mapped VRM bone name.
  const keyframes: GestureKeyframe[] = [];
  const step = 1 / sampleHz;
  const qTmp = new Quaternion();
  const eTmp = new Euler();

  for (const track of clip.tracks) {
    // Track name examples: "Hips.quaternion", "LeftArm.quaternion"
    const [boneName, channel] = track.name.split('.');
    if (channel !== 'quaternion') continue; // ignore position tracks for now
    const vrmBone = mapBoneName(boneName);
    if (!vrmBone) continue;

    const times = track.times;
    const values = track.values; // 4 floats per sample (x,y,z,w)
    if (times.length === 0) continue;

    for (let t = 0; t <= clipDuration + 1e-6; t += step) {
      // Find surrounding sample indices.
      let i = 0;
      while (i < times.length - 1 && times[i + 1] < t) i++;
      const i0 = i;
      const i1 = Math.min(i + 1, times.length - 1);
      const span = times[i1] - times[i0];
      const alpha = span > 0 ? (t - times[i0]) / span : 0;

      const x0 = values[i0 * 4], y0 = values[i0 * 4 + 1], z0 = values[i0 * 4 + 2], w0 = values[i0 * 4 + 3];
      const x1 = values[i1 * 4], y1 = values[i1 * 4 + 1], z1 = values[i1 * 4 + 2], w1 = values[i1 * 4 + 3];
      const q0 = new Quaternion(x0, y0, z0, w0);
      const q1 = new Quaternion(x1, y1, z1, w1);
      qTmp.copy(q0).slerp(q1, alpha);
      eTmp.setFromQuaternion(qTmp, 'XYZ');

      keyframes.push({
        bone: vrmBone,
        rotation: { x: eTmp.x, y: eTmp.y, z: eTmp.z },
        // 4-decimal precision (0.1 ms): finer than the 5 ms tolerance
        // window used by AnimationLab.handleInsertKeyframe so adjacent
        // BVH samples can't accidentally collide and get filtered out.
        time: Math.round(t * 10000) / 10000,
      });
    }
  }

  // Keep keyframes sorted by time.
  keyframes.sort((a, b) => a.time - b.time || a.bone.localeCompare(b.bone));

  // Validate we ended up with usable rotation data. BVHLoader returns
  // tracks even for files without quaternion channels (position-only),
  // so an empty result here means the import would silently no-op.
  if (keyframes.length === 0) {
    throw new Error('BVH file has no usable rotation tracks');
  }

  return {
    name: opts.name ?? 'imported',
    duration: clipDuration,
    keyframes,
    layer: 'full',
    version: 2,
  };
}
