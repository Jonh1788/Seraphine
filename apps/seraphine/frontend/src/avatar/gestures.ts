/**
 * Procedural bone-based gesture animations for VRM avatars.
 *
 * IMPORTANT: keyframe `rotation` values are **additive DELTAS** composed
 * on top of the rest pose via `boneNode.quaternion.multiply(offset)` in
 * VrmAvatarController.applyPostUpdate(). They are NOT absolute bone
 * orientations.
 *
 * For arm bones this matters: the rest pose already rotates
 * rightUpperArm to -78° Z (arm hanging at side). A delta of +60° Z on
 * top brings the absolute close to -18° Z — arm near horizontal. A
 * NEGATIVE delta drives the arm *further* into the body.
 *
 * Bones reset by applyRestPose(): leftUpperArm, rightUpperArm,
 * leftLowerArm, rightLowerArm. Other bones (head, spine, chest, hands)
 * have no rest pose, so their deltas compose onto whatever the vrm
 * update left there.
 */

import { Euler, MathUtils, Quaternion } from "three";
// Canonical `ikWeightAt` lives in `lab/ikSolver`. Re-import under the
// previous local name to keep the rest of this file unchanged. The
// import is value-level but the reverse edge (`ikSolver → gestures`) is
// type-only, so no runtime cycle.
import { ikWeightAt as ikWeightAtLocal } from "../lab/ikSolver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bezier tangent handle for a single axis. */
export interface KeyframeTangent {
  inX: number; inY: number;
  outX: number; outY: number;
}

export interface GestureKeyframe {
  /** VRM humanoid bone name ('rightUpperArm', 'head', etc.) */
  bone: string;
  /** Euler angles in radians */
  rotation: { x: number; y: number; z: number };
  /** Seconds from gesture start */
  time: number;
  /** Optional Bezier tangent handles per axis (Phase 3 F-curves). */
  tangents?: {
    x: KeyframeTangent;
    y: KeyframeTangent;
    z: KeyframeTangent;
  };
}

/** Body part groups, for layered gesture composition (Phase 2).
 *  A gesture tagged `upper` only writes to upper-body bones, leaving
 *  legs free for a simultaneous `lower` gesture, etc. Default = `full`. */
export type GestureLayer = 'upper' | 'lower' | 'full';

export interface GestureDefinition {
  name: string;
  /** Total seconds */
  duration: number;
  keyframes: GestureKeyframe[];
  /** Phase 2: body-part mask. Default `full`. */
  layer?: GestureLayer;
  /** Phase 3+: IK constraints active during this gesture. */
  ikTargets?: IKTarget[];
  /** Schema version. Absent = v1 (pre-SDD-075). Current = 2. */
  version?: 2;
}

/** Bones claimed by each layer. A `full` gesture claims everything. */
export const LAYER_BONES: Record<GestureLayer, ReadonlySet<string>> = {
  upper: new Set([
    'spine', 'chest', 'neck', 'head',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ]),
  lower: new Set([
    'hips',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ]),
  full: new Set([
    'hips', 'spine', 'chest', 'neck', 'head',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ]),
};

/** Which chain an IK target drives. Phase 3 ships `head`; Phase 4 adds arms. */
export type IKChain = 'head' | 'leftArm' | 'rightArm';

/**
 * One IK constraint active during part of a gesture. Target position is in
 * world space by default (anchored to the avatar's scene origin) so the
 * avatar can look at / reach for a point in the world regardless of where
 * the body is animated to.
 */
export interface IKTarget {
  /** Stable id for selection / drag / undo. */
  id: string;
  chain: IKChain;
  /** Seconds into the gesture when this target begins influencing. */
  time: number;
  /** Seconds of linear fade-in on its influence. */
  fadeIn: number;
  /** Seconds to hold at full influence before fading back to FK. */
  hold: number;
  /** Seconds of fade-out back to FK. */
  fadeOut: number;
  /** Peak IK weight during hold (0 = FK only, 1 = fully IK). */
  blend: number;
  /** Target position; `world` for scene-space, `rig` for avatar-local. */
  target: { x: number; y: number; z: number };
  space: 'world' | 'rig';
}

