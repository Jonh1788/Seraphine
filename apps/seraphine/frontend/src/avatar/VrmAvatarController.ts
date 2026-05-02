import {
  ACESFilmicToneMapping,
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  Clock,
  DirectionalLight,
  Euler,
  KeyframeTrack,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  PerspectiveCamera,
  Quaternion,
  QuaternionKeyframeTrack,
  Scene,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type Object3D,
} from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type { AvatarAdapter } from "./AvatarAdapter";
import { envelopeToVisemes, playAudioWithLipSync } from "./lipsync";
import { resolveEmotion, EMOTION_MAP, type EmotionMapping } from "./expressions";
import { GesturePlayer, GESTURE_LIBRARY, type GestureDefinition } from "./gestures";
import { solveHeadLookAt, solveArmIK, worldQuatToLocal } from "../lab/ikSolver";

type EmotionLabel = "neutral" | "happy" | "sad" | "angry" | "thinking" | string;

const FALLBACK_EXPRESSIONS = [
  "happy", "angry", "sad", "relaxed", "surprised", "neutral", "blink",
  "aa", "ih", "ou", "ee", "oh",
];

/**
 * Map Mixamo bone names to VRM humanoid bone names for retargeting.
 * Covers both the `mixamorigXxx` prefix style (Mixamo default) AND the
 * plain `Xxx` style (common when FBX is exported "without skin" or
 * re-exported through Blender).
 */
const MIXAMO_TO_VRM: Record<string, string> = {
  // With prefix (standard Mixamo)
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
  // Without prefix (Blender re-export, some Mixamo downloads)
  Hips: "hips",
  Spine: "spine",
  Spine1: "chest",
  Spine2: "upperChest",
  Chest: "chest",
  UpperChest: "upperChest",
  Neck: "neck",
  Head: "head",
  LeftShoulder: "leftShoulder",
  LeftArm: "leftUpperArm",
  LeftForeArm: "leftLowerArm",
  LeftHand: "leftHand",
  RightShoulder: "rightShoulder",
  RightArm: "rightUpperArm",
  RightForeArm: "rightLowerArm",
  RightHand: "rightHand",
  LeftUpLeg: "leftUpperLeg",
  LeftLeg: "leftLowerLeg",
  LeftFoot: "leftFoot",
  LeftToeBase: "leftToes",
  RightUpLeg: "rightUpperLeg",
  RightLeg: "rightLowerLeg",
  RightFoot: "rightFoot",
  RightToeBase: "rightToes",
  // Blender/custom rig style: BoneName_L / BoneName_R
  Shoulder_L: "leftShoulder",
  UpperArm_L: "leftUpperArm",
  lowerArm_L: "leftLowerArm",
  LowerArm_L: "leftLowerArm",
  Hand_L: "leftHand",
  Shoulder_R: "rightShoulder",
  UpperArm_R: "rightUpperArm",
  lowerArm_R: "rightLowerArm",
  LowerArm_R: "rightLowerArm",
  Hand_R: "rightHand",
  UpperLeg_L: "leftUpperLeg",
  LowerLeg_L: "leftLowerLeg",
  lowerLeg_L: "leftLowerLeg",
  Foot_L: "leftFoot",
  Toes_L: "leftToes",
  ToeBase_L: "leftToes",
  UpperLeg_R: "rightUpperLeg",
  LowerLeg_R: "rightLowerLeg",
  lowerLeg_R: "rightLowerLeg",
  Foot_R: "rightFoot",
  Toes_R: "rightToes",
  ToeBase_R: "rightToes",
  // Finger bones (for hand animations)
  ThumbProximal_L: "leftThumbProximal",
  ThumbIntermediate_L: "leftThumbDistal",
  IndexProximal_L: "leftIndexProximal",
  IndexIntermediate_L: "leftIndexDistal",
  MiddleProximal_L: "leftMiddleProximal",
  MiddleIntermediate_L: "leftMiddleDistal",
  RingProximal_L: "leftRingProximal",
  RingIntermediate_L: "leftRingDistal",
  LittleProximal_L: "leftLittleProximal",
  LittleIntermediate_L: "leftLittleDistal",
  ThumbProximal_R: "rightThumbProximal",
  ThumbIntermediate_R: "rightThumbDistal",
  IndexProximal_R: "rightIndexProximal",
  IndexIntermediate_R: "rightIndexDistal",
  MiddleProximal_R: "rightMiddleProximal",
  MiddleIntermediate_R: "rightMiddleDistal",
  RingProximal_R: "rightRingProximal",
  RingIntermediate_R: "rightRingDistal",
  LittleProximal_R: "rightLittleProximal",
  LittleIntermediate_R: "rightLittleDistal",
};

/** Tracked state for a single VRM expression being faded in/out. */
interface ExpressionState {
  target: number;
  current: number;
  /** Weight change per second (derived from fadeMs). */
  fadeSpeed: number;
}

export class VrmAvatarController implements AvatarAdapter {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly clock: Clock;
  private vrm: VRM | null = null;
  private poseLocked = false;
  /** Spring bone manager detached from VRM so we control when it updates. */
  private springBoneManager: any = null;
  private rafId: number | null = null;
  private disposed = false;
  /**
   * When true, the RAF loop short-circuits before doing per-frame work
   * (mixer.update, IK, render). Used by the companion window during
   * native drag — macOS deprioritizes the WebView render thread while
   * dragging anyway, so we explicitly pause to free CPU. Time is
   * discarded on resume so the animation doesn't jump.
   */
  private renderPaused = false;
  /** @deprecated Kept for backward compat with old setEmotion() calls. */
  // @ts-expect-error write-only field kept for setEmotion() backward compat
  private _currentEmotion: string | null = null;
  private elapsed = 0;
  private nextBlinkAt: number;
  private blinkingUntil = 0;
  // Lipsync: optional external AnalyserNode owned by PCMPlayback.
  // When set, the RAF loop samples it, computes RMS, EMA-smooths,
  // and drives the VRM's aa/ih/ou viseme blendshapes.
  private audioAnalyser: AnalyserNode | null = null;
  private audioTimeData: Float32Array | null = null;
  private smoothedRms = 0;

  // --- External animation system ---
  private mixer: AnimationMixer | null = null;
  private currentAction: AnimationAction | null = null;
  private loadedClips = new Map<string, AnimationClip>();
  private externalAnimPlaying = false;

  // --- Expression transition system ---
  private activeExpressions = new Map<string, ExpressionState>();
  /** Head tilt offset from the current emotion (radians). */
  private emotionHeadTilt: { x: number; y: number; z: number } = {
    x: 0,
    y: 0,
    z: 0,
  };
  /** Target head tilt — we lerp emotionHeadTilt toward this. */
  private emotionHeadTiltTarget: { x: number; y: number; z: number } = {
    x: 0,
    y: 0,
    z: 0,
  };
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Gesture system ---
  private readonly gesturePlayer = new GesturePlayer();
  /**
   * User-saved gestures (from AnimationLab → `POST /lab/gestures`).
   * Looked up BEFORE `GESTURE_LIBRARY` in `playGesture` so a user can
   * override a built-in (e.g., customise "wave") and so freshly saved
   * names become reachable everywhere (chat reactions, activeAppReactor,
   * etc.) without plumbing them through every call site.
   */
  private readonly userGestures = new Map<string, GestureDefinition>();

  // --- Idle loop system ---
  /** Name of the gesture currently looping as idle (null = none). */
  private idleGestureName: string | null = null;
  /** Promise of the current idle iteration; null while paused. */
  private idleLoopActive = false;
  /** True while a one-shot gesture or TTS is happening — idle is paused. */
  private idleSuppressed = false;

