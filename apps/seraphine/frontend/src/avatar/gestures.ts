/**
 * Procedural bone-based gesture animations for VRM avatars.
 * Uses quaternion slerp interpolation between keyframes applied
 * additively on top of the idle animation.
 */

import { Euler, MathUtils, Quaternion } from "three";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GestureKeyframe {
  /** VRM humanoid bone name ('rightUpperArm', 'head', etc.) */
  bone: string;
  /** Euler angles in radians */
  rotation: { x: number; y: number; z: number };
  /** Seconds from gesture start */
  time: number;
}

export interface GestureDefinition {
  name: string;
  /** Total seconds */
  duration: number;
  keyframes: GestureKeyframe[];
}

// ---------------------------------------------------------------------------
// Built-in gesture library
// ---------------------------------------------------------------------------

const DEG = MathUtils.degToRad;

export const GESTURE_WAVE: GestureDefinition = {
  name: "wave",
  duration: 1.5,
  keyframes: [
    // Raise arm
    { bone: "rightUpperArm", rotation: { x: 0, y: 0, z: DEG(-30) }, time: 0 },
    { bone: "rightUpperArm", rotation: { x: 0, y: 0, z: DEG(-90) }, time: 0.3 },
    // Bend elbow
    { bone: "rightLowerArm", rotation: { x: 0, y: DEG(-90), z: 0 }, time: 0.3 },
    // Wave back and forth
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(15) }, time: 0.5 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(-15) }, time: 0.8 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: DEG(15) }, time: 1.1 },
    { bone: "rightHand", rotation: { x: 0, y: 0, z: 0 }, time: 1.2 },
    // Return arm to rest
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

export const GESTURE_LIBRARY: Record<string, GestureDefinition> = {
  wave: GESTURE_WAVE,
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
 * Design:
 * - Only one gesture plays at a time (starting a new one cancels the old).
 * - Gesture rotations are **additive**: the caller reads `getActiveOffsets()`
 *   each frame and adds them on top of idle rotations.
 * - Uses its own `requestAnimationFrame` loop while a gesture is active,
 *   but can also be driven externally via `tick(delta)`.
 */
export class GesturePlayer {
  private activeGesture: GestureDefinition | null = null;
  private gestureTime = 0;
  private cancelFn: (() => void) | null = null;

  /** Additive rotation offsets for each affected bone. */
  private offsets = new Map<string, Quaternion>();

  /**
   * Play a gesture. Returns a promise that resolves when the animation
   * completes or is cancelled.
   */
  play(gesture: GestureDefinition): Promise<void> {
    // Cancel any in-progress gesture.
    this.cancel();

    this.activeGesture = gesture;
    this.gestureTime = 0;
    this.offsets.clear();

    return new Promise<void>((resolve) => {
      let cancelled = false;
      this.cancelFn = () => {
        cancelled = true;
        resolve();
      };

      let lastTime: number | null = null;
      const frame = (now: number): void => {
        if (cancelled) return;
        if (lastTime === null) lastTime = now;
        const dt = (now - lastTime) / 1000;
        lastTime = now;

        this.gestureTime += dt;

        if (this.gestureTime >= gesture.duration) {
          this.activeGesture = null;
          this.offsets.clear();
          this.cancelFn = null;
          resolve();
          return;
        }

        this.computeOffsets();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  /** Cancel the current gesture, clearing all offsets. */
  cancel(): void {
    if (this.cancelFn) {
      this.cancelFn();
      this.cancelFn = null;
    }
    this.activeGesture = null;
    this.gestureTime = 0;
    this.offsets.clear();
  }

  /** Whether a gesture is currently playing. */
  get isPlaying(): boolean {
    return this.activeGesture !== null;
  }

  /**
   * Get the current additive rotation offset for a given bone.
   * Returns an identity quaternion if no gesture affects this bone.
   */
  getOffset(boneName: string): Quaternion {
    return this.offsets.get(boneName) ?? _identity;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeOffsets(): void {
    const gesture = this.activeGesture;
    if (!gesture) return;

    const t = this.gestureTime;

    // Group keyframes by bone.
    const byBone = new Map<string, GestureKeyframe[]>();
    for (const kf of gesture.keyframes) {
      let arr = byBone.get(kf.bone);
      if (!arr) {
        arr = [];
        byBone.set(kf.bone, arr);
      }
      arr.push(kf);
    }

    for (const [bone, kfs] of byBone) {
      // kfs are assumed sorted by time in the definition.
      const pair = this.findKeyframePair(kfs, t);
      const quat = this.interpolateKeyframes(pair, t);
      this.offsets.set(bone, quat);
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

/** SmoothStep for natural ease-in-out. */
function smoothStep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function _quatFromRot(r: { x: number; y: number; z: number }): Quaternion {
  return new Quaternion().setFromEuler(new Euler(r.x, r.y, r.z, "XYZ"));
}