export interface PlayOptions {
  /** Fade-in duration in ms (weight ramps 0→1). Default 0. */
  fadeInMs?: number;
  /** Fade-out duration in ms once the gesture finishes. Default 0. */
  fadeOutMs?: number;
  /**
   * If true and another gesture is currently playing, the new one is
   * queued until that one finishes (respecting its fadeOut).
   * Default false (starts immediately, crossfading with the outgoing).
   */
  queue?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in gesture library
// ---------------------------------------------------------------------------

const DEG = MathUtils.degToRad;

export const GESTURE_WAVE: GestureDefinition = {
  name: "wave",
  duration: 1.5,
  keyframes: [
    // Raise right arm: rest(-78°) + delta(+60°) → ~-18° Z ~ near horizontal.
    { bone: "rightUpperArm", rotation: { x: 0, y: 0, z: DEG(20) }, time: 0 },
    { bone: "rightUpperArm", rotation: { x: 0, y: 0, z: DEG(60) }, time: 0.3 },
    // Bend elbow up toward the head. VRoid forearm flex axis is local X
    // (Y is twist / supination). +85° X folds the hand up near the face;
    // negative would fold it down toward the hip.
    { bone: "rightLowerArm", rotation: { x: DEG(85), y: 0, z: 0 }, time: 0.3 },
    // Wave hand side to side (wrist has no rest pose — small Z oscillates).
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(15) }, time: 0.5 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(-15) }, time: 0.8 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(15) }, time: 1.1 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: 0 }, time: 1.2 },
    // Return: delta 0 = back to rest pose.
    { bone: "rightUpperArm", rotation: { x: 0, y: 0, z: 0 }, time: 1.5 },
    { bone: "rightLowerArm", rotation: { x: 0, y: 0, z: 0 }, time: 1.5 },
  ],
};

export const GESTURE_NOD: GestureDefinition = {
  name: "nod",
  duration: 0.8,
  keyframes: [
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 0 },
    { bone: "head", rotation: { x: DEG(10), y: 0, z: 0 }, time: 0.2 },
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 0.4 },
    { bone: "head", rotation: { x: DEG(8), y: 0, z: 0 }, time: 0.6 },
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 0.8 },
  ],
};

export const GESTURE_SHAKE_HEAD: GestureDefinition = {
  name: "shakeHead",
  duration: 0.8,
  keyframes: [
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 0 },
    { bone: "head", rotation: { x: 0, y: DEG(-12), z: 0 }, time: 0.2 },
    { bone: "head", rotation: { x: 0, y: DEG(12), z: 0 }, time: 0.5 },
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 0.8 },
  ],
};

export const GESTURE_TILT_HEAD: GestureDefinition = {
  name: "tiltHead",
  duration: 1.0,
  keyframes: [
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 0 },
    { bone: "head", rotation: { x: 0.04, y: 0.03, z: DEG(18) }, time: 0.35 },
    { bone: "head", rotation: { x: 0.04, y: 0.03, z: DEG(18) }, time: 0.65 },
    { bone: "head", rotation: { x: 0, y: 0, z: 0 }, time: 1.0 },
  ],
};

export const GESTURE_BOW: GestureDefinition = {
  name: "bow",
  duration: 1.2,
  keyframes: [
    { bone: "spine", rotation: { x: 0, y: 0, z: 0 }, time: 0 },
    { bone: "chest", rotation: { x: 0, y: 0, z: 0 }, time: 0 },
    { bone: "spine", rotation: { x: DEG(15), y: 0, z: 0 }, time: 0.4 },
    { bone: "chest", rotation: { x: DEG(15), y: 0, z: 0 }, time: 0.4 },
    // Hold
    { bone: "spine", rotation: { x: DEG(15), y: 0, z: 0 }, time: 0.8 },
    { bone: "chest", rotation: { x: DEG(15), y: 0, z: 0 }, time: 0.8 },
    // Return
    { bone: "spine", rotation: { x: 0, y: 0, z: 0 }, time: 1.2 },
    { bone: "chest", rotation: { x: 0, y: 0, z: 0 }, time: 1.2 },
  ],
};

