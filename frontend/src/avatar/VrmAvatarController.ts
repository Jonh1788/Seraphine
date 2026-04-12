import {
  AmbientLight,
  Clock,
  DirectionalLight,
  Euler,
  MathUtils,
  PerspectiveCamera,
  Quaternion,
  Scene,
  WebGLRenderer,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type { AvatarAdapter } from "./AvatarAdapter";
import { envelopeToVisemes, playAudioWithLipSync } from "./lipsync";
import { resolveEmotion, EMOTION_MAP, type EmotionMapping } from "./expressions";
import { GesturePlayer, GESTURE_LIBRARY } from "./gestures";

type EmotionLabel = "neutral" | "happy" | "sad" | "angry" | "thinking" | string;

/** Tracked state for a single VRM expression being faded in/out. */
interface ExpressionState {
  target: number;
  current: number;
  /** Weight change per second (derived from fadeMs). */
  fadeSpeed: number;
}

export class VrmAvatarController implements AvatarAdapter {
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly clock: Clock;
  private vrm: VRM | null = null;
  private rafId: number | null = null;
  private disposed = false;
  /** @deprecated Kept for backward compat with old setEmotion() calls. */
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new Scene();

    const width = canvas.width || 400;
    const height = canvas.height || 600;
    this.camera = new PerspectiveCamera(30, width / height, 0.1, 20);
    // Frame bust/upper body — closer to the model, looking at chest level
    this.camera.position.set(0, 1.45, 0.9);
    this.camera.lookAt(0, 1.35, 0);

    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);

    const ambient = new AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);
    const dir = new DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 2, 1);
    this.scene.add(dir);

    this.clock = new Clock();
    this.nextBlinkAt = this.scheduleBlink(0);
    this.startLoop();
  }

  private scheduleBlink(now: number): number {
    return now + 3 + Math.random() * 3;
  }

  private startLoop(): void {
    const loop = (): void => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(loop);
      const delta = this.clock.getDelta();
      this.elapsed += delta;
      this.updateIdle(delta);
      this.updateLipsync();
      this.vrm?.update(delta);
      this.renderer.render(this.scene, this.camera);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private updateIdle(delta?: number): void {
    const vrm = this.vrm;
    if (!vrm) return;
    const dt = delta ?? 0.016;

    // Re-apply the rest pose every frame. vrm.update(delta) (called
    // after this method in the loop) syncs normalized humanoid bones
    // -> raw skeleton; if we only wrote once at load time the
    // normalized tree would snap back to its bind pose. The VRM
    // humanoid API expects rotations as per-bone quaternions in
    // NORMALIZED space.
    this.applyRestPose();

    const t = this.elapsed;

    // Breathing — chest rises gently on a ~4s cycle
    const chest = vrm.humanoid?.getRawBoneNode("chest") as
      | Object3D
      | null
      | undefined;
    if (chest) {
      const breathPhase = Math.sin((t * 2 * Math.PI) / 4);
      const idleRotX = breathPhase * 0.015;
      const idleRotY = 0;
      const idleRotZ = 0;
      // Add gesture offset additively
      const gestureOffset = this.gesturePlayer.getOffset("chest");
      const idleQuat = new Quaternion().setFromEuler(
        new Euler(idleRotX, idleRotY, idleRotZ),
      );
      idleQuat.multiply(gestureOffset);
      chest.quaternion.copy(idleQuat);
      // Subtle shoulder rise with breath
      chest.position.y = breathPhase * 0.002;
    }

    // Subtle head micro-movement — slow drift on two axes, different periods
    const head = vrm.humanoid?.getRawBoneNode("head") as
      | Object3D
      | null
      | undefined;
    if (head) {
      // Lerp emotion head tilt toward target
      const tiltLerpSpeed = 3.0; // per second
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

      const idleRotX =
        Math.sin(t * 0.7) * 0.01 +
        Math.sin(t * 0.3) * 0.005 +
        this.emotionHeadTilt.x;
      const idleRotY =
        Math.sin(t * 0.5) * 0.015 +
        Math.cos(t * 0.2) * 0.008 +
        this.emotionHeadTilt.y;
      const idleRotZ = Math.sin(t * 0.4) * 0.005 + this.emotionHeadTilt.z;

      // Add gesture offset additively
      const gestureOffset = this.gesturePlayer.getOffset("head");
      const idleQuat = new Quaternion().setFromEuler(
        new Euler(idleRotX, idleRotY, idleRotZ),
      );
      idleQuat.multiply(gestureOffset);
      head.quaternion.copy(idleQuat);
    }

    // Gentle body sway — spine bone, very slow and subtle
    const spine = vrm.humanoid?.getRawBoneNode("spine") as
      | Object3D
      | null
      | undefined;
    if (spine) {
      const idleRotX = Math.sin(t * 0.25) * 0.005;
      const idleRotZ = Math.sin(t * 0.3) * 0.008;
      const gestureOffset = this.gesturePlayer.getOffset("spine");
      const idleQuat = new Quaternion().setFromEuler(
        new Euler(idleRotX, 0, idleRotZ),
      );
      idleQuat.multiply(gestureOffset);
      spine.quaternion.copy(idleQuat);
    }

    // Gesture-only bones (no idle component): arms, hands
    for (const boneName of [
      "rightUpperArm",
      "rightLowerArm",
      "rightHand",
      "leftUpperArm",
      "leftLowerArm",
      "leftHand",
    ] as const) {
      if (this.gesturePlayer.isPlaying) {
        const offset = this.gesturePlayer.getOffset(boneName);
        // Only apply if the gesture actually affects this bone (not identity).
        if (offset.x !== 0 || offset.y !== 0 || offset.z !== 0 || offset.w !== 1) {
          const boneNode = vrm.humanoid?.getRawBoneNode(boneName as string) as
            | Object3D
            | null
            | undefined;
          if (boneNode) {
            // Compose on top of the rest pose rotation already applied.
            boneNode.quaternion.multiply(offset);
          }
        }
      }
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
        this.blinkingUntil = this.elapsed + 0.12;
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
    analyser.getFloatTimeDomainData(this.audioTimeData);
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
    this.vrm = loadedVrm;
    this.scene.add(loadedVrm.scene);
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

  /** Clear all active expressions back to neutral, cancel any running gesture. */
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
  }

  /** Get the list of available expression/emotion names (for the lab UI). */
  getAvailableExpressions(): string[] {
    return Object.keys(EMOTION_MAP);
  }

  /** Get the list of available gesture names (for the lab UI). */
  getAvailableGestures(): string[] {
    return Object.keys(GESTURE_LIBRARY);
  }

  // -------------------------------------------------------------------------
  // Gesture system
  // -------------------------------------------------------------------------

  /**
   * Play a named gesture (wave, nod, shakeHead, tiltHead, bow).
   * Returns a Promise that resolves when the animation finishes.
   */
  playGesture(name: string): Promise<void> {
    const def = GESTURE_LIBRARY[name];
    if (!def) {
      return Promise.reject(new Error(`Unknown gesture: ${name}`));
    }
    return this.gesturePlayer.play(def);
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
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
  }
}
