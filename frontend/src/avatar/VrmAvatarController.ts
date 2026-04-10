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

type EmotionLabel = "neutral" | "happy" | "sad" | "angry" | "thinking" | string;

const KNOWN_PRESETS = ["neutral", "happy", "sad", "angry"] as const;

export class VrmAvatarController implements AvatarAdapter {
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly clock: Clock;
  private vrm: VRM | null = null;
  private rafId: number | null = null;
  private disposed = false;
  private currentEmotion: string | null = null;
  private elapsed = 0;
  private nextBlinkAt: number;
  private blinkingUntil = 0;
  // Lipsync: optional external AnalyserNode owned by PCMPlayback.
  // When set, the RAF loop samples it, computes RMS, EMA-smooths,
  // and drives the VRM's aa/ih/ou viseme blendshapes.
  private audioAnalyser: AnalyserNode | null = null;
  private audioTimeData: Float32Array | null = null;
  private smoothedRms = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new Scene();

    const width = canvas.width || 400;
    const height = canvas.height || 600;
    this.camera = new PerspectiveCamera(30, width / height, 0.1, 20);
    this.camera.position.set(0, 1.4, 2);
    this.camera.lookAt(0, 1.3, 0);

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
      this.updateIdle();
      this.updateLipsync();
      this.vrm?.update(delta);
      this.renderer.render(this.scene, this.camera);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private updateIdle(): void {
    const vrm = this.vrm;
    if (!vrm) return;
    // Re-apply the rest pose every frame. vrm.update(delta) (called
    // after this method in the loop) syncs normalized humanoid bones
    // → raw skeleton; if we only wrote once at load time the
    // normalized tree would snap back to its bind pose. The VRM
    // humanoid API expects rotations as per-bone quaternions in
    // NORMALIZED space.
    this.applyRestPose();
    // Breathing — chest bone directly (raw, outside the humanoid
    // normalisation so setNormalizedPose doesn't clobber it).
    const chest = vrm.humanoid?.getRawBoneNode("chest") as Object3D | null | undefined;
    if (chest) {
      chest.rotation.x = Math.sin((this.elapsed * 2 * Math.PI) / 4) * 0.02;
    }
    // Blink
    const em = vrm.expressionManager;
    if (em) {
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

    if (!this.audioTimeData || this.audioTimeData.length !== analyser.fftSize) {
      this.audioTimeData = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.audioTimeData);
    let sumSq = 0;
    for (let i = 0; i < this.audioTimeData.length; i += 1) {
      const v = this.audioTimeData[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.audioTimeData.length);
    // EMA smoothing (alpha 0.35 — responsive but not jittery)
    this.smoothedRms = 0.35 * rms + 0.65 * this.smoothedRms;
    const w = envelopeToVisemes(this.smoothedRms);
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
   *  Axis convention, assuming standard VRM T-pose bind:
   *   - leftUpperArm local +X points OUT to the character's left
   *   - rotating around local Z with NEGATIVE angle brings +X toward
   *     -Y (arm down). Positive Z would lift it up.
   *   - rightUpperArm is the mirror: POSITIVE Z brings it down.
   *
   *  ~78° gets the arms hanging at the sides on most VRoid-style
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
      leftUpperArm: { rotation: q(new Euler(0, 0, -UPPER_ARM)) },
      rightUpperArm: { rotation: q(new Euler(0, 0, UPPER_ARM)) },
      leftLowerArm: { rotation: q(new Euler(0, -LOWER_ARM, 0)) },
      rightLowerArm: { rotation: q(new Euler(0, LOWER_ARM, 0)) },
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

  setEmotion(label: EmotionLabel): void {
    const em = this.vrm?.expressionManager;
    if (!em) return;
    // reset previous active emotion
    if (this.currentEmotion) {
      em.setValue(this.currentEmotion, 0);
    }
    let target = "neutral";
    let value = 1;
    if ((KNOWN_PRESETS as readonly string[]).includes(label)) {
      target = label;
    } else if (label === "thinking") {
      target = "sad";
      value = 0.25;
    } else {
      target = "neutral";
    }
    em.setValue(target, value);
    this.currentEmotion = target;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
  }
}