/**
 * Hybrid IK+FK wave — example combining Phase 3/4 IK with FK keyframes.
 *
 * IK (rightArm): holds the right hand up near the ear for ~1 s.
 * Rig-local target at (−0.32, 1.55, 0.05): character's right is −X per
 * VRM 1.0 convention, slightly above shoulder, slightly forward. Kept
 * within ~0.45 m of the right shoulder so a typical VRoid/VRM humanoid
 * can reach it without the solver hitting the "extend straight toward
 * target" fallback.
 *
 * FK (rightHand): wrist oscillates ±15° on Z. IK only writes to
 * shoulder + elbow, so wrist rotation stacks on top cleanly.
 */
export const GESTURE_WAVE_IK: GestureDefinition = {
  name: "waveIK",
  duration: 1.8,
  version: 2,
  layer: 'upper',
  keyframes: [
    { bone: "rightHand", rotation: { x: 0, y: 0, z: 0 }, time: 0 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(15) }, time: 0.55 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(-15) }, time: 0.85 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(15) }, time: 1.15 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(-15) }, time: 1.45 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: 0 }, time: 1.8 },
  ],
  ikTargets: [
    {
      id: 'wave-ik-hand',
      chain: 'rightArm',
      time: 0.0,
      fadeIn: 0.35,
      hold: 1.1,
      fadeOut: 0.35,
      blend: 0.9,
      target: { x: -0.32, y: 1.55, z: 0.05 },
      space: 'rig',
    },
  ],
};

export const GESTURE_LIBRARY: Record<string, GestureDefinition> = {
  wave: GESTURE_WAVE,
  waveIK: GESTURE_WAVE_IK,
  nod: GESTURE_NOD,
  shakeHead: GESTURE_SHAKE_HEAD,
  tiltHead: GESTURE_TILT_HEAD,
  bow: GESTURE_BOW,
};

// ---------------------------------------------------------------------------
// GesturePlayer
// ---------------------------------------------------------------------------

/** Per-bone interpolated keyframe pair for the current time. */
interface BoneKeyframePair {
  from: GestureKeyframe;
  to: GestureKeyframe;
}

/**
 * Plays procedural bone gestures on a VRM humanoid rig.
 *
 * Design (Phase 2, SDD 075):
 * - Up to 2 tracks may be active at once during a crossfade: an outgoing
 *   (fading out) and an incoming (fading in). `getOffset(bone)` slerps
 *   between them weighted by each track's current fade factor.
 * - `play(def, { fadeInMs, fadeOutMs, queue })` is the full API; `play(def)`
 *   without opts preserves the pre-Phase-2 hard-cut behavior.
 * - Queue: one pending gesture (latest queued wins; repeated queue() of
 *   different gestures replaces the pending one, not stacks).
 * - Layer: a gesture's `layer` restricts which bones it writes to. Bones
 *   outside the layer return identity from `getOffset()`, leaving them
 *   free for another layer / idle to drive.
 */
interface GestureTrack {
  def: GestureDefinition;
  /** Elapsed seconds since this track started. */
  time: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Weight 0..1 — set each frame. Used for cross-blend. */
  weight: number;
  /** Cached per-bone offsets for the current frame. */
  offsets: Map<string, Quaternion>;
  /**
   * Keyframes pre-grouped by bone, computed once at track creation. Each
   * array is sorted by `time`. Avoids rebuilding the Map every tick.
   */
  byBone: Map<string, GestureKeyframe[]>;
  resolve: () => void;
  cancelled: boolean;
  /** True once the gesture's own duration has elapsed and it's fading out. */
  fadingOut: boolean;
}