  // --- Idle look-around system ---
  // Periodically picks a random head direction and smoothly interpolates
  // toward it, holds for a random time, then picks a new one. Creates
  // a natural "alive" fidget without scripted animation.
  // When `isSpeaking` is true (TTS active), look-around is suppressed
  // and the head stays forward with subtle conversational nods only.
  private idleLookTarget = { x: 0, y: 0, z: 0 };
  private idleLookCurrent = { x: 0, y: 0, z: 0 };
  private nextIdleLookAt = 0; // elapsed time to pick next target
  private idleLookSpeed = 1.2; // radians per second (lerp factor)
  // Eyes lead the head — they snap to the target faster, creating
  // the natural "eyes move first, head follows" saccade effect.
  private eyeLookCurrent = { x: 0, y: 0, z: 0 };
  private readonly EYE_LEAD_MULTIPLIER = 3.5; // eyes lerp Nx faster than head
  private readonly EYE_OVERSHOOT = 1.4; // eyes overshoot target slightly
  // Conversational micro-saccades — small autonomous eye movements
  // while speaking (glancing aside briefly, thinking, etc.)
  private _eyeMicroTarget = { x: 0, y: 0 };
  private _eyeMicroCurrent = { x: 0, y: 0 };
  private _nextEyeMicro = 0;
  private _isSpeaking = false;

  // --- Idle body motion (applied in applyPostUpdate, after humanoid sync) ---
  private _idleBreathPhase = 0;
  private _idleSpineRotX = 0;
  private _idleSpineRotZ = 0;

  // --- Spring bone debug counter ---
  private _springDebugCount = 0;

  // Camera presets — smooth transition via lerp in the RAF loop
  private cameraTarget = { px: 0, py: 1.45, pz: 0.9, lx: 0, ly: 1.35, lz: 0, fov: 30 };
  private cameraCurrent = { ...this.cameraTarget };
  static readonly CAMERA_PRESETS: Record<string, typeof VrmAvatarController.prototype.cameraTarget> = {
    bust:     { px: 0, py: 1.45, pz: 0.9,  lx: 0, ly: 1.35, lz: 0, fov: 30 },
    face:     { px: 0, py: 1.55, pz: 0.45, lx: 0, ly: 1.52, lz: 0, fov: 24 },
    fullBody: { px: 0, py: 1.0,  pz: 2.5,  lx: 0, ly: 0.9,  lz: 0, fov: 30 },
  };

  constructor(canvas: HTMLCanvasElement) {
    void canvas; // retained by renderer
    this.scene = new Scene();

    const width = canvas.width || 400;
    const height = canvas.height || 600;
    this.camera = new PerspectiveCamera(30, width / height, 0.1, 20);
    // Default: bust framing
    this.camera.position.set(0, 1.45, 0.9);
    this.camera.lookAt(0, 1.35, 0);

    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    // Tone mapping for richer colors + proper gamma
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // --- 3-point lighting for a polished VTuber look ---
    // Soft ambient fill
    const ambient = new AmbientLight(0xe8e0f0, 0.5);
    this.scene.add(ambient);
    // Key light (warm, front-left, slightly above)
    const key = new DirectionalLight(0xfff5e6, 1.0);
    key.position.set(1.5, 2.5, 2);
    this.scene.add(key);
    // Fill light (cool, front-right, softer)
    const fill = new DirectionalLight(0xd0e0ff, 0.4);
    fill.position.set(-1.5, 1.5, 1.5);
    this.scene.add(fill);
    // Rim / back light (accent, behind + above for edge highlight)
    const rim = new DirectionalLight(0xffffff, 0.6);
    rim.position.set(0, 2, -2);
    this.scene.add(rim);

    this.clock = new Clock();
    this.nextBlinkAt = this.scheduleBlink(0);
    this.startLoop();
  }

  private scheduleBlink(now: number): number {
    // 025-A: exponential-ish distribution for more natural cadence.
    // Median ~4s, tail up to ~10s. 10% chance of a quick "double blink".
    const base = 2 + Math.random() ** 2 * 8;
    if (Math.random() < 0.1 && now > 1) {
      // very soon follow-up blink after the upcoming one — the main
      // blink loop will re-schedule; here we just tighten the next gap.
      return now + 0.25;
    }
    return now + base;
  }

  /** 025-B: external trigger when the user returns after a long absence.
   *  Small attention turn + soft smile bump. */
  triggerReturnAttention(): void {
    try {
      this.setExpression('happy', 200, 800);
      // Small head-forward refocus: override idle look toward centre.
      this.idleLookTarget = { x: 0.02, y: 0, z: 0 };
    } catch { /* controller may still be initializing */ }
  }

  /** 025-B: brief glance in a direction — used when a push notification
   *  arrives so she "looks" at the toast. */
  triggerGlance(direction: 'top' | 'bottom' | 'left' | 'right'): void {
    const mapping: Record<string, {x: number; y: number}> = {
      top: { x: -0.3, y: 0 },
      bottom: { x: 0.3, y: 0 },
      left: { x: 0, y: 0.3 },
      right: { x: 0, y: -0.3 },
    };
    const m = mapping[direction];
    if (!m) return;
    this.idleLookTarget = { x: m.x, y: m.y, z: 0 };
    // Return to centre after ~600ms.
    setTimeout(() => {
      this.idleLookTarget = { x: 0, y: 0, z: 0 };
    }, 600);
  }

  /** 025-B: long-pause micro-action. Picks randomly between yawn, look
   *  at clock, smile. No-op if speaking. */
  triggerIdleReaction(): void {
    if (this._isSpeaking) return;
    const r = Math.random();
    try {
      if (r < 0.33) {
        // Yawn slow
        this.setExpression('exhausted', 600, 1500);
      } else if (r < 0.66) {
        // Look at imaginary clock (slight right tilt)
        this.idleLookTarget = { x: 0.05, y: 0.18, z: 0 };
        setTimeout(() => {
          this.idleLookTarget = { x: 0, y: 0, z: 0 };
        }, 900);
      } else {
        // Soft smile
        this.setExpression('warm', 400, 1800);
      }
    } catch { /* ignore */ }
  }

  /** Pick a random idle head-look direction. Weighted so most of the
   *  time she looks roughly forward with small variation, but
   *  occasionally glances to the side, up, or down. */
  private scheduleIdleLook(): void {
    const r = Math.random();
    if (r < 0.30) {
      // Look mostly forward with small variation
      this.idleLookTarget = {
        x: (Math.random() - 0.5) * 0.08,
        y: (Math.random() - 0.5) * 0.12,
        z: (Math.random() - 0.5) * 0.04,
      };
    } else if (r < 0.50) {
      // Glance left (15-25 degrees)
      this.idleLookTarget = {
        x: (Math.random() - 0.5) * 0.06,
        y: 0.20 + Math.random() * 0.20,
        z: Math.random() * 0.05,
      };
    } else if (r < 0.70) {
      // Glance right (15-25 degrees)
      this.idleLookTarget = {
        x: (Math.random() - 0.5) * 0.06,
        y: -(0.20 + Math.random() * 0.20),
        z: -Math.random() * 0.05,
      };
    } else if (r < 0.82) {
      // Look down (like reading/thinking)
      this.idleLookTarget = {
        x: 0.10 + Math.random() * 0.10,
        y: (Math.random() - 0.5) * 0.08,
        z: 0,
      };
    } else if (r < 0.92) {
      // Look slightly up
      this.idleLookTarget = {
        x: -(0.06 + Math.random() * 0.08),
        y: (Math.random() - 0.5) * 0.08,
        z: 0,
      };
    } else {
      // Tilt head curiously to one side
      this.idleLookTarget = {
        x: Math.random() * 0.04,
        y: (Math.random() - 0.5) * 0.10,
        z: (Math.random() > 0.5 ? 1 : -1) * (0.08 + Math.random() * 0.08),
      };
    }
    // Hold the look for 2-5 seconds before picking the next one
    this.nextIdleLookAt = this.elapsed + 2 + Math.random() * 3;
    // Vary the interpolation speed slightly
    this.idleLookSpeed = 1.0 + Math.random() * 1.0;
  }

