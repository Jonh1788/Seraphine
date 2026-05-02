import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SkeletonHelper,
  SphereGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import {
  GESTURE_LIBRARY,
  type GestureDefinition,
  type GestureLayer,
  type IKTarget,
  defaultTangents,
} from '../avatar/gestures';
import { API_BASE } from '../api';
import { UndoStack, type Command } from './undoStack';
import { solveHeadLookAt, solveArmIK, worldQuatToLocal, ikWeightAt } from './ikSolver';
import { importBVH } from './bvhImport';
import { migrateGesture } from './gestureMigrations';
import {
  FlaskIcon,
  PlayIcon,
  PauseIcon,
  PlusIcon,
  TrashIcon,
  RefreshIcon,
  XIcon,
} from '../icons/Icons';

import {
  RAD2DEG,
  DEG2RAD,
  PICKABLE_BONES,
  BONE_INDENT,
  type KfDeg,
  defToDegs,
  degsToGesture,
  generateTsCode,
  interpolateBoneAtTime,
  resolveSelectionAfterSort,
  mirrorDeg,
} from './labUtils';
import { AnimationTimeline } from './AnimationTimeline';
import { FCurveEditor } from './FCurveEditor';
import { IKPanel } from './IKPanel';
import { CheatSheet } from './CheatSheet';
import { createOnionLines } from './onionSkin';
import { useLabHotkeys } from './hooks/useLabHotkeys';
import { useIKProxies } from './hooks/useIKProxies';

// --- Main AnimationLab component -------------------------------------------

interface Props {
  controller: VrmAvatarController | null;
  onClose: () => void;
}