export class GesturePlayer {
  private tracks: GestureTrack[] = [];
  /** Pending gesture queued behind the active one (at most 1). */
  private queued: { def: GestureDefinition; opts: PlayOptions; resolve: () => void } | null = null;
  private rafHandle: number | null = null;
  private lastFrameTime: number | null = null;

  /**
   * Play a gesture. When options are passed, supports fade-in/out and
   * queueing. Without options, behaves like the pre-Phase-2 player —
   * cancels any in-flight gesture and starts immediately.
   */
  play(gesture: GestureDefinition, opts: PlayOptions = {}): Promise<void> {
    // Queue mode: wait for current active track to end naturally.
    if (opts.queue && this.tracks.length > 0) {
      // Replace any previously queued gesture (most recent wins).
      if (this.queued) this.queued.resolve();
      return new Promise<void>((resolve) => {
        this.queued = { def: gesture, opts, resolve };
      });
    }

    // Fade out any currently active (non-fading) tracks.
    const fadeOutMs = opts.fadeOutMs ?? 0;
    const fadeInMs = opts.fadeInMs ?? 0;
    for (const tr of this.tracks) {
      if (!tr.fadingOut) {
        tr.fadingOut = true;
        // Repurpose remaining time for fade-out. If no fade requested
        // and caller is NOT using opts, behave like old hard-cut.
        if (fadeOutMs <= 0 && fadeInMs <= 0 && !('fadeInMs' in opts) && !('fadeOutMs' in opts)) {
          tr.cancelled = true;
        } else {
          tr.fadeOutMs = fadeOutMs;
          // Start the fade-out clock from now.
          tr.time = Math.max(tr.time, tr.def.duration);
        }
      }
    }
    // Drop cancelled tracks immediately — resolve their promises so
    // callers don't leak hanging awaits.
    const hardCut = this.tracks.filter(t => t.cancelled);
    this.tracks = this.tracks.filter(t => !t.cancelled);
    for (const tr of hardCut) tr.resolve();

    return new Promise<void>((resolve) => {
      const track: GestureTrack = {
        def: gesture,
        time: 0,
        fadeInMs,
        fadeOutMs,
        weight: fadeInMs > 0 ? 0 : 1,
        offsets: new Map(),
        byBone: buildByBone(gesture),
        resolve,
        cancelled: false,
        fadingOut: false,
      };
      this.tracks.push(track);
      this.ensureFrameLoop();
    });
  }

  /** Cancel all tracks immediately, clearing offsets. */
  cancel(): void {
    for (const tr of this.tracks) { tr.cancelled = true; tr.resolve(); }
    this.tracks = [];
    if (this.queued) { this.queued.resolve(); this.queued = null; }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.lastFrameTime = null;
  }

  /** Whether any gesture (including fading) is currently producing offsets. */
  get isPlaying(): boolean {
    return this.tracks.length > 0;
  }

  /**
   * Active IK targets with their current influence weights. Consumed by
   * the controller each frame (in applyPostUpdate) to drive look-at /
   * reach solvers. Multiplies each target's shape factor with its
   * track's crossfade weight so IK fades in/out smoothly alongside FK.
   */
  getActiveIKTargets(): Array<{ target: IKTarget; weight: number }> {
    const out: Array<{ target: IKTarget; weight: number }> = [];
    for (const tr of this.tracks) {
      if (!tr.def.ikTargets?.length) continue;
      for (const t of tr.def.ikTargets) {
        const w = ikWeightAtLocal(t, tr.time) * tr.weight;
        if (w > 0.001) out.push({ target: t, weight: w });
      }
    }
    return out;
  }