  /** Small forward-facing movements while speaking — subtle nods,
   *  tiny head tilts, like someone actively talking to you. Never
   *  looks away, stays engaged with the "camera" (the user). */
  private scheduleConversationalNod(): void {
    const m = this._nodIntensity;
    const r = Math.random();
    if (r < 0.40) {
      // Nod down (emphasis while talking)
      this.idleLookTarget = {
        x: (0.02 + Math.random() * 0.03) * m,
        y: (Math.random() - 0.5) * 0.02 * m,
        z: 0,
      };
    } else if (r < 0.65) {
      // Tilt to one side (expressive)
      this.idleLookTarget = {
        x: Math.random() * 0.02 * m,
        y: (Math.random() - 0.5) * 0.02 * m,
        z: (Math.random() > 0.5 ? 1 : -1) * (0.01 + Math.random() * 0.025) * m,
      };
    } else if (r < 0.85) {
      // Return to center (neutral forward)
      this.idleLookTarget = {
        x: (Math.random() - 0.5) * 0.015 * m,
        y: (Math.random() - 0.5) * 0.015 * m,
        z: 0,
      };
    } else {
      // Up movement (like finishing a thought)
      this.idleLookTarget = {
        x: -(0.01 + Math.random() * 0.02) * m,
        y: (Math.random() - 0.5) * 0.02 * m,
        z: 0,
      };
    }
    // Faster cycling during speech — 0.8-1.8s between nods
    this.nextIdleLookAt = this.elapsed + 0.8 + Math.random() * 1.0;
    this.idleLookSpeed = 1.5 + Math.random() * 1.0;
  }

