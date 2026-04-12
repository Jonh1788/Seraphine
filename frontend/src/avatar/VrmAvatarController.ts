import {
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
  VectorKeyframeTrack,
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
import { GesturePlayer, GESTURE_LIBRARY } from "./gestures";

type EmotionLabel = "neutral" | "happy" | "sad" | "angry" | "thinking" | string;

const FALLBACK_EXPRESSIONS = [
  "happy", "angry", "sad", "relaxed", "surprised", "neutral", "blink",
  "aa", "ih", "ou", "ee", "oh",
];

/** Map Mixamo bone names to VRM humanoid bone names for retargeting. */
const MIXAMO_TO_VRM: Record<string, string> = {
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
};

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

  // Camera presets — smooth transition via lerp in the RAF loop
  private cameraTarget = { px: 0, py: 1.45, pz: 0.9, lx: 0, ly: 1.35, lz: 0, fov: 30 };
  private cameraCurrent = { ...this.cameraTarget };
  static readonly CAMERA_PRESETS: Record<string, typeof VrmAvatarController.prototype.cameraTarget> = {
    bust:     { px: 0, py: 1.45, pz: 0.9,  lx: 0, ly: 1.35, lz: 0, fov: 30 },
    face:     { px: 0, py: 1.55, pz: 0.45, lx: 0, ly: 1.52, lz: 0, fov: 24 },
    fullBody: { px: 0, py: 1.0,  pz: 2.5,  lx: 0, ly: 0.9,  lz: 0, fov: 30 },
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
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
      this.updateCamera(delta);
      this.updateIdle(delta);
      this.updateLipsync();
      this.vrm?.update(delta);
      // Gesture bone offsets MUST apply AFTER vrm.update() because
      // update() syncs normalized→raw for bones set via
      // setNormalizedPose (arms in applyRestPose). Writing to raw
      // bones BEFORE update would be overwritten.
      this.applyGestureOffsets();
      // External animation mixer runs last — it writes directly to
      // raw bone transforms and must not be overwritten by idle/rest.
      this.mixer?.update(delta);
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

      // Gesture arm/hand bones are applied in applyGestureOffsets()
      // AFTER vrm.update() so setNormalizedPose doesn't overwrite them.
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

    return this.retargetClip(clips[0], vrm);
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

      // Create a new track with the corrected name.
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
      } else if (
        property === "position" &&
        track instanceof VectorKeyframeTrack
      ) {
        // Scale position tracks — Mixamo uses cm, VRM uses meters
        // (most Mixamo exports are ~100x larger).
        const scaledValues = new Float32Array(track.values.length);
        for (let i = 0; i < track.values.length; i++) {
          scaledValues[i] = track.values[i] * 0.01;
        }
        retargetedTracks.push(
          new VectorKeyframeTrack(
            newTrackName,
            Array.from(track.times),
            Array.from(scaledValues),
          ),
        );
      } else {
        // Generic fallback (scale, etc.)
        retargetedTracks.push(track.clone());
        retargetedTracks[retargetedTracks.length - 1].name = newTrackName;
      }
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
   * Apply gesture bone offsets AFTER vrm.update() so they aren't
   * overwritten by the normalized→raw sync. Handles arm and hand
   * bones that the rest pose controls via setNormalizedPose().
   * Head/chest/spine gestures blend inside updateIdle() since those
   * bones aren't managed by setNormalizedPose.
   */
  private applyGestureOffsets(): void {
    const vrm = this.vrm;
    if (!vrm || !this.gesturePlayer.isPlaying) return;
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
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
  }
}