  /**
   * Additive rotation offset for a given bone, respecting layer mask and
   * crossfade weights. Returns the module-level identity quaternion when
   * no track writes to this bone.
   *
   * CONTRACT: callers MUST NOT mutate the returned quaternion. Compose
   * via `.multiply(offset)` or `.slerp(offset, ...)` on a quaternion you
   * own. The identity singleton and per-track offset Maps are reused
   * across frames; mutating them corrupts later reads.
   */
  getOffset(boneName: string): Quaternion {
    if (this.tracks.length === 0) return _identity;
    if (this.tracks.length === 1) {
      const tr = this.tracks[0];
      if (!boneBelongsToLayer(boneName, tr.def.layer)) return _identity;
      return tr.offsets.get(boneName) ?? _identity;
    }
    // Blend multiple tracks. Weighted quaternion blend via iterative slerp
    // (acceptable for 2-3 tracks tops).
    let totalWeight = 0;
    let result: Quaternion | null = null;
    for (const tr of this.tracks) {
      if (!boneBelongsToLayer(boneName, tr.def.layer)) continue;
      const q = tr.offsets.get(boneName);
      if (!q) continue;
      const w = tr.weight;
      if (w <= 0) continue;
      if (!result) {
        result = _tmpQuat.copy(q);
        totalWeight = w;
      } else {
        const alpha = w / (totalWeight + w);
        result.slerp(q, alpha);
        totalWeight += w;
      }
    }
    return result ? result.clone() : _identity;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private ensureFrameLoop(): void {
    if (this.rafHandle !== null) return;
    const step = (now: number) => {
      if (this.lastFrameTime === null) this.lastFrameTime = now;
      const dt = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;
      this.tick(dt);
      if (this.tracks.length === 0 && !this.queued) {
        this.rafHandle = null;
        this.lastFrameTime = null;
        return;
      }
      this.rafHandle = requestAnimationFrame(step);
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  /** Advance all tracks by `dt` seconds and compute their offsets. */
  private tick(dt: number): void {
    for (const tr of this.tracks) {
      if (tr.cancelled) continue;
      tr.time += dt;

      // Fade-in weight
      let w = 1;
      if (tr.fadeInMs > 0 && tr.time * 1000 < tr.fadeInMs) {
        w = (tr.time * 1000) / tr.fadeInMs;
      }

      // Fade-out when past duration
      if (tr.time >= tr.def.duration) {
        if (!tr.fadingOut) tr.fadingOut = true;
        if (tr.fadeOutMs > 0) {
          const fadeProgress = ((tr.time - tr.def.duration) * 1000) / tr.fadeOutMs;
          if (fadeProgress >= 1) { tr.cancelled = true; continue; }
          w *= 1 - fadeProgress;
        } else {
          // No fade-out requested: finish immediately.
          tr.cancelled = true;
          continue;
        }
      }
      tr.weight = Math.max(0, Math.min(1, w));
      this.computeOffsets(tr);
    }

    // Reap finished tracks.
    const finished = this.tracks.filter(t => t.cancelled);
    this.tracks = this.tracks.filter(t => !t.cancelled);
    for (const tr of finished) tr.resolve();

    // If nothing is active and we have a queued gesture, start it now.
    if (this.tracks.length === 0 && this.queued) {
      const q = this.queued;
      this.queued = null;
      void this.play(q.def, { ...q.opts, queue: false }).then(q.resolve);
    }
  }

  private computeOffsets(tr: GestureTrack): void {
    // Clamp time to duration when fading out — hold the last pose.
    const sampleT = Math.min(tr.time, tr.def.duration);
    for (const [bone, kfs] of tr.byBone) {
      const pair = this.findKeyframePair(kfs, sampleT);
      const quat = this.interpolateKeyframes(pair, sampleT);
      tr.offsets.set(bone, quat);
    }
  }

  private findKeyframePair(
    kfs: GestureKeyframe[],
    t: number,
  ): BoneKeyframePair {
    // Before first keyframe — hold first.
    if (t <= kfs[0].time) {
      return { from: kfs[0], to: kfs[0] };
    }
    // After last keyframe — hold last.
    if (t >= kfs[kfs.length - 1].time) {
      const last = kfs[kfs.length - 1];
      return { from: last, to: last };
    }
    // Between two keyframes.
    for (let i = 0; i < kfs.length - 1; i++) {
      if (t >= kfs[i].time && t <= kfs[i + 1].time) {
        return { from: kfs[i], to: kfs[i + 1] };
      }
    }
    // Fallback (shouldn't happen).
    const last = kfs[kfs.length - 1];
    return { from: last, to: last };
  }

  private interpolateKeyframes(
    pair: BoneKeyframePair,
    t: number,
  ): Quaternion {
    const { from, to } = pair;
    if (from === to || from.time === to.time) {
      return _quatFromRot(from.rotation);
    }
    const alpha = (t - from.time) / (to.time - from.time);

    // Phase 3: if both keyframes have tangents, use cubic Bezier per-axis
    if (from.tangents && to.tangents) {
      const rx = _cubicBezierAxis(from.rotation.x, to.rotation.x, from.tangents.x, to.tangents.x, alpha);
      const ry = _cubicBezierAxis(from.rotation.y, to.rotation.y, from.tangents.y, to.tangents.y, alpha);
      const rz = _cubicBezierAxis(from.rotation.z, to.rotation.z, from.tangents.z, to.tangents.z, alpha);
      return _quatFromRot({ x: rx, y: ry, z: rz });
    }

    const smoothAlpha = smoothStep(alpha);
    const qFrom = _quatFromRot(from.rotation);
    const qTo = _quatFromRot(to.rotation);
    return qFrom.slerp(qTo, smoothAlpha);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _identity = new Quaternion();
const _tmpQuat = new Quaternion();

function boneBelongsToLayer(bone: string, layer: GestureLayer | undefined): boolean {
  const set = LAYER_BONES[layer ?? 'full'];
  return set.has(bone);
}

/**
 * Pre-group a gesture's keyframes by bone, sorted by time. Called once
 * when a track is created so the per-tick `computeOffsets` path doesn't
 * rebuild the Map every frame.
 */
function buildByBone(def: GestureDefinition): Map<string, GestureKeyframe[]> {
  const byBone = new Map<string, GestureKeyframe[]>();
  for (const kf of def.keyframes) {
    let arr = byBone.get(kf.bone);
    if (!arr) { arr = []; byBone.set(kf.bone, arr); }
    arr.push(kf);
  }
  for (const arr of byBone.values()) arr.sort((a, b) => a.time - b.time);
  return byBone;
}

// `ikWeightAt` is defined in `lab/ikSolver` and re-imported as
// `ikWeightAtLocal` at the top of this file. We used to keep a local
// copy here to avoid a circular import, but the cycle is harmless in
// practice — `ikSolver` only imports `IKTarget` as a type, so the
// value-level edge in this direction has no runtime effect.

/** SmoothStep for natural ease-in-out. */
function smoothStep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function _quatFromRot(r: { x: number; y: number; z: number }): Quaternion {
  return new Quaternion().setFromEuler(new Euler(r.x, r.y, r.z, "XYZ"));
}

/** Cubic Bezier interpolation for a single axis value. */
function _cubicBezierAxis(
  v0: number, v1: number,
  fromTangent: KeyframeTangent, toTangent: KeyframeTangent,
  t: number,
): number {
  const p0 = v0;
  const p1 = v0 + fromTangent.outY;
  const p2 = v1 + toTangent.inY;
  const p3 = v1;
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Create default (flat/smooth) tangents for a keyframe. */
export function defaultTangents(): NonNullable<GestureKeyframe['tangents']> {
  const flat = (): KeyframeTangent => ({ inX: -0.1, inY: 0, outX: 0.1, outY: 0 });
  return { x: flat(), y: flat(), z: flat() };
}