export function AnimationLab({ controller, onClose }: Props): JSX.Element {
  // --- Gesture state ---
  const [gestureName, setGestureName] = useState('wave');
  const [duration, setDuration] = useState(1.5);
  const [keyframes, setKeyframes] = useState<KfDeg[]>([]);
  const [selectedBone, setSelectedBone] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [primaryIdx, setPrimaryIdx] = useState<number | null>(null);
  const [scrubTime, setScrubTime] = useState(0);
  const [savedGestures, setSavedGestures] = useState<Record<string, any>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<'rotate' | 'translate' | 'scale'>('rotate');
  const [playing, setPlaying] = useState(false);
  const [onionSkinOn, setOnionSkinOn] = useState(false);
  const [skeletonOn, setSkeletonOn] = useState(true);
  const [fcurveOpen, setFcurveOpen] = useState(true);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [layer, setLayer] = useState<GestureLayer>('full');
  const [ikTargets, setIkTargets] = useState<IKTarget[]>([]);
  const [selectedIkId, setSelectedIkId] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<
    | { x: number; y: number; bone: string; dx: number; dy: number; dz: number }
    | null
  >(null);

  // View state for timeline zoom/pan.
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1.5);

  useEffect(() => {
    setViewStart(0);
    setViewEnd(duration);
  }, [duration, gestureName]);

  useEffect(() => {
    if (scrubTime > duration) setScrubTime(duration);
  }, [duration, scrubTime]);

  const tickStep = useMemo(() => {
    const span = viewEnd - viewStart;
    if (span > 4) return 1.0;
    if (span > 2) return 0.5;
    if (span > 1) return 0.25;
    if (span > 0.5) return 0.1;
    return 0.05;
  }, [viewStart, viewEnd]);

  // --- Undo stack ---
  const undoStackRef = useRef(new UndoStack(100));
  const [, forceUndoRender] = useState(0);
  useEffect(() => {
    return undoStackRef.current.subscribe(() => forceUndoRender(n => n + 1));
  }, []);

  // --- Refs for 3D objects ---
  const previewRef = useRef<HTMLDivElement>(null);
  const avatarOrigRef = useRef<HTMLElement | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const pickerMeshes = useRef<Map<string, Mesh>>(new Map());
  const ikProxyMeshes = useRef<Map<string, Mesh>>(new Map());
  const skelHelperRef = useRef<SkeletonHelper | null>(null);
  const onionHelpersRef = useRef<LineSegments[]>([]);
  const raycaster = useRef(new Raycaster());
  const pointer = useRef(new Vector2());
  const rafRef = useRef(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>();

  const flash = useCallback((msg: string) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(msg);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1500);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setPrimaryIdx(null);
  }, []);

  // --- Load saved gestures ---
  useEffect(() => {
    fetch(`${API_BASE}/lab/gestures`)
      .then(r => r.json())
      .then(data => setSavedGestures(data ?? {}))
      .catch(() => {});
  }, []);

  const libraryNames = useMemo(() => Object.keys(GESTURE_LIBRARY), []);
  const discoNames = useMemo(
    () => Object.keys(savedGestures).filter(n => !GESTURE_LIBRARY[n]),
    [savedGestures],
  );

  const loadGesture = useCallback((name: string) => {
    let def: GestureDefinition | null = null;
    if (savedGestures[name]) {
      def = migrateGesture(savedGestures[name]);
    }
    if (!def && GESTURE_LIBRARY[name]) {
      def = migrateGesture(JSON.parse(JSON.stringify(GESTURE_LIBRARY[name])));
    }
    if (!def) def = { name, duration: 1.0, keyframes: [] };
    setGestureName(name);
    setDuration(def.duration);
    setKeyframes(defToDegs(def));
    setLayer(def.layer ?? 'full');
    setIkTargets(def.ikTargets ? [...def.ikTargets] : []);
    setSelectedIkId(null);
    clearSelection();
    setScrubTime(0);
    setDirty(false);
    undoStackRef.current.clear();
  }, [savedGestures, clearSelection]);

  useEffect(() => { loadGesture(gestureName); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Reparent canvas ---
  useEffect(() => {
    const avatarRoot = document.getElementById('seraphine-avatar-root');
    const preview = previewRef.current;
    if (!avatarRoot || !preview) return;
    avatarOrigRef.current = avatarRoot.parentElement;
    preview.appendChild(avatarRoot);
    const canvas = avatarRoot.querySelector('canvas');
    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    }
    return () => {
      if (avatarOrigRef.current && avatarRoot.parentElement === preview) {
        avatarOrigRef.current.appendChild(avatarRoot);
        if (canvas) { canvas.style.width = ''; canvas.style.height = ''; }
      }
    };
  }, []);

  // --- Enter/exit pose mode + setup 3D helpers ---
  useEffect(() => {
    if (!controller) return;
    const vrm = controller.getVrm();
    if (!vrm) return;
    const scene = controller.getScene();
    const camera = controller.getCamera();
    const renderer = controller.getRenderer();
    const canvas = renderer.domElement;

    controller.enterPoseMode();
    controller.resetAllBonesToRest();

    const skelHelper = new SkeletonHelper(vrm.scene);
    (skelHelper.material as any).color.setHex(0xa78bfa);
    (skelHelper.material as any).opacity = 0.45;
    (skelHelper.material as any).transparent = true;
    (skelHelper.material as any).depthTest = false;
    scene.add(skelHelper);
    skelHelperRef.current = skelHelper;

    const pickers = new Map<string, Mesh>();
    const sphereGeo = new SphereGeometry(0.015, 8, 8);
    for (const boneName of PICKABLE_BONES) {
      const boneNode = vrm.humanoid?.getRawBoneNode(boneName as any) as Object3D | null | undefined;
      if (!boneNode) continue;
      const mat = new MeshBasicMaterial({
        color: 0xa78bfa,
        transparent: true,
        opacity: 0.6,
        depthTest: false,
      });
      const mesh = new Mesh(sphereGeo, mat);
      mesh.renderOrder = 999;
      mesh.userData.boneName = boneName;
      boneNode.add(mesh);
      pickers.set(boneName, mesh);
    }
    pickerMeshes.current = pickers;

    const orbit = new OrbitControls(camera, canvas);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    orbit.target.set(0, 1.0, 0);
    orbit.mouseButtons = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
    orbit.update();
    orbitRef.current = orbit;

    const tc = new TransformControls(camera, canvas);
    tc.setMode('rotate');
    tc.setSize(0.6);
    const onDraggingChanged = (e: any): void => {
      orbit.enabled = !e.value;
    };
    tc.addEventListener('dragging-changed', onDraggingChanged);
    const tcHelper = tc.getHelper();
    scene.add(tcHelper);
    transformRef.current = tc;

    return () => {
      controller.exitPoseMode();
      scene.remove(skelHelper);
      skelHelper.dispose();
      for (const [, mesh] of pickers) {
        mesh.parent?.remove(mesh);
        (mesh.material as MeshBasicMaterial).dispose();
      }
      // sphereGeo is shared across all picker meshes — dispose AFTER they
      // are all removed so we never free a geometry still in use.
      sphereGeo.dispose();
      try { tc.removeEventListener('dragging-changed', onDraggingChanged); } catch { /* noop */ }
      try { tc.detach(); } catch { /* noop */ }
      scene.remove(tcHelper);
      // TransformControls (r169) builds its gizmo out of internal meshes
      // whose geometries/materials are NOT released by tc.dispose(). Walk
      // the helper subtree and dispose them explicitly to avoid GPU leaks.
      tcHelper.traverse((obj) => {
        const o = obj as { geometry?: { dispose?: () => void }; material?: unknown };
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) {
          for (const mm of m) (mm as { dispose?: () => void } | null)?.dispose?.();
        } else if (m) {
          (m as { dispose?: () => void }).dispose?.();
        }
      });
      try { tc.dispose(); } catch { /* r169 dispose can trip on internal state */ }
      orbit.dispose();
      for (const h of onionHelpersRef.current) {
        scene.remove(h);
        h.geometry.dispose();
        (h.material as LineBasicMaterial).dispose();
      }
      onionHelpersRef.current = [];
      pickerMeshes.current.clear();
      skelHelperRef.current = null;
      orbitRef.current = null;
      transformRef.current = null;
    };
  }, [controller]);

  // Skeleton visibility toggle
  useEffect(() => {
    if (skelHelperRef.current) skelHelperRef.current.visible = skeletonOn;
  }, [skeletonOn]);

  // --- IK proxy meshes (delegated to hook) ---
  const handleUpdateIK = useCallback((id: string, patch: Partial<IKTarget>) => {
    setIkTargets(prev => prev.map(t => t.id === id ? { ...t, ...patch, target: patch.target ? { ...t.target, ...patch.target } : t.target } : t));
    markDirty();
  }, []);
  const handleUpdateIKRef = useRef(handleUpdateIK);
  handleUpdateIKRef.current = handleUpdateIK;

  useIKProxies({
    controller, ikTargets, selectedIkId,
    ikProxyMeshes, transformRef, handleUpdateIKRef,
  });

  // --- Update gizmo mode ---
  useEffect(() => {
    transformRef.current?.setMode(gizmoMode);
  }, [gizmoMode]);

  // --- Bone selection highlight ---
  useEffect(() => {
    for (const [name, mesh] of pickerMeshes.current) {
      const mat = mesh.material as MeshBasicMaterial;
      if (name === selectedBone) {
        mat.color.setHex(0xffffff);
        mat.opacity = 1.0;
      } else {
        mat.color.setHex(0xa78bfa);
        mat.opacity = 0.6;
      }
    }
    const tc = transformRef.current;
    if (!tc || !controller) return;
    const vrm = controller.getVrm();
    if (!vrm) return;
    if (selectedIkId) return;
    if (selectedBone) {
      const boneNode = vrm.humanoid?.getRawBoneNode(selectedBone as any) as Object3D | null | undefined;
      if (boneNode) tc.attach(boneNode);
    } else {
      tc.detach();
    }
  }, [selectedBone, controller, selectedIkId]);

  // --- Inspector delta state ---
  const [inspectorDelta, setInspectorDelta] = useState({ x: 0, y: 0, z: 0 });
  useEffect(() => {
    const tc = transformRef.current;
    if (!tc || !controller) return;
    const onChange = () => {
      if (!selectedBone) return;
      const delta = controller.getBoneDelta(selectedBone);
      setInspectorDelta({
        x: +(delta.x * RAD2DEG).toFixed(1),
        y: +(delta.y * RAD2DEG).toFixed(1),
        z: +(delta.z * RAD2DEG).toFixed(1),
      });
    };
    tc.addEventListener('change', onChange);
    if (selectedBone) onChange();
    return () => { tc.removeEventListener('change', onChange); };
  }, [selectedBone, controller]);

  // --- Picking (pointerdown on canvas) ---
  useEffect(() => {
    if (!controller) return;
    const renderer = controller.getRenderer();
    const camera = controller.getCamera();
    const canvas = renderer.domElement;
    let downPos = { x: 0, y: 0 };

    const onDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
    };

    const onClick = (e: MouseEvent) => {
      const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      if (dist > 4) return;

      const rect = canvas.getBoundingClientRect();
      pointer.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.current.setFromCamera(pointer.current, camera);

      const boneMeshes = Array.from(pickerMeshes.current.values());
      const ikMeshes = Array.from(ikProxyMeshes.current.values());
      const meshArr = [...boneMeshes, ...ikMeshes];
      const hits = raycaster.current.intersectObjects(meshArr, false);
      if (hits.length > 0) {
        const hit = hits[0].object;
        const ikId = hit.userData.ikTargetId as string | undefined;
        const bone = hit.userData.boneName as string | undefined;
        if (ikId) {
          setSelectedIkId(ikId);
          setSelectedBone(null);
        } else if (bone) {
          setSelectedBone(bone);
          setSelectedIkId(null);
        }
      } else {
        setSelectedBone(null);
        setSelectedIkId(null);
      }
    };

    let lastHover = 0;
    const onHover = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastHover < 40) return;
      lastHover = now;

      const rect = canvas.getBoundingClientRect();
      pointer.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.current.setFromCamera(pointer.current, camera);
      const meshArr = Array.from(pickerMeshes.current.values());
      const hits = raycaster.current.intersectObjects(meshArr, false);
      if (hits.length > 0 && controller) {
        const bone = hits[0].object.userData.boneName as string;
        const delta = controller.getBoneDelta(bone);
        setHoverInfo({
          x: e.clientX,
          y: e.clientY,
          bone,
          dx: +(delta.x * RAD2DEG).toFixed(1),
          dy: +(delta.y * RAD2DEG).toFixed(1),
          dz: +(delta.z * RAD2DEG).toFixed(1),
        });
      } else {
        setHoverInfo(null);
      }
    };

    const onLeave = () => setHoverInfo(null);

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointermove', onHover);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onHover);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [controller]);

  // --- Scrub: apply pose at scrubTime (FK + IK preview) ---
  useEffect(() => {
    if (!controller) return;
    const byBone = new Map<string, KfDeg[]>();
    for (const kf of keyframes) {
      let arr = byBone.get(kf.bone);
      if (!arr) { arr = []; byBone.set(kf.bone, arr); }
      arr.push(kf);
    }
    for (const [bone, boneKfs] of byBone) {
      const sorted = boneKfs.sort((a, b) => a.time - b.time);
      const delta = interpolateBoneAtTime(sorted, scrubTime);
      controller.setBoneDelta(bone, delta);
    }

    const vrm = controller.getVrm();
    if (vrm && ikTargets.length > 0) {
      for (const target of ikTargets) {
        const w = ikWeightAt(target, scrubTime);
        if (w <= 0) continue;
        const worldTarget = new Vector3(target.target.x, target.target.y, target.target.z);
        if (target.space === 'rig') vrm.scene.localToWorld(worldTarget);

        if (target.chain === 'head') {
          const head = vrm.humanoid?.getRawBoneNode('head' as any) as any;
          if (!head) continue;
          head.updateWorldMatrix(true, false);
          const desiredWorld = solveHeadLookAt(head, worldTarget);
          const desiredLocal = worldQuatToLocal(desiredWorld, head);
          head.quaternion.slerp(desiredLocal, Math.min(1, w));
        } else if (target.chain === 'leftArm' || target.chain === 'rightArm') {
          const side = target.chain === 'leftArm' ? 'left' : 'right';
          const shoulder = vrm.humanoid?.getRawBoneNode(`${side}UpperArm` as any) as any;
          const elbow = vrm.humanoid?.getRawBoneNode(`${side}LowerArm` as any) as any;
          const hand = vrm.humanoid?.getRawBoneNode(`${side}Hand` as any) as any;
          if (!shoulder || !elbow || !hand) continue;
          shoulder.updateWorldMatrix(true, false);
          elbow.updateWorldMatrix(false, false);
          hand.updateWorldMatrix(false, false);
          const pole = new Vector3();
          shoulder.getWorldPosition(pole);
          const shoulderWorldX = pole.x - (vrm.scene.position?.x ?? 0);
          const isRight = side === 'right';
          const outwardSign = isRight
            ? (shoulderWorldX < 0 ? -1 : 1)
            : (shoulderWorldX > 0 ? 1 : -1);
          pole.x += outwardSign * 0.35;
          pole.y -= 1.0;
          try {
            const res = solveArmIK(shoulder, elbow, hand, worldTarget, pole);
            shoulder.quaternion.slerp(res.upperArmLocal, w);
            elbow.quaternion.slerp(res.lowerArmLocal, w);
          } catch { /* NaN from solver -- skip */ }
        }
      }
    }

    if (selectedBone) {
      const delta = controller.getBoneDelta(selectedBone);
      setInspectorDelta({
        x: +(delta.x * RAD2DEG).toFixed(1),
        y: +(delta.y * RAD2DEG).toFixed(1),
        z: +(delta.z * RAD2DEG).toFixed(1),
      });
    }
  }, [scrubTime, keyframes, controller, selectedBone, ikTargets]);

  // --- Onion skin ---
  useEffect(() => {
    if (!controller || !onionSkinOn) return;
    const vrm = controller.getVrm();
    const scene = controller.getScene();
    if (!vrm || !scene) return;
    for (const h of onionHelpersRef.current) {
      scene.remove(h);
      h.geometry.dispose();
      (h.material as LineBasicMaterial).dispose();
    }
    onionHelpersRef.current = [];
    const before = createOnionLines(vrm, keyframes, scrubTime, controller, 'before');
    const after = createOnionLines(vrm, keyframes, scrubTime, controller, 'after');
    if (before) { scene.add(before); onionHelpersRef.current.push(before); }
    if (after) { scene.add(after); onionHelpersRef.current.push(after); }
    return () => {
      for (const h of onionHelpersRef.current) {
        scene.remove(h);
        h.geometry.dispose();
        (h.material as LineBasicMaterial).dispose();
      }
      onionHelpersRef.current = [];
    };
  }, [controller, onionSkinOn, scrubTime, keyframes]);

  // --- Keyframe mutations with undo ---

  const markDirty = useCallback(() => setDirty(true), []);

  const recordKfChange = useCallback((label: string, next: KfDeg[]) => {
    const prev = keyframes;
    const cmd: Command = {
      label,
      apply: () => { setKeyframes(next); },
      revert: () => { setKeyframes(prev); },
    };
    undoStackRef.current.record(cmd);
    markDirty();
  }, [keyframes, markDirty]);

  const handleInsertKeyframe = useCallback(() => {
    if (!controller) return;
    const newKfs: KfDeg[] = [];
    for (const boneName of PICKABLE_BONES) {
      const delta = controller.getBoneDelta(boneName);
      const dx = +(delta.x * RAD2DEG).toFixed(1);
      const dy = +(delta.y * RAD2DEG).toFixed(1);
      const dz = +(delta.z * RAD2DEG).toFixed(1);
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1 && Math.abs(dz) < 0.1) continue;
      newKfs.push({ bone: boneName, x: dx, y: dy, z: dz, time: scrubTime });
    }
    if (newKfs.length === 0) {
      flash('Nenhum bone modificado');
      return;
    }
    const newBones = new Set(newKfs.map(k => k.bone));
    const filtered = keyframes.filter(kf => !(newBones.has(kf.bone) && Math.abs(kf.time - scrubTime) < 0.005));
    const merged = [...filtered, ...newKfs].sort((a, b) => a.time - b.time);
    recordKfChange(`Inserir ${newKfs.length} kf`, merged);
    flash(`${newKfs.length} keyframe(s) inseridos`);
  }, [controller, scrubTime, flash, keyframes, recordKfChange]);

  const preDragKfsRef = useRef<KfDeg[] | null>(null);

  // Refs to avoid stale closures in keyboard handler
  const insertKfRef = useRef(handleInsertKeyframe);
  insertKfRef.current = handleInsertKeyframe;

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const keyframesRef = useRef(keyframes);
  keyframesRef.current = keyframes;
  const scrubTimeRef = useRef(scrubTime);
  scrubTimeRef.current = scrubTime;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const handlePlayPause = useCallback(() => {
    if (!controller) return;
    if (playingRef.current) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setPlaying(false);
      return;
    }
    setPlaying(true);
    const startScrub = scrubTimeRef.current;
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = startScrub + (now - start) / 1000;
      if (elapsed >= durationRef.current) {
        setScrubTime(0);
        setPlaying(false);
        // Clear the ref so the cleanup effect's cancelAnimationFrame is a
        // no-op AND a fresh Play press starts from a clean state instead
        // of cancelling whatever the next render scheduled. (rafRef is
        // typed as `number` with 0 as the "no active frame" sentinel.)
        rafRef.current = 0;
        return;
      }
      setScrubTime(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [controller]);

  const stepScrub = useCallback((direction: -1 | 1, toNextKf: boolean) => {
    const kfs = keyframesRef.current;
    const cur = scrubTimeRef.current;
    const dur = durationRef.current;
    if (toNextKf) {
      const times = [...new Set(kfs.map(kf => kf.time))].sort((a, b) => a - b);
      if (direction > 0) {
        const nxt = times.find(t => t > cur + 0.001);
        if (nxt !== undefined) setScrubTime(nxt);
      } else {
        for (let i = times.length - 1; i >= 0; i--) {
          if (times[i] < cur - 0.001) { setScrubTime(times[i]); break; }
        }
      }
    } else {
      const step = 1 / 60;
      setScrubTime(Math.max(0, Math.min(dur, cur + direction * step)));
    }
  }, []);

  const handleSave = useCallback(async () => {
    const def = degsToGesture(gestureName, duration, keyframes, layer, ikTargets);
    try {
      const resp = await fetch(`${API_BASE}/lab/gestures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: gestureName, definition: def }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setSavedGestures(prev => ({
        ...prev,
        [gestureName]: {
          name: def.name, duration: def.duration, keyframes: def.keyframes,
          layer: def.layer, version: def.version, ikTargets: def.ikTargets,
        },
      }));
      controller?.registerGesture?.(gestureName, def);
      setDirty(false);
      flash('Salvo');
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [gestureName, duration, keyframes, layer, ikTargets, flash, controller]);

  const saveRef = useRef<(() => void) | null>(handleSave);
  saveRef.current = handleSave;

  // --- Keyboard hotkeys (delegated to hook) ---
  useLabHotkeys({
    selectionRef, keyframesRef, scrubTimeRef, durationRef, flashRef,
    undoStackRef, insertKfRef, saveRef,
    cheatOpen,
    setCheatOpen: (fn) => setCheatOpen(fn),
    setSelection, setPrimaryIdx, setKeyframes,
    recordKfChange, onClose, handlePlayPause, stepScrub,
  });

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleDeleteSelection = useCallback(() => {
    if (selection.size === 0) return;
    const toDelete = new Set(selection);
    const next = keyframes.filter((_, i) => !toDelete.has(i));
    recordKfChange(`Apagar ${toDelete.size} kf`, next);
    clearSelection();
  }, [selection, keyframes, recordKfChange, clearSelection]);

  const handleResetPose = useCallback(() => {
    if (!controller) return;
    controller.resetAllBonesToRest();
    if (selectedBone) {
      setInspectorDelta({ x: 0, y: 0, z: 0 });
    }
  }, [controller, selectedBone]);

  const handleCopyTs = useCallback(async () => {
    const code = generateTsCode(gestureName, duration, keyframes);
    try {
      await navigator.clipboard.writeText(code);
      flash('Copiado');
    } catch { flash('Falha ao copiar'); }
  }, [gestureName, duration, keyframes, flash]);

  const handleNewGesture = useCallback(() => {
    const name = prompt('Nome da nova gesture:');
    if (!name?.trim()) return;
    setGestureName(name.trim());
    setDuration(1.0);
    setKeyframes([]);
    setScrubTime(0);
    clearSelection();
    undoStackRef.current.clear();
    setDirty(false);
  }, [clearSelection]);

  const bvhFileRef = useRef<HTMLInputElement>(null);
  const handleBvhFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const def = await importBVH(file, { name: file.name.replace(/\.bvh$/i, ''), sampleHz: 15 });
      setGestureName(def.name);
      setDuration(def.duration);
      setKeyframes(defToDegs(def));
      setLayer(def.layer ?? 'full');
      setIkTargets([]);
      setSelectedIkId(null);
      clearSelection();
      setScrubTime(0);
      undoStackRef.current.clear();
      markDirty();
      flash(`BVH importado: ${def.keyframes.length} kf, ${def.duration.toFixed(1)}s`);
    } catch (err) {
      flash(`Falha no import: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      if (bvhFileRef.current) bvhFileRef.current.value = '';
    }
  }, [clearSelection, flash, markDirty]);

  const handleSelectGesture = useCallback((name: string) => {
    if (dirty) {
      if (!window.confirm('Gesture tem alteracoes nao salvas. Descartar?')) return;
    }
    loadGesture(name);
  }, [loadGesture, dirty]);

  const handleMultiKfTimeChange = useCallback((indices: number[], dt: number, origTimes: Map<number, number>) => {
    setKeyframes(prev => {
      if (!preDragKfsRef.current) {
        preDragKfsRef.current = [...prev];
      }
      const next = [...prev];
      for (const idx of indices) {
        const orig = origTimes.get(idx);
        if (orig === undefined) continue;
        next[idx] = { ...next[idx], time: Math.round(Math.max(0, Math.min(duration, orig + dt)) * 100) / 100 };
      }
      const oldRefs = [...next];
      next.sort((a, b) => a.time - b.time);
      const resolved = resolveSelectionAfterSort(oldRefs, next, selection, primaryIdx);
      setTimeout(() => {
        setSelection(resolved.selection);
        setPrimaryIdx(resolved.primaryIdx);
      }, 0);
      return next;
    });
  }, [duration, selection, primaryIdx]);

  const handleMultiKfTimeCommit = useCallback((_indices: number[], _origTimes: Map<number, number>) => {
    const preKfs = preDragKfsRef.current;
    preDragKfsRef.current = null;
    if (!preKfs) return;
    const postKfs = [...keyframesRef.current];
    if (preKfs.length === postKfs.length && preKfs.every((kf, i) => Math.abs(kf.time - postKfs[i].time) < 1e-4)) return;
    const cmd: Command = {
      label: `Mover kf`,
      apply: () => setKeyframes(postKfs),
      revert: () => setKeyframes(preKfs),
    };
    undoStackRef.current.record(cmd);
    markDirty();
  }, [markDirty]);

  const handleTimelineSelectKf = useCallback((idx: number, modifier: boolean) => {
    if (modifier) {
      setSelection(prev => {
        const next = new Set(prev);
        if (next.has(idx)) {
          next.delete(idx);
          setPrimaryIdx(p => next.size === 0 ? null : (p === idx ? (next.values().next().value ?? null) : p));
        } else {
          next.add(idx);
          setPrimaryIdx(idx);
        }
        return next;
      });
    } else {
      setSelection(new Set([idx]));
      setPrimaryIdx(idx);
    }
  }, []);

  const handleRubberBandSelect = useCallback((indices: number[], additive: boolean) => {
    if (additive) {
      setSelection(prev => {
        const next = new Set(prev);
        for (const i of indices) next.add(i);
        return next;
      });
      if (indices.length > 0) setPrimaryIdx(indices[0]);
    } else {
      setSelection(new Set(indices));
      setPrimaryIdx(indices.length > 0 ? indices[0] : null);
    }
  }, []);

  const handleAddTangents = useCallback(() => {
    const next = keyframes.map(kf => ({
      ...kf,
      tangents: kf.tangents ?? defaultTangents(),
    }));
    recordKfChange('Adicionar tangentes', next);
    setFcurveOpen(true);
    flash('Tangentes adicionadas');
  }, [keyframes, recordKfChange, flash]);

  const handleAddIK = useCallback((chain: IKTarget['chain']) => {
    if (!controller) return;
    const vrm = controller.getVrm();
    if (!vrm) return;
    const anchorBone = chain === 'head'
      ? 'head'
      : chain === 'leftArm' ? 'leftHand' : 'rightHand';
    const node = vrm.humanoid?.getRawBoneNode(anchorBone as any) as any;
    if (!node) return;
    node.updateWorldMatrix(true, false);
    const wp = new Vector3();
    node.getWorldPosition(wp);
    if (chain === 'head') wp.z += 0.6;
    const target: IKTarget = {
      id: `ik-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`,
      chain,
      time: scrubTime,
      fadeIn: 0.2,
      hold: Math.max(0.2, duration - scrubTime - 0.4),
      fadeOut: 0.2,
      blend: chain === 'head' ? 0.8 : 0.9,
      target: { x: wp.x, y: wp.y, z: wp.z },
      space: 'world',
    };
    const prev = ikTargets;
    const next = [...prev, target];
    const cmd: Command = {
      label: `IK ${chain} target`,
      apply: () => setIkTargets(next),
      revert: () => setIkTargets(prev),
    };
    undoStackRef.current.record(cmd);
    setSelectedIkId(target.id);
    markDirty();
    flash(`IK ${chain} target adicionado`);
  }, [controller, scrubTime, duration, ikTargets, markDirty, flash]);

  const handleDeleteIK = useCallback((id: string) => {
    const prev = ikTargets;
    const next = prev.filter(t => t.id !== id);
    const cmd: Command = {
      label: 'Remover IK target',
      apply: () => setIkTargets(next),
      revert: () => setIkTargets(prev),
    };
    undoStackRef.current.record(cmd);
    if (selectedIkId === id) setSelectedIkId(null);
    markDirty();
  }, [ikTargets, selectedIkId, markDirty]);

  const handleMirror = useCallback(() => {
    const sourceIdx = selection.size > 0
      ? Array.from(selection)
      : keyframes.map((_, i) => i);
    const sourceKfs = sourceIdx.map(i => keyframes[i]);
    const mirrored: KfDeg[] = [];
    for (const kf of sourceKfs) {
      const m = mirrorDeg(kf);
      if (m) mirrored.push(m);
    }
    if (mirrored.length === 0) {
      flash('Nenhum keyframe lateral para espelhar');
      return;
    }
    const overlapKey = (k: KfDeg) => `${k.bone}@${k.time.toFixed(3)}`;
    const mirroredKeys = new Set(mirrored.map(overlapKey));
    const kept = keyframes.filter(k => !mirroredKeys.has(overlapKey(k)));
    const merged = [...kept, ...mirrored].sort((a, b) => a.time - b.time);
    recordKfChange(`Mirror ${mirrored.length} kf`, merged);
    flash(`${mirrored.length} espelhado(s)`);
  }, [keyframes, selection, recordKfChange, flash]);

  const handleUpdateTangent = useCallback((kfIdx: number, axis: 'x' | 'y' | 'z', handle: 'in' | 'out', dy: number) => {
    setKeyframes(prev => {
      const next = [...prev];
      const kf = { ...next[kfIdx] };
      if (!kf.tangents) kf.tangents = defaultTangents();
      const t = { ...kf.tangents[axis] };
      if (handle === 'in') t.inY = dy;
      else t.outY = dy;
      kf.tangents = { ...kf.tangents, [axis]: t };
      next[kfIdx] = kf;
      return next;
    });
    markDirty();
  }, [markDirty]);

  const handleBoneListClick = useCallback((bone: string) => {
    setSelectedBone(bone);
  }, []);

  const inspectorDragStart = useRef<{ axis: 'x' | 'y' | 'z'; bone: string; start: number } | null>(null);
  const handleInspectorAxisChange = useCallback((axis: 'x' | 'y' | 'z', valDeg: number) => {
    if (!selectedBone || !controller) return;
    if (inspectorDragStart.current?.bone !== selectedBone || inspectorDragStart.current?.axis !== axis) {
      const cur = controller.getBoneDelta(selectedBone);
      inspectorDragStart.current = { axis, bone: selectedBone, start: cur[axis] * RAD2DEG };
    }
    const delta = controller.getBoneDelta(selectedBone);
    delta[axis] = valDeg * DEG2RAD;
    controller.setBoneDelta(selectedBone, delta);
    setInspectorDelta(prev => ({ ...prev, [axis]: valDeg }));
  }, [selectedBone, controller]);

  // --- Zoom / pan handlers ---
  const handleZoom = useCallback((delta: number, centerT: number) => {
    const factor = Math.exp(delta * 0.0015);
    const newSpan = Math.max(0.1, Math.min(duration, (viewEnd - viewStart) / factor));
    let start = centerT - (centerT - viewStart) * (newSpan / (viewEnd - viewStart));
    let end = start + newSpan;
    if (start < 0) { end -= start; start = 0; }
    if (end > duration) { start -= end - duration; end = duration; }
    setViewStart(Math.max(0, start));
    setViewEnd(Math.min(duration, end));
  }, [viewStart, viewEnd, duration]);

  const handlePan = useCallback((dt: number) => {
    const span = viewEnd - viewStart;
    let start = viewStart + dt;
    let end = viewEnd + dt;
    if (start < 0) { start = 0; end = span; }
    if (end > duration) { end = duration; start = duration - span; }
    setViewStart(start);
    setViewEnd(end);
  }, [viewStart, viewEnd, duration]);

  const handleZoomReset = useCallback(() => {
    setViewStart(0);
    setViewEnd(duration);
  }, [duration]);

  const zoomPct = Math.round((duration / Math.max(viewEnd - viewStart, 0.001)) * 100);

  const canUndo = undoStackRef.current.canUndo();
  const canRedo = undoStackRef.current.canRedo();

  const singleSelectedKf = selection.size === 1 && primaryIdx !== null ? keyframes[primaryIdx] : null;

  const fcurveBone = useMemo(() => {
    if (singleSelectedKf) return singleSelectedKf.bone;
    if (selectedBone && keyframes.some(k => k.bone === selectedBone && k.tangents)) return selectedBone;
    const first = keyframes.find(k => k.tangents);
    return first?.bone ?? null;
  }, [singleSelectedKf, selectedBone, keyframes]);
  const anyTangents = useMemo(() => keyframes.some(k => k.tangents), [keyframes]);

  const statusCls = playing
    ? 'anim-lab__status anim-lab__status--playing'
    : dirty
      ? 'anim-lab__status anim-lab__status--dirty'
      : 'anim-lab__status anim-lab__status--saved';
  const statusLabel = playing ? 'playing' : dirty ? 'unsaved' : 'saved';

  const orderedBones = PICKABLE_BONES;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content anim-lab" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="anim-lab__header">
          <div className="anim-lab__header-left">
            <h2 className="anim-lab__title">
              <span className="anim-lab__title-icon"><FlaskIcon size={14} /></span>
              Animation Lab
            </h2>
            <span className="anim-lab__divider" />
            <select className="anim-lab__gesture-select"
              value={gestureName}
              onChange={e => handleSelectGesture(e.target.value)}>
              <optgroup label="Library">
                {libraryNames.map(n => <option key={n} value={n}>{n}</option>)}
              </optgroup>
              {discoNames.length > 0 && (
                <optgroup label="Salvas">
                  {discoNames.map(n => <option key={n} value={n}>{n}</option>)}
                </optgroup>
              )}
            </select>
            <button type="button" className="anim-lab__btn anim-lab__btn--sm" onClick={handleNewGesture}>
              <PlusIcon size={12} /> Nova
            </button>
            <button type="button" className="anim-lab__btn anim-lab__btn--sm"
              onClick={() => bvhFileRef.current?.click()}
              title="Importar .bvh (Mixamo / motion capture)">
              BVH
            </button>
            <input ref={bvhFileRef} type="file" accept=".bvh"
              style={{ display: 'none' }} onChange={handleBvhFile} />
            <span className="anim-lab__divider" />
            <div className="anim-lab__dur-group">
              <span className="anim-lab__dur-label">Dur</span>
              <input type="range" min="0.3" max="5.0" step="0.1"
                value={duration}
                onChange={e => { setDuration(parseFloat(e.target.value)); markDirty(); }}
                className="anim-lab__dur-slider" />
              <span className="anim-lab__dur-val">{duration.toFixed(1)}s</span>
            </div>
            <div className="anim-lab__dur-group" title="Layer: mascara de bones afetados (Phase 2)">
              <span className="anim-lab__dur-label">Layer</span>
              <select value={layer}
                onChange={e => { setLayer(e.target.value as GestureLayer); markDirty(); }}
                className="anim-lab__gesture-select"
                style={{ minWidth: 72, padding: '2px 22px 2px 8px', fontSize: 10 }}>
                <option value="full">full</option>
                <option value="upper">upper</option>
                <option value="lower">lower</option>
              </select>
            </div>
            <span className={statusCls}>{statusLabel}</span>
          </div>

          <div className="anim-lab__header-right">
            <button type="button"
              className="anim-lab__btn anim-lab__btn--sm"
              disabled={!canUndo}
              onClick={() => { const c = undoStackRef.current.undo(); if (c) flash(`Undo: ${c.label}`); }}
              title="Undo (Ctrl+Z)">
              ↶
            </button>
            <button type="button"
              className="anim-lab__btn anim-lab__btn--sm"
              disabled={!canRedo}
              onClick={() => { const c = undoStackRef.current.redo(); if (c) flash(`Redo: ${c.label}`); }}
              title="Redo (Ctrl+Shift+Z)">
              ↷
            </button>
            <span className="anim-lab__divider" />
            <button type="button"
              className={`anim-lab__btn${playing ? ' anim-lab__btn--active' : ''}`}
              onClick={handlePlayPause} title="Play / Pause (Space)">
              {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button"
              className={`anim-lab__btn${onionSkinOn ? ' anim-lab__btn--active' : ''}`}
              onClick={() => setOnionSkinOn(v => !v)}
              title="Onion skin: silhuetas do kf anterior e proximo">
              Onion
            </button>
            <button type="button"
              className={`anim-lab__btn${skeletonOn ? ' anim-lab__btn--active' : ''}`}
              onClick={() => setSkeletonOn(v => !v)}
              title="Skeleton overlay">
              Skel
            </button>
            <span className="anim-lab__divider" />
            <button type="button" className="anim-lab__btn" onClick={() => void handleCopyTs()} title="Copiar TS">
              TS
            </button>
            <button type="button" className="anim-lab__btn anim-lab__btn--primary" onClick={() => void handleSave()} title="Salvar (Ctrl+S)">
              Salvar
            </button>
            <button type="button"
              className={`anim-lab__btn anim-lab__btn--icon${cheatOpen ? ' anim-lab__btn--active' : ''}`}
              onClick={() => setCheatOpen(v => !v)}
              title="Atalhos (?)">
              ?
            </button>
            <button type="button"
              className="anim-lab__close"
              aria-label="Fechar"
              onClick={onClose}>
              <XIcon size={14} />
            </button>
          </div>
        </div>

        {/* Body: 3-col layout */}
        <div className="anim-lab__body">

          {/* Left panel: bone outliner + library */}
          <aside className="anim-lab__panel anim-lab__panel--left">
            <div className="anim-lab__panel-header">
              Bones
              <span className="anim-lab__panel-header-count">{orderedBones.length}</span>
            </div>
            <div className="anim-lab__panel-body">
              <div className="anim-lab__outliner">
                {orderedBones.map(bone => {
                  const hasKf = keyframes.some(kf => kf.bone === bone);
                  const sel = selectedBone === bone;
                  const indent = (BONE_INDENT[bone] ?? 0) * 10;
                  return (
                    <button key={bone} type="button"
                      className={`anim-lab__outliner-item${sel ? ' anim-lab__outliner-item--sel' : ''}`}
                      onClick={() => handleBoneListClick(bone)}>
                      <span className="anim-lab__outliner-name">
                        <span className="anim-lab__outliner-indent" style={{ '--indent': `${indent}px` } as React.CSSProperties} />
                        <span className="anim-lab__outliner-branch">{indent > 0 ? '└' : ''}</span>
                        {bone}
                      </span>
                      {hasKf && <span className="anim-lab__outliner-dot" />}
                    </button>
                  );
                })}
              </div>

              <div className="anim-lab__library">
                <span className="anim-lab__library-group">Library</span>
                {libraryNames.map(n => (
                  <button key={n} type="button"
                    className={`anim-lab__library-item${n === gestureName ? ' anim-lab__library-item--active' : ''}`}
                    onClick={() => handleSelectGesture(n)}>
                    <span>{n}</span>
                    <span className="anim-lab__library-badge">lib</span>
                  </button>
                ))}
                {discoNames.length > 0 && (
                  <>
                    <span className="anim-lab__library-group" style={{ marginTop: 6 }}>Salvas</span>
                    {discoNames.map(n => (
                      <button key={n} type="button"
                        className={`anim-lab__library-item${n === gestureName ? ' anim-lab__library-item--active' : ''}`}
                        onClick={() => handleSelectGesture(n)}>
                        <span>{n}</span>
                        <span className="anim-lab__library-badge">disk</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          </aside>

          {/* Center: viewport */}
          <div className="anim-lab__viewport" ref={previewRef}>
            <div className="anim-lab__gizmo-bar">
              {(['rotate', 'translate', 'scale'] as const).map(mode => (
                <button key={mode} type="button"
                  className={`anim-lab__gizmo-btn${gizmoMode === mode ? ' anim-lab__gizmo-btn--active' : ''}`}
                  onClick={() => setGizmoMode(mode)}>
                  {mode === 'rotate' ? 'Rot' : mode === 'translate' ? 'Mov' : 'Esc'}
                </button>
              ))}
            </div>

            {hoverInfo && (
              <div className="anim-lab__bone-hover"
                style={{ left: hoverInfo.x + 12, top: hoverInfo.y - 40 }}>
                <span className="anim-lab__bone-hover-name">{hoverInfo.bone}</span>
                <span className="anim-lab__bone-hover-delta">
                  {hoverInfo.dx.toFixed(1)}° / {hoverInfo.dy.toFixed(1)}° / {hoverInfo.dz.toFixed(1)}°
                </span>
              </div>
            )}

            {cheatOpen && <CheatSheet onClose={() => setCheatOpen(false)} />}
          </div>

          {/* Right panel: inspector */}
          <aside className="anim-lab__panel anim-lab__panel--right">
            <div className="anim-lab__panel-header">
              Inspector
              {selection.size > 1 && (
                <span className="anim-lab__panel-header-count">{selection.size} kf</span>
              )}
            </div>
            <div className="anim-lab__panel-body">
              <div className="anim-lab__inspector">
                {(selectedBone === 'head' || selectedBone === 'leftHand' || selectedBone === 'rightHand' || ikTargets.length > 0) && (
                  <IKPanel
                    targets={ikTargets}
                    selectedId={selectedIkId}
                    duration={duration}
                    scrubTime={scrubTime}
                    onSelect={setSelectedIkId}
                    onAdd={handleAddIK}
                    onUpdate={handleUpdateIK}
                    onDelete={handleDeleteIK}
                    onJumpTo={t => setScrubTime(t)}
                  />
                )}
                {selection.size > 1 ? (
                  <div className="anim-lab__card">
                    <div className="anim-lab__card-head">
                      <span className="anim-lab__card-title">{selection.size} keyframes</span>
                      <span className="anim-lab__card-meta">selecionados</span>
                    </div>
                    <div className="anim-lab__card-actions">
                      <button type="button" className="anim-lab__btn anim-lab__btn--sm anim-lab__btn--danger"
                        onClick={handleDeleteSelection}>
                        <TrashIcon size={11} /> Apagar
                      </button>
                      <button type="button" className="anim-lab__btn anim-lab__btn--sm"
                        onClick={clearSelection}>
                        Limpar
                      </button>
                    </div>
                  </div>
                ) : !selectedBone ? (
                  <div className="anim-lab__inspector-empty">
                    Selecione um bone na cena 3D ou no outliner para editar rotacao.
                  </div>
                ) : (
                  <div className="anim-lab__card">
                    <div className="anim-lab__card-head">
                      <span className="anim-lab__card-title">{selectedBone}</span>
                      <span className="anim-lab__card-meta">delta</span>
                    </div>
                    {(['x', 'y', 'z'] as const).map(axis => (
                      <div key={axis} className="anim-lab__insp-row">
                        <span className={`anim-lab__insp-axis anim-lab__insp-axis--${axis}`}>
                          {axis.toUpperCase()}
                        </span>
                        <input type="range" min="-180" max="180" step="0.5"
                          value={inspectorDelta[axis]}
                          onChange={e => handleInspectorAxisChange(axis, parseFloat(e.target.value))}
                          className={`anim-lab__insp-slider anim-lab__insp-slider--${axis}`} />
                        <span className="anim-lab__insp-val">
                          {inspectorDelta[axis].toFixed(1)}°
                        </span>
                      </div>
                    ))}
                    <div className="anim-lab__card-actions">
                      <button type="button" className="anim-lab__btn anim-lab__btn--sm"
                        onClick={handleResetPose}>
                        <RefreshIcon size={11} /> Reset pose
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

        {/* Timeline */}
        <div className="anim-lab__timeline-area">
          <div className="anim-lab__timeline-actions">
            <button type="button" className="anim-lab__btn anim-lab__btn--sm" onClick={handleInsertKeyframe}>
              <PlusIcon size={11} /> Keyframe (I)
            </button>
            <button type="button" className="anim-lab__btn anim-lab__btn--sm anim-lab__btn--danger"
              disabled={selection.size === 0} onClick={handleDeleteSelection}>
              <TrashIcon size={11} />
              {selection.size > 1 ? `Apagar (${selection.size})` : 'Apagar'}
            </button>
            <span className="anim-lab__divider" />
            <button type="button" className="anim-lab__btn anim-lab__btn--sm"
              onClick={handleMirror}
              title="Mirror L<->R (usa selecao, ou todos se nada selecionado)">
              Mirror
            </button>
            <span className="anim-lab__divider" />
            {!anyTangents ? (
              <button type="button" className="anim-lab__btn anim-lab__btn--sm" onClick={handleAddTangents}>
                + F-Curves
              </button>
            ) : (
              <button type="button"
                className={`anim-lab__btn anim-lab__btn--sm${fcurveOpen ? ' anim-lab__btn--active' : ''}`}
                onClick={() => setFcurveOpen(v => !v)}>
                {fcurveOpen ? 'Fechar curves' : 'Abrir curves'}
              </button>
            )}

            <div className="anim-lab__timeline-spacer" />

            <div className="anim-lab__timeline-zoom" title="Zoom (Ctrl+wheel na timeline)">
              <button type="button" onClick={() => handleZoom(-120, (viewStart + viewEnd) / 2)}>-</button>
              <span className="anim-lab__timeline-zoom-val">{zoomPct}%</span>
              <button type="button" onClick={() => handleZoom(120, (viewStart + viewEnd) / 2)}>+</button>
              <button type="button" onClick={handleZoomReset} title="Reset zoom">x</button>
            </div>
          </div>
          <AnimationTimeline
            duration={duration}
            keyframes={keyframes}
            selection={selection}
            primaryIdx={primaryIdx}
            scrubTime={scrubTime}
            viewStart={viewStart}
            viewEnd={viewEnd}
            tickStep={tickStep}
            snapEnabled
            onSelectKf={handleTimelineSelectKf}
            onClearSelection={clearSelection}
            onMultiKfTimeChange={handleMultiKfTimeChange}
            onMultiKfTimeCommit={handleMultiKfTimeCommit}
            onScrubChange={setScrubTime}
            onRubberBandSelect={handleRubberBandSelect}
            onZoom={handleZoom}
            onPan={handlePan}
          />
        </div>

        {/* F-Curve editor */}
        {fcurveOpen && anyTangents && fcurveBone && (
          <div className="anim-lab__fcurve-area">
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Curves -- <strong style={{ color: 'var(--accent-hi)' }}>{fcurveBone}</strong>
            </div>
            <FCurveEditor
              bone={fcurveBone}
              keyframes={keyframes}
              duration={duration}
              onUpdateTangent={handleUpdateTangent}
            />
          </div>
        )}

        {feedback && <div className="anim-lab__feedback">{feedback}</div>}
      </div>
    </div>
  );
}