  /** Pause/resume the per-frame work without killing the RAF chain. */
  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;
    if (!paused) {
      // Discard accumulated pause time so animations don't jump.
      this.clock.getDelta();
    }
  }

  private startLoop(): void {
    const loop = (): void => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(loop);
      if (this.renderPaused) return;
      // Clamp delta to 100ms. macOS pauses the WebView render thread
      // during native window operations (Tauri startDragging, dock
      // activation, screen sleep) — when RAF resumes, clock.getDelta()
      // can return seconds of accumulated time. Without the clamp, the
      // next mixer.update / IK / gesture sample fast-forwards by that
      // amount, producing the "freeze, then jump to final pose" jank.
      // 100ms is large enough to absorb routine 1-3 frame stutters and
      // small enough that any catastrophic catch-up just looks like the
      // animation paused gracefully.
      const delta = Math.min(this.clock.getDelta(), 0.1);
      this.elapsed += delta;
      if (!this.poseLocked) this.updateCamera(delta);
      this.updateIdle(delta);
      this.updateLipsync();
      this.mixer?.update(delta);

      // Step 1: VRM update — humanoid sync + expressions (spring bones
      // are detached, see loadAvatar). We must run humanoid.update()
      // first so normalized→raw bone sync happens before we overlay
      // our custom rotations.
      // In pose mode, skip vrm.update() entirely: the normalized→raw
      // sync would overwrite manual bone rotations from TransformControls.
      // Expression updates are paused too (acceptable for animation editing).
      if (!this.poseLocked) {
        this.vrm?.update(delta);
      }

      // Step 2: Apply chest/spine/head rotation + gesture bones AFTER
      // humanoid sync so our values are the final word on those bones.
      this.applyPostUpdate();

      // Step 3: Propagate all world matrices, then run spring bones
      // exactly ONCE with the final bone state. This ensures hair/cloth
      // physics see the actual head/chest position, not the humanoid
      // rest pose.
      if (this.vrm) {
        this.vrm.scene.updateMatrixWorld(true);
        if (this.springBoneManager) {
          this.springBoneManager.update(delta);
        }
      }

      // Debug: find hair joints and check their state
      if (this._springDebugCount < 3 && this.springBoneManager) {
        const joints = (this.springBoneManager as any)._sortedJoints;
        if (this._springDebugCount === 0 && joints) {
          // Dump ALL unique stiffness values and bone names
          const stiffnessMap = new Map<number, string[]>();
          for (const j of joints) {
            const s = j.settings?.stiffness ?? -1;
            if (!stiffnessMap.has(s)) stiffnessMap.set(s, []);
            stiffnessMap.get(s)!.push(j.bone?.name || '?');
          }
          for (const [stiff, names] of stiffnessMap) {
            console.log(`[SpringBone] stiffness=${stiff}: ${names.length} joints — ${names.slice(0, 5).join(', ')}${names.length > 5 ? '...' : ''}`);
          }
          // Find a hair joint
          const hairJoint = joints.find((j: any) => /hair|ponytail/i.test(j.bone?.name || ''));
          if (hairJoint) {
            console.log('[SpringBone] Hair joint found:', hairJoint.bone.name, 'stiffness:', hairJoint.settings.stiffness, 'gravity:', hairJoint.settings.gravityPower);
          } else {
            console.log('[SpringBone] NO hair joint found in _sortedJoints!');
          }
        }
        this._springDebugCount++;
      }

      this.renderer.render(this.scene, this.camera);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Smoothly lerp the camera toward the target preset. */
  private updateCamera(delta: number): void {
    const speed = 3.0; // higher = snappier transition
    const t = Math.min(1, speed * delta);
    const c = this.cameraCurrent;
    const g = this.cameraTarget;
    c.px += (g.px - c.px) * t;
    c.py += (g.py - c.py) * t;
    c.pz += (g.pz - c.pz) * t;
    c.lx += (g.lx - c.lx) * t;
    c.ly += (g.ly - c.ly) * t;
    c.lz += (g.lz - c.lz) * t;
    c.fov += (g.fov - c.fov) * t;
    this.camera.position.set(c.px, c.py, c.pz);
    this.camera.lookAt(c.lx, c.ly, c.lz);
    this.camera.fov = c.fov;
    this.camera.updateProjectionMatrix();
  }

  private updateIdle(delta?: number): void {
    const vrm = this.vrm;
    if (!vrm) return;
    if (this.poseLocked) return;
    const dt = delta ?? 0.016;

    // When an external animation (Mixamo FBX/GLB) is playing, skip
    // the rest-pose, breathing, head micro-movement and body sway —
    // those would fight the animation clip. Expression transitions
    // and blink still run below.
    if (!this.externalAnimPlaying) {
      // Re-apply the rest pose every frame. vrm.update(delta) (called
      // after this method in the loop) syncs normalized humanoid bones
      // -> raw skeleton; if we only wrote once at load time the
      // normalized tree would snap back to its bind pose. The VRM
      // humanoid API expects rotations as per-bone quaternions in
      // NORMALIZED space.
      this.applyRestPose();

      const t = this.elapsed;

      // Compute breathing & sway values. These are applied in
      // applyPostUpdate() AFTER humanoid.update() so they don't get
      // overwritten by the normalized→raw sync.
      this._idleBreathPhase = Math.sin((t * 2 * Math.PI) / 4);
      this._idleSpineRotX = Math.sin(t * 0.25) * 0.006 + Math.sin(t * 0.13) * 0.003;
      this._idleSpineRotZ = Math.sin(t * 0.18) * 0.012 + Math.cos(t * 0.11) * 0.006;

      // --- Head look-around + emotion tilt ---
      // Values are computed here but applied in applyPostUpdate()
      // AFTER vrm.update() so the humanoid sync doesn't overwrite them.
      // When speaking, head stays mostly forward with tiny conversational nods.
      if (this.elapsed >= this.nextIdleLookAt) {
        if (this._isSpeaking) {
          this.scheduleConversationalNod();
        } else {
          this.scheduleIdleLook();
        }
      }
      const lookLerp = Math.min(1, this.idleLookSpeed * dt);
      this.idleLookCurrent.x += (this.idleLookTarget.x - this.idleLookCurrent.x) * lookLerp;
      this.idleLookCurrent.y += (this.idleLookTarget.y - this.idleLookCurrent.y) * lookLerp;
      this.idleLookCurrent.z += (this.idleLookTarget.z - this.idleLookCurrent.z) * lookLerp;

      // Eyes lead the head — faster lerp + slight overshoot
      const eyeLerp = Math.min(1, this.idleLookSpeed * this.EYE_LEAD_MULTIPLIER * dt);
      const eyeTargetX = this.idleLookTarget.x * this.EYE_OVERSHOOT;
      const eyeTargetY = this.idleLookTarget.y * this.EYE_OVERSHOOT;
      this.eyeLookCurrent.x += (eyeTargetX - this.eyeLookCurrent.x) * eyeLerp;
      this.eyeLookCurrent.y += (eyeTargetY - this.eyeLookCurrent.y) * eyeLerp;

      // Conversational micro-saccades — autonomous eye movements while speaking
      if (this._isSpeaking) {
        if (this.elapsed >= this._nextEyeMicro) {
          const r = Math.random();
          if (r < 0.3) {
            // Quick glance to the side (thinking)
            this._eyeMicroTarget = {
              x: (Math.random() - 0.5) * 0.04,
              y: (Math.random() > 0.5 ? 1 : -1) * (0.02 + Math.random() * 0.04),
            };
          } else if (r < 0.5) {
            // Brief look up (recalling)
            this._eyeMicroTarget = {
              x: -(0.02 + Math.random() * 0.03),
              y: (Math.random() - 0.5) * 0.02,
            };
          } else {
            // Return to center (re-engage with user)
            this._eyeMicroTarget = { x: 0, y: 0 };
          }
          // Quick intervals: 0.3-1.2s between micro-saccades
          this._nextEyeMicro = this.elapsed + 0.3 + Math.random() * 0.9;
        }
        // Fast lerp for snappy eye movement
        const microLerp = Math.min(1, 8 * dt);
        this._eyeMicroCurrent.x += (this._eyeMicroTarget.x - this._eyeMicroCurrent.x) * microLerp;
        this._eyeMicroCurrent.y += (this._eyeMicroTarget.y - this._eyeMicroCurrent.y) * microLerp;
      } else {
        // Not speaking — fade micro-saccades to zero
        const fadeLerp = Math.min(1, 3 * dt);
        this._eyeMicroCurrent.x *= (1 - fadeLerp);
        this._eyeMicroCurrent.y *= (1 - fadeLerp);
      }

      // Lerp emotion head tilt toward target
      const tiltLerpSpeed = 3.0;
      this.emotionHeadTilt.x = MathUtils.lerp(
        this.emotionHeadTilt.x,
        this.emotionHeadTiltTarget.x,
        Math.min(1, tiltLerpSpeed * dt),
      );
      this.emotionHeadTilt.y = MathUtils.lerp(
        this.emotionHeadTilt.y,
        this.emotionHeadTiltTarget.y,
        Math.min(1, tiltLerpSpeed * dt),
      );
      this.emotionHeadTilt.z = MathUtils.lerp(
        this.emotionHeadTilt.z,
        this.emotionHeadTiltTarget.z,
        Math.min(1, tiltLerpSpeed * dt),
      );

      // Chest/spine/head/arms are all applied in applyPostUpdate()
      // AFTER vrm.update() so the humanoid sync doesn't overwrite them.
    }

    // --- Expression transitions (per-frame lerp) ---
    const em = vrm.expressionManager;
    if (em) {
      for (const [name, state] of this.activeExpressions) {
        if (Math.abs(state.current - state.target) < 0.001) {
          state.current = state.target;
        } else {
          const direction = state.target > state.current ? 1 : -1;
          state.current += direction * state.fadeSpeed * dt;
          // Clamp to not overshoot.
          if (direction > 0 && state.current > state.target) {
            state.current = state.target;
          } else if (direction < 0 && state.current < state.target) {
            state.current = state.target;
          }
        }
        em.setValue(name, state.current);
        // Clean up fully faded-out expressions.
        if (state.target === 0 && state.current === 0) {
          this.activeExpressions.delete(name);
        }
      }

      // Blink
      if (this.blinkingUntil > 0) {
        if (this.elapsed >= this.blinkingUntil) {
          em.setValue("blink", 0);
          this.blinkingUntil = 0;
          this.nextBlinkAt = this.scheduleBlink(this.elapsed);
        }
      } else if (this.elapsed >= this.nextBlinkAt) {
        em.setValue("blink", 1);
        // Jitter duration: humans blink in 80–180 ms; fixed 120 ms reads robotic.
        this.blinkingUntil = this.elapsed + 0.09 + Math.random() * 0.09;
      }
    }
  }

  /** Read samples from the attached analyser, compute RMS, EMA-smooth,
   *  map to visemes, and apply. No-op if no analyser or no VRM yet. */
  private updateLipsync(): void {
    const analyser = this.audioAnalyser;
    const vrm = this.vrm;
    if (!analyser || !vrm) return;
    const em = vrm.expressionManager;
    if (!em) return;

    if (
      !this.audioTimeData ||
      this.audioTimeData.length !== analyser.fftSize
    ) {
      this.audioTimeData = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.audioTimeData as Float32Array<ArrayBuffer>);
    let sumSq = 0;
    for (let i = 0; i < this.audioTimeData.length; i += 1) {
      const v = this.audioTimeData[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.audioTimeData.length);
    // EMA smoothing (alpha 0.45 — more responsive to speech transients)
    this.smoothedRms = 0.45 * rms + 0.55 * this.smoothedRms;
    // Gain boost: 4.5x so even quiet speech drives full mouth range.
    const boosted = Math.min(1, this.smoothedRms * 4.5);
    const w = envelopeToVisemes(boosted);
    em.setValue("aa", w.aa);
    em.setValue("ih", w.ih);
    em.setValue("ou", w.ou);
    // `ee`/`oh` are optional in the amplitude-only result — phoneme-aware
    // paths populate them; here we just zero them out so they don't stick.
    em.setValue("ee", w.ee ?? 0);
    em.setValue("oh", w.oh ?? 0);
  }

  /** Attach the AnalyserNode from the audio playback pipeline so the
   *  RAF loop can drive visemes from actual sample energy. Caller owns
   *  the node; controller only reads it. Safe to call before or after
   *  the VRM finishes loading.
   */
  attachAudioAnalyser(analyser: AnalyserNode): void {
    this.audioAnalyser = analyser;
    this.audioTimeData = new Float32Array(analyser.fftSize);
    this.smoothedRms = 0;
  }

  /** Push the VRM out of its shipped T-pose into a natural standing
   *  rest pose every frame. Writes to the normalized humanoid bones
   *  via setNormalizedPose so vrm.update(delta) (which runs after
   *  this in the RAF loop) respects them instead of snapping back.
   *
   *  Axis convention after empirical verification with VRoid-style
   *  rigs (VRM0 normalized humanoid):
   *   - leftUpperArm: POSITIVE Z rotation brings the arm DOWN.
   *   - rightUpperArm: NEGATIVE Z rotation brings the arm DOWN.
   *  (Intuition said the opposite; live test showed otherwise. My
   *   first attempt with `getRawBoneNode` was being half-cancelled
   *   by vrm.update's normalisation, which hid the sign error.)
   *
   *  ~78deg gets the arms hanging at the sides on most VRoid-style
   *  rigs. Bump the constant if your model ends up with the elbow
   *  still poking out, drop it if the arms clip into the hips.
   */
  private applyRestPose(): void {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) return;

    const UPPER_ARM = MathUtils.degToRad(78);
    const LOWER_ARM = MathUtils.degToRad(8);

    const q = (e: Euler): [number, number, number, number] => {
      const quat = new Quaternion().setFromEuler(e);
      return [quat.x, quat.y, quat.z, quat.w];
    };

    humanoid.setNormalizedPose({
      leftUpperArm: { rotation: q(new Euler(0, 0, UPPER_ARM)) },
      rightUpperArm: { rotation: q(new Euler(0, 0, -UPPER_ARM)) },
      leftLowerArm: { rotation: q(new Euler(0, LOWER_ARM, 0)) },
      rightLowerArm: { rotation: q(new Euler(0, -LOWER_ARM, 0)) },
    });
  }

  async loadAvatar(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const loadedVrm = (gltf.userData as { vrm?: VRM }).vrm;
    if (!loadedVrm) {
      throw new Error("Loaded GLTF did not contain a VRM");
    }
    if (this.disposed) {
      // Discard if we were disposed mid-load.
      VRMUtils.deepDispose(loadedVrm.scene);
      return;
    }
    VRMUtils.rotateVRM0(loadedVrm);
    // Disable VRM lookAt auto-tracking — it fights our manual head
    // rotation in the idle look-around system. We drive head rotation
    // ourselves via updateIdle().
    if (loadedVrm.lookAt) {
      loadedVrm.lookAt.autoUpdate = false;
    }
    this.vrm = loadedVrm;
    this.scene.add(loadedVrm.scene);

    // Log available expressions for debugging blendshape mapping
    const em = loadedVrm.expressionManager;
    if (em) {
      const names: string[] = [];
      if (em.expressions) {
        for (const expr of em.expressions) {
          if (expr.expressionName) names.push(expr.expressionName);
        }
      }
      console.log('[VRM] Available expressions:', names.join(', ') || 'none');
    }

    // Detach the spring bone manager from VRM so vrm.update() doesn't
    // run spring physics. We manage it ourselves in the render loop,
    // calling it exactly once AFTER all bone manipulation (head
    // rotation, chest breathing, spine sway) so hair/cloth physics
    // see the final bone state.
    const sbm = (loadedVrm as any).springBoneManager;
    if (sbm) {
      this.springBoneManager = sbm;
      (loadedVrm as any).springBoneManager = null;
      console.log(
        '[VRM] Spring bone manager detached:',
        sbm._sortedJoints?.length ?? sbm._joints?.length ?? '?',
        'joints,',
        sbm._colliderGroups?.length ?? sbm.colliderGroups?.length ?? '?',
        'collider groups',
      );
      // Override spring bone settings at runtime for all joints
      // The VRM file may have stiffness=1-3 (rigid) — force natural values
      const sortedJoints = sbm._sortedJoints || [];
      for (const j of sortedJoints) {
        const name = (j.bone?.name || '').toLowerCase();
        if (/hair|ahoge|ponytail|sailor|longhair/.test(name)) {
          j.settings.stiffness = 0.08;
          j.settings.gravityPower = 0.06;
          j.settings.dragForce = 0.25;
          j.settings.gravityDir = { x: 0, y: -1, z: 0 };
        } else if (/skirt/.test(name)) {
          j.settings.stiffness = 0.15;
          j.settings.gravityPower = 0.05;
          j.settings.dragForce = 0.3;
          j.settings.gravityDir = { x: 0, y: -1, z: 0 };
        } else if (/breast/.test(name)) {
          j.settings.stiffness = 0.4;
          j.settings.gravityPower = 0.02;
          j.settings.dragForce = 0.5;
          j.settings.gravityDir = { x: 0, y: -1, z: 0 };
        } else {
          j.settings.stiffness = 0.2;
          j.settings.gravityPower = 0.04;
          j.settings.dragForce = 0.3;
          j.settings.gravityDir = { x: 0, y: -1, z: 0 };
        }
      }
      console.log('[VRM] Patched spring bone settings for', sortedJoints.length, 'joints');

      // Apply saved lab settings from localStorage
      const savedPhysics = localStorage.getItem('seraphine.lab.physics');
      if (savedPhysics) this.setSpringBoneStiffnessMultiplier(parseFloat(savedPhysics));
      const savedNods = localStorage.getItem('seraphine.lab.nods');
      if (savedNods) this._nodIntensity = parseFloat(savedNods);

      // Re-initialize spring bone state now that settings are patched
      // and the scene is rotated (rotateVRM0 applied 180deg Y).
      loadedVrm.scene.updateMatrixWorld(true);
      sbm.setInitState();
    } else {
      console.warn('[VRM] No spring bone manager found');
    }
    // Rest pose is applied every frame by updateIdle() via
    // applyRestPose(); no one-shot needed here.
  }

  async playAudioWithLipSync(stream: ReadableStream<Uint8Array>): Promise<void> {
    await playAudioWithLipSync(stream, this.vrm);
  }

  // -------------------------------------------------------------------------
  // Expression system — smooth transitions
  // -------------------------------------------------------------------------

  /**
   * Smoothly transition to an emotion expression over `fadeMs` milliseconds.
   * Automatically fades out after `holdMs` (0 = hold until next call).
   */
  setExpression(emotion: string, fadeMs = 300, holdMs = 0): void {
    const mapping = resolveEmotion(emotion);
    this.applyEmotionMapping(mapping, fadeMs, holdMs);
    this._currentEmotion = emotion;
  }

  /**
   * Legacy method — backward compatible with existing callers.
   * Internally delegates to the new expression transition system.
   */
  setEmotion(label: EmotionLabel): void {
    this.setExpression(label, 300, 0);
  }

  /** Clear all active expressions back to neutral, cancel any running gesture
   *  and stop any external animation. */
  resetToIdle(): void {
    // Fade out all active expressions.
    for (const [, state] of this.activeExpressions) {
      state.target = 0;
      // Fast fade for reset.
      state.fadeSpeed = 1 / 0.15;
    }
    this.emotionHeadTiltTarget = { x: 0, y: 0, z: 0 };
    this._currentEmotion = null;
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.gesturePlayer.cancel();
    this.stopAnimation(0.15);
  }

  /** Get the list of available expression/emotion names (for the lab UI). */
  getAvailableExpressions(): string[] {
    return Object.keys(EMOTION_MAP);
  }

  /** Get the list of available gesture names (for the lab UI). */
  getAvailableGestures(): string[] {
    return Object.keys(GESTURE_LIBRARY);
  }

  /** Smoothly transition the camera to a named preset.
   *  Available: 'bust' (default sidebar), 'face' (close-up), 'fullBody'. */
  /** When true, head look-around is suppressed and replaced with small
   *  forward-facing conversational nods. Set to true on tts_start,
   *  false on tts_end/turn_end so she "looks at you" while speaking. */
  setSpeaking(speaking: boolean): void {
    console.log(`[avatar] setSpeaking(${speaking})`);
    const wasSpeaking = this._isSpeaking;
    this._isSpeaking = speaking;
    if (speaking) {
      // Smoothly return gaze to forward
      this.idleLookTarget = { x: 0, y: 0, z: 0 };
    } else if (wasSpeaking) {
      // Resume idle loop once TTS is done (no-op if none is set).
      this.kickIdleLoop();
    }
  }

  setCameraPreset(preset: string): void {
    const p = VrmAvatarController.CAMERA_PRESETS[preset];
    if (!p) return;
    this.cameraTarget = { ...p };
  }

  /** Get the list of available camera presets. */
  getAvailableCameraPresets(): string[] {
    return Object.keys(VrmAvatarController.CAMERA_PRESETS);
  }

  /** Swap the loaded VRM avatar at runtime. Disposes the old one. */
  async swapAvatar(url: string): Promise<void> {
    // Stop any external animation and clear cached clips (they reference
    // the old skeleton's bone names).
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.currentAction = null;
    this.externalAnimPlaying = false;
    this.loadedClips.clear();

    this.springBoneManager = null;
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    await this.loadAvatar(url);
  }

  // -------------------------------------------------------------------------
  // Gesture system
  // -------------------------------------------------------------------------

  /**
   * Play a named gesture. Checks user-saved gestures first (from the
   * AnimationLab) then falls back to `GESTURE_LIBRARY`. Returns a
   * Promise that resolves when the animation finishes.
   *
   * Opts (SDD 075, Phase 2): support fade-in/out and queueing so gestures
   * can crossfade instead of hard-cutting each other.
   */
  playGesture(name: string, opts?: Parameters<GesturePlayer['play']>[1]): Promise<void> {
    const def = this.userGestures.get(name) ?? GESTURE_LIBRARY[name];
    if (!def) {
      return Promise.reject(new Error(`Unknown gesture: ${name}`));
    }
    // One-shot gestures pause the idle loop so they don't fight for the
    // same bones. Idle resumes on finish.
    this.idleSuppressed = true;
    const p = this.gesturePlayer.play(def, opts);
    void p.finally(() => {
      this.idleSuppressed = false;
      this.kickIdleLoop();
    });
    return p;
  }

  /** Play an arbitrary gesture definition (used by the Gesture Editor). */
  playGestureDef(def: GestureDefinition, opts?: Parameters<GesturePlayer['play']>[1]): Promise<void> {
    return this.gesturePlayer.play(def, opts);
  }

  /**
   * Register (or overwrite) a user-saved gesture so it becomes playable
   * by name everywhere. Called at app boot after fetching `/lab/gestures`
   * and again after each successful save in AnimationLab.
   */
  registerGesture(name: string, def: GestureDefinition): void {
    this.userGestures.set(name, def);
  }

  /** Bulk registration — used on app boot. */
  registerGestures(defs: Record<string, GestureDefinition>): void {
    for (const [name, def] of Object.entries(defs)) {
      this.userGestures.set(name, def);
    }
  }

  /** Return the merged list (user-saved + library), deduped. */
  getAvailableGestureNames(): string[] {
    const set = new Set<string>(Object.keys(GESTURE_LIBRARY));
    for (const name of this.userGestures.keys()) set.add(name);
    return [...set].sort();
  }

  // -------------------------------------------------------------------------
  // Idle loop — runs a chosen gesture continuously while the avatar is
  // otherwise idle (no TTS, no one-shot gesture). Resumes automatically
  // when `setSpeaking(false)` or a one-shot finishes.
  // -------------------------------------------------------------------------

  /**
   * Set (or clear with null) the idle gesture. If the name is not
   * registered the call is silently ignored — that way the lab can set
   * it optimistically before the controller has fetched the library.
   */
  setIdleGesture(name: string | null): void {
    if (this.idleGestureName === name) return;
    this.idleGestureName = name;
    if (!name) {
      // Loop exits naturally on its next iteration check.
      return;
    }
    this.kickIdleLoop();
  }

  getIdleGesture(): string | null {
    return this.idleGestureName;
  }

  private async kickIdleLoop(): Promise<void> {
    if (this.idleLoopActive) return;
    this.idleLoopActive = true;
    try {
      while (
        !this.disposed &&
        this.idleGestureName !== null &&
        !this.idleSuppressed &&
        !this._isSpeaking
      ) {
        const def =
          this.userGestures.get(this.idleGestureName) ??
          GESTURE_LIBRARY[this.idleGestureName];
        if (!def) break;
        try {
          await this.gesturePlayer.play(def);
        } catch {
          // Defensive — don't let a single failure kill the loop.
          break;
        }
      }
    } finally {
      this.idleLoopActive = false;
    }
  }

  // -------------------------------------------------------------------------
  // External animation system (Mixamo FBX / GLB)
  // -------------------------------------------------------------------------

  /**
   * Load an external animation file (FBX or GLB) and play it on the VRM.
   * Retargets the clip's bone tracks to the VRM humanoid skeleton.
   */
  async playAnimation(
    url: string,
    options?: { loop?: boolean; fadeIn?: number },
  ): Promise<void> {
    const vrm = this.vrm;
    if (!vrm) return;

    const loop = options?.loop ?? false;
    const fadeIn = options?.fadeIn ?? 0.3;

    // Create mixer lazily, attached to the VRM scene root.
    if (!this.mixer) {
      this.mixer = new AnimationMixer(vrm.scene);
    }

    // Load or use cached clip.
    let clip = this.loadedClips.get(url);
    if (!clip) {
      clip = await this.loadAndRetargetClip(url, vrm);
      this.loadedClips.set(url, clip);
    }

    // Stop any currently playing external animation.
    if (this.currentAction) {
      this.currentAction.fadeOut(fadeIn);
    }

    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.fadeIn(fadeIn).play();

    this.currentAction = action;
    this.externalAnimPlaying = true;

    // For one-shot animations, return to idle when finished.
    if (!loop) {
      const onFinished = (): void => {
        this.mixer?.removeEventListener("finished", onFinished);
        if (this.currentAction === action) {
          this.stopAnimation(fadeIn);
        }
      };
      this.mixer.addEventListener("finished", onFinished);
    }
  }

  /** Stop the currently playing external animation and return to idle. */
  stopAnimation(fadeOut = 0.3): void {
    if (this.currentAction) {
      this.currentAction.fadeOut(fadeOut);
      this.currentAction = null;
    }
    this.externalAnimPlaying = false;
  }

  /** Get list of pre-loaded animation URLs. */
  getLoadedAnimations(): string[] {
    return Array.from(this.loadedClips.keys());
  }

  /**
   * Load a clip from FBX or GLB, retarget Mixamo bone names to VRM
   * humanoid bone names, and return the retargeted AnimationClip.
   */
  private async loadAndRetargetClip(
    url: string,
    vrm: VRM,
  ): Promise<AnimationClip> {
    const ext = url.split(".").pop()?.toLowerCase();
    let clips: AnimationClip[];

    if (ext === "fbx") {
      const fbxLoader = new FBXLoader();
      const group = await fbxLoader.loadAsync(url);
      clips = group.animations;
    } else {
      // GLB / GLTF
      const gltfLoader = new GLTFLoader();
      const gltf = await gltfLoader.loadAsync(url);
      clips = gltf.animations;
    }

    if (!clips || clips.length === 0) {
      throw new Error(`No animation clips found in ${url}`);
    }

    console.log(`[anim] loaded ${url}: ${clips.length} clip(s), first has ${clips[0].tracks.length} tracks, duration ${clips[0].duration}s`);
    // Log ALL unique bone names so we can build the mapping
    const boneNames = [...new Set(clips[0].tracks.map(t => t.name.split('.')[0]))];
    console.log(`[anim] ALL bone names in FBX (${boneNames.length}):`, boneNames);

    const retargeted = this.retargetClip(clips[0], vrm);
    console.log(`[anim] retargeted: ${retargeted.tracks.length} tracks (from ${clips[0].tracks.length} original)`);
    if (retargeted.tracks.length > 0) {
      console.log(`[anim] retargeted sample:`, retargeted.tracks.slice(0, 3).map(t => t.name));
    }
    return retargeted;
  }

  /**
   * Retarget a Mixamo AnimationClip to the VRM skeleton.
   * Replaces track bone names from Mixamo convention to the actual
   * bone object names in the VRM's raw skeleton.
   */
  private retargetClip(clip: AnimationClip, vrm: VRM): AnimationClip {
    const retargetedTracks: KeyframeTrack[] = [];

    for (const track of clip.tracks) {
      // Track names are like "mixamorigHead.quaternion" or
      // "mixamorigHead.position".
      const dotIndex = track.name.indexOf(".");
      if (dotIndex === -1) continue;

      const boneName = track.name.substring(0, dotIndex);
      const property = track.name.substring(dotIndex + 1);

      const vrmBoneName = MIXAMO_TO_VRM[boneName];
      if (!vrmBoneName) continue; // skip unmapped bones (fingers, etc.)

      const boneNode = vrm.humanoid?.getRawBoneNode(
        vrmBoneName as Parameters<typeof vrm.humanoid.getRawBoneNode>[0],
      );
      if (!boneNode) continue;

      const newTrackName = `${boneNode.name}.${property}`;

      // ONLY apply rotation (quaternion) tracks. Position and scale
      // tracks from external rigs almost always cause deformation
      // because bone lengths/positions differ between the source rig
      // and the VRM skeleton. The VRM keeps its own bone positions;
      // we only drive the rotations from the animation.
      if (
        property === "quaternion" &&
        track instanceof QuaternionKeyframeTrack
      ) {
        retargetedTracks.push(
          new QuaternionKeyframeTrack(
            newTrackName,
            Array.from(track.times),
            Array.from(track.values),
          ),
        );
      }
      // Position and scale tracks are intentionally skipped.
    }

    return new AnimationClip(clip.name || "retargeted", clip.duration, retargetedTracks);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private applyEmotionMapping(
    mapping: EmotionMapping,
    fadeMs: number,
    holdMs: number,
  ): void {
    const fadeSec = Math.max(fadeMs, 1) / 1000;
    const fadeSpeed = 1 / fadeSec;

    // Fade out all currently active expressions.
    for (const [, state] of this.activeExpressions) {
      state.target = 0;
      state.fadeSpeed = fadeSpeed;
    }

    // Fade in the new expression targets.
    for (const { expression, weight } of mapping.expressions) {
      const existing = this.activeExpressions.get(expression);
      if (existing) {
        existing.target = weight;
        existing.fadeSpeed = fadeSpeed;
      } else {
        this.activeExpressions.set(expression, {
          target: weight,
          current: 0,
          fadeSpeed,
        });
      }
    }

    // Head tilt target.
    this.emotionHeadTiltTarget = {
      x: mapping.headTilt?.x ?? 0,
      y: mapping.headTilt?.y ?? 0,
      z: mapping.headTilt?.z ?? 0,
    };

    // Hold timer: auto-fade-out after holdMs.
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (holdMs > 0) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        // Fade everything back to neutral.
        for (const [, state] of this.activeExpressions) {
          state.target = 0;
        }
        this.emotionHeadTiltTarget = { x: 0, y: 0, z: 0 };
        this._currentEmotion = null;
      }, holdMs);
    }
  }

  /**
   * Apply chest/spine/head rotation + gesture bone offsets AFTER
   * vrm.update(). humanoid.update() syncs normalized→raw which
   * overwrites raw bone rotations set before it. We write here so
   * our values are the final word before spring bone simulation and
   * render.
   */
  private applyPostUpdate(): void {
    const vrm = this.vrm;
    if (!vrm) return;
    if (this.poseLocked) return;

    // --- Chest breathing + spine sway (must be after humanoid sync) ---
    if (!this.externalAnimPlaying) {
      const chest = vrm.humanoid?.getRawBoneNode("chest") as
        | Object3D
        | null
        | undefined;
      if (chest) {
        const gestureOffset = this.gesturePlayer.getOffset("chest");
        const idleQuat = new Quaternion().setFromEuler(
          new Euler(this._idleBreathPhase * 0.015, 0, 0),
        );
        idleQuat.multiply(gestureOffset);
        chest.quaternion.copy(idleQuat);
        chest.position.y = this._idleBreathPhase * 0.002;
      }

      const spine = vrm.humanoid?.getRawBoneNode("spine") as
        | Object3D
        | null
        | undefined;
      if (spine) {
        const gestureOffset = this.gesturePlayer.getOffset("spine");
        const idleQuat = new Quaternion().setFromEuler(
          new Euler(this._idleSpineRotX, 0, this._idleSpineRotZ),
        );
        idleQuat.multiply(gestureOffset);
        spine.quaternion.copy(idleQuat);
      }
    }

    // --- Head: look-around + emotion tilt + micro-drift + gesture ---
    if (!this.externalAnimPlaying) {
      const head = vrm.humanoid?.getRawBoneNode("head") as
        | Object3D
        | null
        | undefined;
      if (head) {
        const t = this.elapsed;
        const idleRotX =
          this.idleLookCurrent.x +
          Math.sin(t * 0.7) * 0.005 +
          this.emotionHeadTilt.x;
        const idleRotY =
          this.idleLookCurrent.y +
          Math.sin(t * 0.5) * 0.008 +
          this.emotionHeadTilt.y;
        const idleRotZ =
          this.idleLookCurrent.z +
          Math.sin(t * 0.4) * 0.003 +
          this.emotionHeadTilt.z;
        const gestureOffset = this.gesturePlayer.getOffset("head");
        const q = new Quaternion().setFromEuler(
          new Euler(idleRotX, idleRotY, idleRotZ),
        );
        q.multiply(gestureOffset);
        head.quaternion.copy(q);

        // --- IK head look-at (SDD 075 Phase 3) --- Weighted average of
        // each target's desired local quaternion, then a single slerp from
        // the FK base. Reads FK base BEFORE the loop so successive targets
        // don't compound on top of each other (which used to cause
        // over-rotation / NaN with 2+ active head targets).
        const ikTargets = this.gesturePlayer.getActiveIKTargets();
        if (ikTargets.length > 0) {
          const qFk = head.quaternion.clone();
          const desiredAccum = new Quaternion(0, 0, 0, 0);
          let totalWeight = 0;
          const worldTarget = new Vector3();
          for (const { target, weight } of ikTargets) {
            if (target.chain !== 'head') continue;
            if (weight <= 0) continue;
            if (target.space === 'world') {
              worldTarget.set(target.target.x, target.target.y, target.target.z);
            } else {
              // 'rig': relative to avatar root.
              worldTarget.set(target.target.x, target.target.y, target.target.z);
              vrm.scene.localToWorld(worldTarget);
            }
            // Update matrices so solver sees up-to-date FK pose. Note the
            // head quaternion is still qFk here — we never mutate it inside
            // the loop, so each target sees the same FK base.
            head.updateWorldMatrix(true, false);
            const desiredWorld = solveHeadLookAt(head, worldTarget);
            const desiredLocal = worldQuatToLocal(desiredWorld, head);
            // Hemisphere-correct accumulation: flip sign if dot < 0 so we
            // average along the shorter arc. (Standard quaternion weighted
            // average via component-add-then-normalize; close to slerp for
            // small angles and free of the "slerp of slerp" compounding.)
            const dot =
              desiredAccum.x * desiredLocal.x +
              desiredAccum.y * desiredLocal.y +
              desiredAccum.z * desiredLocal.z +
              desiredAccum.w * desiredLocal.w;
            const sign = dot < 0 ? -1 : 1;
            desiredAccum.x += sign * weight * desiredLocal.x;
            desiredAccum.y += sign * weight * desiredLocal.y;
            desiredAccum.z += sign * weight * desiredLocal.z;
            desiredAccum.w += sign * weight * desiredLocal.w;
            totalWeight += weight;
          }
          if (totalWeight > 0) {
            const lenSq =
              desiredAccum.x * desiredAccum.x +
              desiredAccum.y * desiredAccum.y +
              desiredAccum.z * desiredAccum.z +
              desiredAccum.w * desiredAccum.w;
            if (lenSq > 1e-8) {
              desiredAccum.normalize();
              head.quaternion.copy(qFk).slerp(desiredAccum, Math.min(totalWeight, 1));
            }
          }
        }
      }

      // --- Eyes: lead head + conversational micro-saccades ---
      // Combine: (1) lead offset (eyes ahead of head) + (2) micro-saccades
      const eyeOffsetX = (this.eyeLookCurrent.x - this.idleLookCurrent.x) + this._eyeMicroCurrent.x;
      const eyeOffsetY = (this.eyeLookCurrent.y - this.idleLookCurrent.y) + this._eyeMicroCurrent.y;

      const em = vrm.expressionManager;
      if (em) {
        // X axis: positive = looking down, negative = looking up
        const lookUpVal = Math.max(0, -eyeOffsetX * 8);
        const lookDownVal = Math.max(0, eyeOffsetX * 8);
        // Y axis: positive = looking right, negative = looking left
        const lookLeftVal = Math.max(0, -eyeOffsetY * 8);
        const lookRightVal = Math.max(0, eyeOffsetY * 8);

        em.setValue("lookUp", Math.min(1, lookUpVal));
        em.setValue("lookDown", Math.min(1, lookDownVal));
        em.setValue("lookLeft", Math.min(1, lookLeftVal));
        em.setValue("lookRight", Math.min(1, lookRightVal));
      }
    }

    // --- Gesture arm/hand bones ---
    if (this.gesturePlayer.isPlaying) {
      for (const boneName of [
        "rightUpperArm",
        "rightLowerArm",
        "rightHand",
        "leftUpperArm",
        "leftLowerArm",
        "leftHand",
      ]) {
        const offset = this.gesturePlayer.getOffset(boneName);
        if (offset.x !== 0 || offset.y !== 0 || offset.z !== 0 || offset.w !== 1) {
          const boneNode = vrm.humanoid?.getRawBoneNode(boneName as any) as
            | Object3D
            | null
            | undefined;
          if (boneNode) {
            boneNode.quaternion.multiply(offset);
          }
        }
      }
    }

    // --- IK arm reach (SDD 075 Phase 4) --- Run AFTER gesture arm offsets so
    // IK overrides (or blends against) the FK pose for the chain.
    const ikTargets = this.gesturePlayer.getActiveIKTargets();
    if (ikTargets.length > 0) {
      const worldTarget = new Vector3();
      const pole = new Vector3();
      for (const { target, weight } of ikTargets) {
        if (target.chain !== 'leftArm' && target.chain !== 'rightArm') continue;
        if (target.space === 'world') {
          worldTarget.set(target.target.x, target.target.y, target.target.z);
        } else {
          worldTarget.set(target.target.x, target.target.y, target.target.z);
          vrm.scene.localToWorld(worldTarget);
        }
        const side = target.chain === 'leftArm' ? 'left' : 'right';
        const shoulder = vrm.humanoid?.getRawBoneNode(`${side}UpperArm` as any) as Object3D | null;
        const elbow = vrm.humanoid?.getRawBoneNode(`${side}LowerArm` as any) as Object3D | null;
        const hand = vrm.humanoid?.getRawBoneNode(`${side}Hand` as any) as Object3D | null;
        if (!shoulder || !elbow || !hand) continue;
        shoulder.updateWorldMatrix(true, false);
        elbow.updateWorldMatrix(false, false);
        hand.updateWorldMatrix(false, false);
        // Pole hint: character-outward + strongly downward. The down bias
        // survives projection when the target is up near the head (wave
        // pose), keeping the elbow from collapsing inward through the
        // torso. Sign of X flipped for VRM 1.0 (right = -X; in scene we
        // re-check by checking whether shoulder is on -X side of root).
        shoulder.getWorldPosition(pole);
        const isRight = side === 'right';
        // Outward along world X: for a VRM facing +Z in its rig, right
        // shoulder has -X world. If the scene rotated the avatar, we flip
        // so that pole still points character-outward.
        const shoulderWorldX = pole.x - (vrm.scene.position?.x ?? 0);
        const outwardSign = isRight
          ? (shoulderWorldX < 0 ? -1 : 1)
          : (shoulderWorldX > 0 ? 1 : -1);
        pole.x += outwardSign * 0.35;
        pole.y -= 1.0;
        try {
          const res = solveArmIK(shoulder, elbow, hand, worldTarget, pole);
          shoulder.quaternion.slerp(res.upperArmLocal, weight);
          elbow.quaternion.slerp(res.lowerArmLocal, weight);
        } catch { /* solver NaN — skip */ }
      }
    }
  }

  /**
   * Directly set a VRM blendshape weight (0..1) without going through
   * the emotion mapping system. Used by the lab UI sliders for precise
   * per-blendshape control. Bypasses transitions — sets instantly.
   */
  setRawBlendshape(name: string, weight: number): void {
    const em = this.vrm?.expressionManager;
    if (!em) return;
    em.setValue(name, Math.max(0, Math.min(1, weight)));
  }

  /** Get the names of all VRM blendshapes available on the loaded model. */
  getAvailableBlendshapes(): string[] {
    const em = this.vrm?.expressionManager;
    if (!em) return [];
    // three-vrm stores expressions in a Map-like structure
    const names: string[] = [];
    // expressionManager.expressions is a Map<string, VRMExpression>
    if (em.expressions) {
      for (const expr of em.expressions) {
        if (expr.expressionName) {
          names.push(expr.expressionName);
        }
      }
    }
    return names.length > 0 ? names : FALLBACK_EXPRESSIONS;
  }

  // ── Spring bone physics control ──────────────────────────────

  private _springStiffnessMultiplier = 1.0;
  private _springBaseSettings: Map<any, { stiffness: number; gravityPower: number; dragForce: number }> = new Map();
  private _nodIntensity = 1.0;

  /** Get current spring bone physics multiplier (1.0 = default). */
  getSpringBoneStiffnessMultiplier(): number {
    return this._springStiffnessMultiplier ?? 1.0;
  }

  /** Get current nod intensity multiplier. */
  getNodIntensity(): number {
    return this._nodIntensity;
  }

  /** Set conversational nod intensity (0.5 = subtle, 3.0 = exaggerated). */
  setNodIntensity(multiplier: number): void {
    this._nodIntensity = multiplier;
  }

  /** Set spring bone stiffness multiplier (0.1 = very soft, 2.0 = rigid).
   *  Affects hair, skirt, and all spring bones proportionally. */
  setSpringBoneStiffnessMultiplier(multiplier: number): void {
    this._springStiffnessMultiplier = multiplier;
    if (!this.springBoneManager) return;
    const joints = this.springBoneManager._sortedJoints || [];
    for (const j of joints) {
      let base = this._springBaseSettings.get(j);
      if (!base) {
        base = { stiffness: j.settings.stiffness, gravityPower: j.settings.gravityPower, dragForce: j.settings.dragForce };
        this._springBaseSettings.set(j, base);
      }
      j.settings.stiffness = base.stiffness * multiplier;
      j.settings.gravityPower = base.gravityPower * multiplier;
    }
  }

  // ── Pose mode (Animation Lab) ─────────────────────────────────

  /** Freeze idle/rest updates so the user can manipulate bones freely. */
  enterPoseMode(): void {
    this.poseLocked = true;
    this.gesturePlayer.cancel();
    if (this.mixer) this.mixer.timeScale = 0;
  }

  exitPoseMode(): void {
    this.poseLocked = false;
    if (this.mixer) this.mixer.timeScale = 1;
  }

  /** Accessors for Animation Lab (scene graph manipulation). */
  getScene(): Scene { return this.scene; }
  getCamera(): PerspectiveCamera { return this.camera; }
  getRenderer(): WebGLRenderer { return this.renderer; }
  getVrm(): VRM | null { return this.vrm; }

  /** Rest quaternions for bones that have applyRestPose(). */
  private static readonly REST_BONES: Record<string, Euler> = {
    leftUpperArm: new Euler(0, 0, MathUtils.degToRad(78)),
    rightUpperArm: new Euler(0, 0, -MathUtils.degToRad(78)),
    leftLowerArm: new Euler(0, MathUtils.degToRad(8), 0),
    rightLowerArm: new Euler(0, -MathUtils.degToRad(8), 0),
  };

  private static readonly _restQuats: Record<string, Quaternion> = (() => {
    const out: Record<string, Quaternion> = {};
    for (const [k, euler] of Object.entries(VrmAvatarController.REST_BONES)) {
      out[k] = new Quaternion().setFromEuler(euler);
    }
    return out;
  })();

  /** Return delta rotation (relative to rest pose) for a bone. */
  getBoneDelta(boneName: string): { x: number; y: number; z: number } {
    const vrm = this.vrm;
    if (!vrm) return { x: 0, y: 0, z: 0 };
    const node = vrm.humanoid?.getRawBoneNode(boneName as any) as Object3D | null | undefined;
    if (!node) return { x: 0, y: 0, z: 0 };
    const rest = VrmAvatarController._restQuats[boneName];
    let deltaQ: Quaternion;
    if (rest) {
      deltaQ = rest.clone().invert().multiply(node.quaternion.clone());
    } else {
      deltaQ = node.quaternion.clone();
    }
    const euler = new Euler().setFromQuaternion(deltaQ, 'XYZ');
    return { x: euler.x, y: euler.y, z: euler.z };
  }

  /** Apply a delta rotation on top of rest pose. */
  setBoneDelta(boneName: string, delta: { x: number; y: number; z: number }): void {
    const vrm = this.vrm;
    if (!vrm) return;
    const node = vrm.humanoid?.getRawBoneNode(boneName as any) as Object3D | null | undefined;
    if (!node) return;
    const rest = VrmAvatarController._restQuats[boneName];
    const deltaQ = new Quaternion().setFromEuler(new Euler(delta.x, delta.y, delta.z, 'XYZ'));
    if (rest) {
      node.quaternion.copy(rest).multiply(deltaQ);
    } else {
      node.quaternion.copy(deltaQ);
    }
  }

  /** Reset all humanoid bones to rest pose (no idle offsets). */
  resetAllBonesToRest(): void {
    const vrm = this.vrm;
    if (!vrm) return;
    this.applyRestPose();
    vrm.update(0);
    // Clear non-rest bones to identity
    const nonRest = [
      'head', 'neck', 'chest', 'spine', 'hips',
      'leftShoulder', 'rightShoulder',
      'leftHand', 'rightHand',
      'leftUpperLeg', 'rightUpperLeg',
      'leftLowerLeg', 'rightLowerLeg',
      'leftFoot', 'rightFoot',
    ];
    for (const bn of nonRest) {
      const node = vrm.humanoid?.getRawBoneNode(bn as any) as Object3D | null | undefined;
      if (node) node.quaternion.identity();
    }
    // Rest-pose bones
    for (const [bn, q] of Object.entries(VrmAvatarController._restQuats)) {
      const node = vrm.humanoid?.getRawBoneNode(bn as any) as Object3D | null | undefined;
      if (node) node.quaternion.copy(q);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.gesturePlayer.cancel();
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.currentAction = null;
    this.externalAnimPlaying = false;
    this.loadedClips.clear();
    this.springBoneManager = null;
    this._springBaseSettings.clear();
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    // Dispose lights + their shadow maps before clearing the scene.
    // three's WebGLRenderer.dispose() does NOT release per-light shadow
    // textures or the light's internal target object, so we have to walk
    // the graph ourselves.
    this.scene.traverse((obj) => {
      if (obj instanceof DirectionalLight || obj instanceof AmbientLight) {
        obj.shadow?.map?.dispose();
        (obj as { dispose?: () => void }).dispose?.();
      }
    });
    this.scene.clear();
    this.renderer.dispose();
  }
}
