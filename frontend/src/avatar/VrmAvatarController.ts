import {
  AmbientLight,
  Clock,
  DirectionalLight,
  Euler,
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
    // Breathing
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

  /** Pull the VRM out of its shipped T-pose into a natural standing
   *  rest pose by rotating the upper arms down at the sides. Called
   *  once after loadAvatar(). The values target ~68° outward rotation
   *  around the bone's local Z axis, which for most VRM rigs maps to
   *  "drop the arm toward the hip". Adjust if your model ships with a
   *  different axis convention — the Euler is applied in local space.
   */
  private applyIdlePose(): void {
    const vrm = this.vrm;
    const humanoid = vrm?.humanoid;
    if (!humanoid) return;

    const setBoneEuler = (name: string, e: Euler): void => {
      const node = humanoid.getRawBoneNode(name) as Object3D | null | undefined;
      if (!node) return;
      const q = new Quaternion().setFromEuler(e);
      node.quaternion.copy(q);
    };

    // ~68 degrees outward on each upper arm, plus a tiny forward lean
    // on the forearm so the arms don't clip through the torso.
    setBoneEuler("leftUpperArm", new Euler(0, 0, 1.2));
    setBoneEuler("rightUpperArm", new Euler(0, 0, -1.2));
    setBoneEuler("leftLowerArm", new Euler(0, -0.15, 0));
    setBoneEuler("rightLowerArm", new Euler(0, 0.15, 0));
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
    this.applyIdlePose();
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
