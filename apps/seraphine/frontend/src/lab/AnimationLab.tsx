import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BufferGeometry,
  Float32BufferAttribute,
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
  type GestureKeyframe,
  defaultTangents,
} from '../avatar/gestures';
import { API_BASE } from '../api';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const PICKABLE_BONES = [
  'head', 'neck', 'chest', 'spine', 'hips',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg',
  'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot',
];

// --- Types ----------------------------------------------------------------

interface KfDeg {
  bone: string;
  x: number; y: number; z: number;
  time: number;
  tangents?: GestureKeyframe['tangents'];
}

// Module-scope clipboard for internal copy/cut/paste
let clipboardRef: KfDeg[] = [];

function defToDegs(def: GestureDefinition): KfDeg[] {
  return def.keyframes.map(kf => ({
    bone: kf.bone,
    x: +(kf.rotation.x * RAD2DEG).toFixed(1),
    y: +(kf.rotation.y * RAD2DEG).toFixed(1),
    z: +(kf.rotation.z * RAD2DEG).toFixed(1),
    time: kf.time,
    tangents: kf.tangents,
  }));
}

function degsToGesture(name: string, duration: number, kfs: KfDeg[]): GestureDefinition {
  return {
    name,
    duration,
    keyframes: kfs.map(k => ({
      bone: k.bone,
      rotation: { x: k.x * DEG2RAD, y: k.y * DEG2RAD, z: k.z * DEG2RAD },
      time: k.time,
      tangents: k.tangents,
    })),
  };
}

function generateTsCode(name: string, duration: number, kfs: KfDeg[]): string {
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

function interpolateBoneAtTime(
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
function resolveSelectionAfterSort(
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

// --- Timeline sub-component -----------------------------------------------

const TL_TRACK_H = 26;
const TL_RULER_H = 22;
const TL_LABEL_W = 90;
const TL_DIAMOND = 8;

function diamondPts(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

interface TimelineProps {
  duration: number;
  keyframes: KfDeg[];
  selection: Set<number>;
  primaryIdx: number | null;
  scrubTime: number;
  onSelectKf: (idx: number, modifier: boolean) => void;
  onClearSelection: () => void;
  onMultiKfTimeChange: (indices: number[], dt: number, origTimes: Map<number, number>) => void;
  onScrubChange: (t: number) => void;
  onRubberBandSelect: (indices: number[], additive: boolean) => void;
}

function AnimationTimeline({
  duration, keyframes, selection, primaryIdx, scrubTime,
  onSelectKf, onClearSelection, onMultiKfTimeChange, onScrubChange,
  onRubberBandSelect,
}: TimelineProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragItem, setDragItem] = useState<
    | { type: 'kf'; idx: number; origTimes: Map<number, number> }
    | { type: 'playhead' }
    | { type: 'rubberband'; startX: number; startY: number; additive: boolean }
    | null
  >(null);
  const [rubberRect, setRubberRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [containerW, setContainerW] = useState(600);

  const tracks = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const kf of keyframes) {
      if (!seen.has(kf.bone)) { seen.add(kf.bone); out.push(kf.bone); }
    }
    return out;
  }, [keyframes]);

  const numTracks = Math.max(tracks.length, 1);
  const svgH = TL_RULER_H + numTracks * TL_TRACK_H;
  const tlW = containerW - TL_LABEL_W;

  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setContainerW(node.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
  }, []);

  const tToX = (t: number) => TL_LABEL_W + (t / duration) * tlW;
  const xToT = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - TL_LABEL_W;
    return Math.round(Math.max(0, Math.min(duration, (x / tlW) * duration)) * 100) / 100;
  };
  const clientToSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const trackY = (bone: string) => {
    const idx = tracks.indexOf(bone);
    return TL_RULER_H + idx * TL_TRACK_H + TL_TRACK_H / 2;
  };

  const tickStep = duration > 1 ? 0.5 : 0.25;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += tickStep)
    ticks.push(Math.round(t * 100) / 100);

  // Diamond pointerdown: select + start drag
  const onPtrDown = useCallback((e: React.PointerEvent, idx: number) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const modifier = e.shiftKey || e.metaKey || e.ctrlKey;

    if (modifier) {
      // Toggle in selection
      onSelectKf(idx, true);
      // Build origTimes for drag with the updated selection
      const nextSel = new Set(selection);
      if (nextSel.has(idx)) nextSel.delete(idx); else nextSel.add(idx);
      const origTimes = new Map<number, number>();
      for (const i of nextSel) origTimes.set(i, keyframes[i].time);
      setDragItem({ type: 'kf', idx, origTimes });
    } else {
      // If not already selected, single-select it
      if (!selection.has(idx)) {
        onSelectKf(idx, false);
        const origTimes = new Map<number, number>();
        origTimes.set(idx, keyframes[idx].time);
        setDragItem({ type: 'kf', idx, origTimes });
      } else {
        // Already selected: start drag of whole selection
        const origTimes = new Map<number, number>();
        for (const i of selection) origTimes.set(i, keyframes[i].time);
        setDragItem({ type: 'kf', idx, origTimes });
      }
    }
  }, [onSelectKf, selection, keyframes]);

  const onPlayheadDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragItem({ type: 'playhead' });
  }, []);

  const onPtrMove = useCallback((e: React.PointerEvent) => {
    if (!dragItem) return;
    if (dragItem.type === 'kf') {
      const newT = xToT(e.clientX);
      const grabbedOrigT = dragItem.origTimes.get(dragItem.idx);
      if (grabbedOrigT === undefined) return;
      let dt = newT - grabbedOrigT;
      // Clamp dt so no selected kf goes below 0 or above duration
      for (const [, origT] of dragItem.origTimes) {
        const projected = origT + dt;
        if (projected < 0) dt = Math.max(dt, -origT);
        if (projected > duration) dt = Math.min(dt, duration - origT);
      }
      onMultiKfTimeChange(Array.from(dragItem.origTimes.keys()), dt, dragItem.origTimes);
    } else if (dragItem.type === 'playhead') {
      onScrubChange(xToT(e.clientX));
    } else if (dragItem.type === 'rubberband') {
      const cur = clientToSvg(e.clientX, e.clientY);
      const x = Math.min(dragItem.startX, cur.x);
      const y = Math.min(dragItem.startY, cur.y);
      const w = Math.abs(cur.x - dragItem.startX);
      const h = Math.abs(cur.y - dragItem.startY);
      setRubberRect({ x, y, w, h });
    }
  }, [dragItem, duration, onMultiKfTimeChange, onScrubChange]);

  const onPtrUp = useCallback(() => {
    if (dragItem?.type === 'rubberband' && rubberRect) {
      // Hit-test: which keyframe diamonds fall inside the rect
      const rx = rubberRect.x;
      const ry = rubberRect.y;
      const rw = rubberRect.w;
      const rh = rubberRect.h;
      const hits: number[] = [];
      for (let i = 0; i < keyframes.length; i++) {
        const cx = tToX(keyframes[i].time);
        const cy = trackY(keyframes[i].bone);
        if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) {
          hits.push(i);
        }
      }
      onRubberBandSelect(hits, dragItem.additive);
    }
    setDragItem(null);
    setRubberRect(null);
  }, [dragItem, rubberRect, keyframes, onRubberBandSelect]);

  const onBgPointerDown = useCallback((e: React.PointerEvent) => {
    // Shift+drag on background => rubber-band select
    if (e.shiftKey) {
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      const pos = clientToSvg(e.clientX, e.clientY);
      setDragItem({ type: 'rubberband', startX: pos.x, startY: pos.y, additive: e.shiftKey });
      return;
    }
    // Plain click on background: move playhead + clear selection
    const t = xToT(e.clientX);
    onScrubChange(t);
    onClearSelection();
  }, [onScrubChange, onClearSelection]);

  // Determine cursor for SVG
  const svgCursor = dragItem?.type === 'rubberband'
    ? 'crosshair'
    : dragItem?.type === 'kf'
      ? 'grabbing'
      : undefined;

  return (
    <div className="anim-timeline" ref={measuredRef}>
      <svg
        ref={svgRef}
        width="100%"
        height={svgH}
        className="anim-timeline__svg"
        style={svgCursor ? { cursor: svgCursor } : undefined}
        onPointerMove={onPtrMove}
        onPointerUp={onPtrUp}
        onPointerDown={onBgPointerDown}
      >
        {/* ruler */}
        <line x1={TL_LABEL_W} y1={TL_RULER_H} x2={TL_LABEL_W + tlW} y2={TL_RULER_H}
          stroke="var(--glass-border)" strokeWidth={1} />
        {ticks.map(t => (
          <g key={`t-${t}`}>
            <line x1={tToX(t)} y1={TL_RULER_H - 8} x2={tToX(t)} y2={TL_RULER_H}
              stroke="var(--glass-border)" strokeWidth={1} />
            <text x={tToX(t)} y={TL_RULER_H - 10} textAnchor="middle"
              fontSize={9} fill="var(--text-dim)" className="anim-timeline__label">
              {t.toFixed(1)}
            </text>
          </g>
        ))}

        {/* track baselines */}
        {tracks.map((bone, ti) => {
          const y = TL_RULER_H + ti * TL_TRACK_H + TL_TRACK_H / 2;
          return (
            <g key={`tr-${bone}`}>
              <line x1={TL_LABEL_W} y1={y} x2={TL_LABEL_W + tlW} y2={y}
                stroke="var(--glass-border)" strokeWidth={0.5} strokeDasharray="2,4" />
              <text x={TL_LABEL_W - 4} y={y + 3} textAnchor="end"
                fontSize={10} fill="var(--text-dim)" className="anim-timeline__label">
                {bone.length > 11 ? bone.slice(0, 11) : bone}
              </text>
            </g>
          );
        })}

        {/* keyframe diamonds */}
        {keyframes.map((kf, idx) => {
          const cx = tToX(kf.time);
          const cy = trackY(kf.bone);
          const sel = selection.has(idx);
          const isPrimary = idx === primaryIdx;
          return (
            <polygon key={idx} points={diamondPts(cx, cy, TL_DIAMOND / 2)}
              fill={sel ? 'var(--accent)' : 'var(--text)'}
              stroke={sel ? 'var(--accent-hi)' : 'none'} strokeWidth={sel ? 1.5 : 0}
              filter={isPrimary ? 'drop-shadow(0 0 2px #fff)' : undefined}
              style={{ cursor: dragItem?.type === 'kf' ? 'grabbing' : 'grab' }}
              onPointerDown={e => onPtrDown(e, idx)}>
              <title>{`${kf.bone} @ ${kf.time.toFixed(2)}s`}</title>
            </polygon>
          );
        })}

        {/* rubber-band rect */}
        {rubberRect && (
          <rect
            x={rubberRect.x} y={rubberRect.y}
            width={rubberRect.w} height={rubberRect.h}
            className="anim-timeline__rubberband"
          />
        )}

        {/* playhead */}
        <line x1={tToX(scrubTime)} y1={0} x2={tToX(scrubTime)} y2={svgH}
          stroke="var(--accent)" strokeWidth={1.5} pointerEvents="none" />
        {/* playhead grab handle */}
        <rect x={tToX(scrubTime) - 5} y={0} width={10} height={TL_RULER_H}
          fill="var(--accent)" rx={3} opacity={0.6}
          style={{ cursor: 'ew-resize' }}
          onPointerDown={onPlayheadDown} />
      </svg>
    </div>
  );
}

// --- F-Curve Editor sub-component (Phase 3) --------------------------------

interface FCurveProps {
  bone: string;
  keyframes: KfDeg[];
  duration: number;
  onUpdateTangent: (kfIdx: number, axis: 'x' | 'y' | 'z', handle: 'in' | 'out', dy: number) => void;
}

function FCurveEditor({ bone, keyframes, duration, onUpdateTangent }: FCurveProps) {
  const boneKfs = useMemo(() =>
    keyframes
      .map((kf, idx) => ({ ...kf, idx }))
      .filter(kf => kf.bone === bone)
      .sort((a, b) => a.time - b.time),
  [keyframes, bone]);

  if (boneKfs.length < 2) {
    return (
      <div className="anim-fcurve__empty">
        Necessarios 2+ keyframes deste bone para editar curvas
      </div>
    );
  }

  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  const axisColors = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };

  const W = 400;
  const H = 120;
  const PAD = 24;

  return (
    <div className="anim-fcurve">
      {axes.map(axis => {
        const vals = boneKfs.map(kf => kf[axis]);
        const minV = Math.min(...vals) - 10;
        const maxV = Math.max(...vals) + 10;
        const rangeV = maxV - minV || 1;
        const toSvgX = (t: number) => PAD + ((t / duration) * (W - 2 * PAD));
        const toSvgY = (v: number) => H - PAD - ((v - minV) / rangeV) * (H - 2 * PAD);

        // build path
        let path = '';
        for (let i = 0; i < boneKfs.length; i++) {
          const kf = boneKfs[i];
          const px = toSvgX(kf.time);
          const py = toSvgY(kf[axis]);
          if (i === 0) { path += `M${px},${py}`; continue; }
          const prev = boneKfs[i - 1];
          if (prev.tangents && kf.tangents) {
            const cpx1 = toSvgX(prev.time + (prev.tangents[axis].outX * duration));
            const cpy1 = toSvgY(prev[axis] + prev.tangents[axis].outY * RAD2DEG);
            const cpx2 = toSvgX(kf.time + (kf.tangents[axis].inX * duration));
            const cpy2 = toSvgY(kf[axis] + kf.tangents[axis].inY * RAD2DEG);
            path += ` C${cpx1},${cpy1} ${cpx2},${cpy2} ${px},${py}`;
          } else {
            path += ` L${px},${py}`;
          }
        }

        return (
          <div key={axis} className="anim-fcurve__axis">
            <span className="anim-fcurve__axis-label" style={{ color: axisColors[axis] }}>
              {axis.toUpperCase()}
            </span>
            <svg width={W} height={H} className="anim-fcurve__svg">
              {/* grid */}
              <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD}
                stroke="var(--glass-border)" strokeWidth={0.5} />
              <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD}
                stroke="var(--glass-border)" strokeWidth={0.5} />
              {/* curve */}
              <path d={path} fill="none" stroke={axisColors[axis]} strokeWidth={1.5} />
              {/* keyframe dots + tangent handles */}
              {boneKfs.map((kf, i) => {
                const px = toSvgX(kf.time);
                const py = toSvgY(kf[axis]);
                const tang = kf.tangents?.[axis];
                return (
                  <g key={i}>
                    <circle cx={px} cy={py} r={4} fill={axisColors[axis]} />
                    {tang && (
                      <>
                        {/* in handle */}
                        <line x1={px} y1={py}
                          x2={toSvgX(kf.time + tang.inX * duration)}
                          y2={toSvgY(kf[axis] + tang.inY * RAD2DEG)}
                          stroke={axisColors[axis]} strokeWidth={0.8} opacity={0.5} />
                        <circle
                          cx={toSvgX(kf.time + tang.inX * duration)}
                          cy={toSvgY(kf[axis] + tang.inY * RAD2DEG)}
                          r={3} fill="var(--bg-1)" stroke={axisColors[axis]} strokeWidth={1}
                          style={{ cursor: 'pointer' }}
                          onPointerDown={e => {
                            e.stopPropagation();
                            const startY = e.clientY;
                            const startVal = tang.inY;
                            const onMove = (me: PointerEvent) => {
                              const dy = (startY - me.clientY) * 0.01;
                              onUpdateTangent(kf.idx, axis, 'in', startVal + dy);
                            };
                            const onUp = () => {
                              window.removeEventListener('pointermove', onMove);
                              window.removeEventListener('pointerup', onUp);
                            };
                            window.addEventListener('pointermove', onMove);
                            window.addEventListener('pointerup', onUp);
                          }}
                        />
                        {/* out handle */}
                        <line x1={px} y1={py}
                          x2={toSvgX(kf.time + tang.outX * duration)}
                          y2={toSvgY(kf[axis] + tang.outY * RAD2DEG)}
                          stroke={axisColors[axis]} strokeWidth={0.8} opacity={0.5} />
                        <circle
                          cx={toSvgX(kf.time + tang.outX * duration)}
                          cy={toSvgY(kf[axis] + tang.outY * RAD2DEG)}
                          r={3} fill="var(--bg-1)" stroke={axisColors[axis]} strokeWidth={1}
                          style={{ cursor: 'pointer' }}
                          onPointerDown={e => {
                            e.stopPropagation();
                            const startY = e.clientY;
                            const startVal = tang.outY;
                            const onMove = (me: PointerEvent) => {
                              const dy = (startY - me.clientY) * 0.01;
                              onUpdateTangent(kf.idx, axis, 'out', startVal + dy);
                            };
                            const onUp = () => {
                              window.removeEventListener('pointermove', onMove);
                              window.removeEventListener('pointerup', onUp);
                            };
                            window.addEventListener('pointermove', onMove);
                            window.addEventListener('pointerup', onUp);
                          }}
                        />
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        );
      })}
    </div>
  );
}

// --- Onion skin (Phase 2) --------------------------------------------------

/** Bone parent-child pairs for drawing skeleton lines. */
const BONE_CONNECTIONS: [string, string][] = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'leftShoulder'], ['leftShoulder', 'leftUpperArm'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['chest', 'rightShoulder'], ['rightShoulder', 'rightUpperArm'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'],
  ['leftLowerLeg', 'leftFoot'],
  ['hips', 'rightUpperLeg'], ['rightUpperLeg', 'rightLowerLeg'],
  ['rightLowerLeg', 'rightFoot'],
];

/**
 * Create a frozen LineSegments skeleton at a target keyframe time.
 * We temporarily pose the bones, snapshot their world positions into
 * a static BufferGeometry, then restore the original pose.
 */
function createOnionLines(
  vrm: any,
  keyframes: KfDeg[],
  time: number,
  controller: VrmAvatarController,
  direction: 'before' | 'after',
): LineSegments | null {
  const allTimes = [...new Set(keyframes.map(kf => kf.time))].sort((a, b) => a - b);
  let targetTime: number | null = null;
  if (direction === 'before') {
    for (let i = allTimes.length - 1; i >= 0; i--) {
      if (allTimes[i] < time - 0.01) { targetTime = allTimes[i]; break; }
    }
  } else {
    for (const t of allTimes) {
      if (t > time + 0.01) { targetTime = t; break; }
    }
  }
  if (targetTime === null) return null;

  // Save current pose
  const savedDeltas = new Map<string, { x: number; y: number; z: number }>();
  for (const bone of PICKABLE_BONES) {
    savedDeltas.set(bone, controller.getBoneDelta(bone));
  }

  // Apply target time pose
  const byBone = new Map<string, KfDeg[]>();
  for (const kf of keyframes) {
    let arr = byBone.get(kf.bone);
    if (!arr) { arr = []; byBone.set(kf.bone, arr); }
    arr.push(kf);
  }
  for (const [bone, boneKfs] of byBone) {
    const sorted = [...boneKfs].sort((a, b) => a.time - b.time);
    const delta = interpolateBoneAtTime(sorted, targetTime);
    controller.setBoneDelta(bone, delta);
  }

  // Snapshot world positions
  vrm.scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const wp = new Vector3();
  for (const [parentName, childName] of BONE_CONNECTIONS) {
    const parentNode = vrm.humanoid?.getRawBoneNode(parentName as any) as Object3D | null | undefined;
    const childNode = vrm.humanoid?.getRawBoneNode(childName as any) as Object3D | null | undefined;
    if (!parentNode || !childNode) continue;
    parentNode.getWorldPosition(wp);
    positions.push(wp.x, wp.y, wp.z);
    childNode.getWorldPosition(wp);
    positions.push(wp.x, wp.y, wp.z);
  }

  // Restore original pose
  for (const [bone, delta] of savedDeltas) {
    controller.setBoneDelta(bone, delta);
  }

  if (positions.length === 0) return null;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const color = direction === 'before' ? 0x3b82f6 : 0xf97316;
  const mat = new LineBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false });
  const lines = new LineSegments(geom, mat);
  lines.renderOrder = 998;
  return lines;
}

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
  const [fcurveOpen, setFcurveOpen] = useState(false);

  // --- Refs for 3D objects ---
  const previewRef = useRef<HTMLDivElement>(null);
  const avatarOrigRef = useRef<HTMLElement | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const pickerMeshes = useRef<Map<string, Mesh>>(new Map());
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
      const raw = savedGestures[name];
      def = { name: raw.name, duration: raw.duration, keyframes: raw.keyframes };
    }
    if (!def && GESTURE_LIBRARY[name]) {
      def = JSON.parse(JSON.stringify(GESTURE_LIBRARY[name]));
    }
    if (!def) def = { name, duration: 1.0, keyframes: [] };
    setGestureName(name);
    setDuration(def.duration);
    setKeyframes(defToDegs(def));
    clearSelection();
    setScrubTime(0);
  }, [savedGestures, clearSelection]);

  // Load initial gesture
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

    // Skeleton helper
    const skelHelper = new SkeletonHelper(vrm.scene);
    (skelHelper.material as any).color.setHex(0xa78bfa);
    (skelHelper.material as any).opacity = 0.4;
    (skelHelper.material as any).transparent = true;
    (skelHelper.material as any).depthTest = false;
    scene.add(skelHelper);
    skelHelperRef.current = skelHelper;

    // Bone picker spheres
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

    // OrbitControls
    const orbit = new OrbitControls(camera, canvas);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    orbit.target.set(0, 1.0, 0);
    // Left drag rotates (Mac trackpad has no middle button). Pick handler
    // uses a 4px drag threshold to differentiate short click (= pick bone)
    // from drag (= orbit). Right button pans; wheel/pinch zooms.
    orbit.mouseButtons = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
    orbit.update();
    orbitRef.current = orbit;

    // TransformControls (three r169+: controls is EventDispatcher-based;
    // the visual helper is an Object3D retrieved via getHelper()).
    const tc = new TransformControls(camera, canvas);
    tc.setMode('rotate');
    tc.setSize(0.6);
    tc.addEventListener('dragging-changed', (e: any) => {
      orbit.enabled = !e.value;
    });
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
      try { tc.detach(); } catch { /* noop */ }
      scene.remove(tcHelper);
      try { tc.dispose(); } catch { /* r169 dispose can trip on internal state */ }
      orbit.dispose();
      // Clean onion skins
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
    // Attach/detach transform controls
    const tc = transformRef.current;
    if (!tc || !controller) return;
    const vrm = controller.getVrm();
    if (!vrm) return;
    if (selectedBone) {
      const boneNode = vrm.humanoid?.getRawBoneNode(selectedBone as any) as Object3D | null | undefined;
      if (boneNode) tc.attach(boneNode);
    } else {
      tc.detach();
    }
  }, [selectedBone, controller]);

  // --- TransformControls change listener => update inspector ---
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
    // Initial read
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
      // Skip if it was a drag (orbit/gizmo)
      const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      if (dist > 4) return;

      const rect = canvas.getBoundingClientRect();
      pointer.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.current.setFromCamera(pointer.current, camera);

      const meshArr = Array.from(pickerMeshes.current.values());
      const hits = raycaster.current.intersectObjects(meshArr, false);
      if (hits.length > 0) {
        const bone = hits[0].object.userData.boneName as string;
        setSelectedBone(bone);
      } else {
        setSelectedBone(null);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('click', onClick);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('click', onClick);
    };
  }, [controller]);

  // --- Scrub: apply pose at scrubTime ---
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
    // Refresh inspector
    if (selectedBone) {
      const delta = controller.getBoneDelta(selectedBone);
      setInspectorDelta({
        x: +(delta.x * RAD2DEG).toFixed(1),
        y: +(delta.y * RAD2DEG).toFixed(1),
        z: +(delta.z * RAD2DEG).toFixed(1),
      });
    }
  }, [scrubTime, keyframes, controller, selectedBone]);

  // --- Onion skin ---
  useEffect(() => {
    if (!controller || !onionSkinOn) return;
    const vrm = controller.getVrm();
    const scene = controller.getScene();
    if (!vrm || !scene) return;
    // Clear previous
    for (const h of onionHelpersRef.current) {
      scene.remove(h);
      h.geometry.dispose();
      (h.material as LineBasicMaterial).dispose();
    }
    onionHelpersRef.current = [];
    // Create before/after
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

  // --- Actions ---
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
    setKeyframes(prev => {
      // Remove existing keyframes at this time for these bones
      const newBones = new Set(newKfs.map(k => k.bone));
      const filtered = prev.filter(kf => !(newBones.has(kf.bone) && Math.abs(kf.time - scrubTime) < 0.005));
      const merged = [...filtered, ...newKfs].sort((a, b) => a.time - b.time);
      return merged;
    });
    flash(`${newKfs.length} keyframe(s) inseridos`);
  }, [controller, scrubTime, flash]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when focused on input elements
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        // If there's a selection, clear it; otherwise close the lab
        if (selectionRef.current.size > 0) {
          e.preventDefault();
          setSelection(new Set());
          setPrimaryIdx(null);
        } else {
          onClose();
        }
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        insertKfRef.current();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectionRef.current.size === 0) return;
        e.preventDefault();
        const toDelete = new Set(selectionRef.current);
        setKeyframes(prev => prev.filter((_, i) => !toDelete.has(i)));
        setSelection(new Set());
        setPrimaryIdx(null);
        return;
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const kfs = keyframesRef.current;
        const all = new Set<number>();
        for (let i = 0; i < kfs.length; i++) all.add(i);
        setSelection(all);
        setPrimaryIdx(kfs.length > 0 ? 0 : null);
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
        e.preventDefault();
        const sel = selectionRef.current;
        const kfs = keyframesRef.current;
        if (sel.size === 0) return;
        clipboardRef = Array.from(sel).map(i => ({ ...kfs[i] }));
        flashRef.current(`${sel.size} copiado(s)`);
        return;
      }
      if (mod && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        const sel = selectionRef.current;
        const kfs = keyframesRef.current;
        if (sel.size === 0) return;
        clipboardRef = Array.from(sel).map(i => ({ ...kfs[i] }));
        const toDelete = new Set(sel);
        setKeyframes(prev => prev.filter((_, i) => !toDelete.has(i)));
        setSelection(new Set());
        setPrimaryIdx(null);
        flashRef.current(`${sel.size} recortado(s)`);
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        if (clipboardRef.length === 0) return;
        const curScrub = scrubTimeRef.current;
        const curDuration = durationRef.current;
        // Find the minimum time in clipboard to use as anchor
        const minTime = Math.min(...clipboardRef.map(k => k.time));
        const cloned = clipboardRef.map(k => {
          const newTime = Math.min(curDuration, Math.max(0, curScrub + (k.time - minTime)));
          return { ...k, time: Math.round(newTime * 100) / 100 };
        });
        setKeyframes(prev => {
          const merged = [...prev, ...cloned].sort((a, b) => a.time - b.time);
          // Build selection for the newly-pasted items (by reference)
          const clonedSet = new Set<KfDeg>(cloned);
          const newSel = new Set<number>();
          let newPrimary: number | null = null;
          for (let i = 0; i < merged.length; i++) {
            if (clonedSet.has(merged[i])) {
              newSel.add(i);
              if (newPrimary === null) newPrimary = i;
            }
          }
          // Defer state updates via setTimeout to avoid batching issues
          // (setKeyframes is in progress, so we schedule selection update)
          setTimeout(() => {
            setSelection(newSel);
            setPrimaryIdx(newPrimary);
          }, 0);
          return merged;
        });
        flashRef.current(`${cloned.length} colado(s)`);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDeleteSelection = useCallback(() => {
    if (selection.size === 0) return;
    const toDelete = new Set(selection);
    setKeyframes(prev => prev.filter((_, i) => !toDelete.has(i)));
    clearSelection();
  }, [selection, clearSelection]);

  const handlePlay = useCallback(() => {
    if (!controller || playing) return;
    setPlaying(true);
    // Drive playback via scrub (pose mode stays on, scrub effect handles bones)
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = (now - start) / 1000;
      if (elapsed >= duration) {
        setScrubTime(0);
        setPlaying(false);
        return;
      }
      setScrubTime(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [controller, playing, duration]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleResetPose = useCallback(() => {
    if (!controller) return;
    controller.resetAllBonesToRest();
    if (selectedBone) {
      setInspectorDelta({ x: 0, y: 0, z: 0 });
    }
  }, [controller, selectedBone]);

  const handleSave = useCallback(async () => {
    const def = degsToGesture(gestureName, duration, keyframes);
    try {
      const resp = await fetch(`${API_BASE}/lab/gestures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: gestureName, definition: def }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setSavedGestures(prev => ({
        ...prev,
        [gestureName]: { name: def.name, duration: def.duration, keyframes: def.keyframes },
      }));
      // Register with the live controller so `playGesture(name)` can reach
      // it immediately — no reload needed.
      controller?.registerGesture?.(gestureName, def);
      flash('Salvo');
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [gestureName, duration, keyframes, flash, controller]);

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
  }, [clearSelection]);

  const handleSelectGesture = useCallback((name: string) => {
    loadGesture(name);
  }, [loadGesture]);

  // Multi-keyframe time change: apply dt to each selected kf using original times
  const handleMultiKfTimeChange = useCallback((indices: number[], dt: number, origTimes: Map<number, number>) => {
    setKeyframes(prev => {
      const next = [...prev];
      const touchedObjs: KfDeg[] = [];
      for (const idx of indices) {
        const orig = origTimes.get(idx);
        if (orig === undefined) continue;
        const newObj = { ...next[idx], time: Math.round(Math.max(0, Math.min(duration, orig + dt)) * 100) / 100 };
        next[idx] = newObj;
        touchedObjs.push(newObj);
      }
      const oldRefs = [...next]; // before sort for identity resolution
      next.sort((a, b) => a.time - b.time);
      // Re-resolve selection by object identity (references preserved from above)
      const resolved = resolveSelectionAfterSort(oldRefs, next, selection, primaryIdx);
      // Schedule selection update after this render
      setTimeout(() => {
        setSelection(resolved.selection);
        setPrimaryIdx(resolved.primaryIdx);
      }, 0);
      return next;
    });
  }, [duration, selection, primaryIdx]);

  // Timeline: select kf (single or modifier-toggle)
  const handleTimelineSelectKf = useCallback((idx: number, modifier: boolean) => {
    if (modifier) {
      setSelection(prev => {
        const next = new Set(prev);
        if (next.has(idx)) {
          next.delete(idx);
          // If we removed the primary, keep primary as-is unless selection is empty
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

  // Rubber-band select result
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
    setKeyframes(prev => prev.map(kf => ({
      ...kf,
      tangents: kf.tangents ?? defaultTangents(),
    })));
    setFcurveOpen(true);
    flash('Tangentes adicionadas');
  }, [flash]);

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
  }, []);

  // --- Bone click from sidebar list ---
  const handleBoneListClick = useCallback((bone: string) => {
    setSelectedBone(bone);
  }, []);

  // --- Inspector manual delta editing ---
  const handleInspectorAxisChange = useCallback((axis: 'x' | 'y' | 'z', valDeg: number) => {
    if (!selectedBone || !controller) return;
    const delta = controller.getBoneDelta(selectedBone);
    delta[axis] = valDeg * DEG2RAD;
    controller.setBoneDelta(selectedBone, delta);
    setInspectorDelta(prev => ({ ...prev, [axis]: valDeg }));
  }, [selectedBone, controller]);

  // Derived: single-selected kf for inspector/F-curve
  const singleSelectedKf = selection.size === 1 && primaryIdx !== null ? keyframes[primaryIdx] : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content anim-lab" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="anim-lab__header">
          <div className="anim-lab__header-left">
            <h2 className="anim-lab__title">Animation Lab</h2>
            <select className="gesture-editor__select"
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
            <button type="button" className="anim-lab__btn" onClick={handleNewGesture}>Nova</button>
            <span className="gesture-editor__label">
              Dur: {duration.toFixed(1)}s
            </span>
            <input type="range" min="0.3" max="5.0" step="0.1"
              value={duration}
              onChange={e => setDuration(parseFloat(e.target.value))}
              className="anim-lab__dur-slider" />
          </div>
          <div className="anim-lab__header-right">
            <button type="button"
              className={`anim-lab__btn${playing ? ' anim-lab__btn--active' : ''}`}
              onClick={handlePlay} disabled={playing}>
              Play
            </button>
            <button type="button" className="anim-lab__btn" onClick={() => void handleSave()}>
              Salvar
            </button>
            <button type="button" className="anim-lab__btn" onClick={() => void handleCopyTs()}>
              TS
            </button>
            <button type="button"
              className={`anim-lab__btn${onionSkinOn ? ' anim-lab__btn--active' : ''}`}
              onClick={() => setOnionSkinOn(v => !v)}>
              Onion
            </button>
            <button type="button"
              className="anim-lab__close"
              aria-label="Fechar"
              onClick={onClose}>
              &times;
            </button>
          </div>
        </div>

        {/* Body: 3D + sidebar */}
        <div className="anim-lab__body">
          <div className="anim-lab__viewport" ref={previewRef}>
            {/* Gizmo mode buttons overlaid bottom-left */}
            <div className="anim-lab__gizmo-bar">
              {(['rotate', 'translate', 'scale'] as const).map(mode => (
                <button key={mode} type="button"
                  className={`anim-lab__gizmo-btn${gizmoMode === mode ? ' anim-lab__gizmo-btn--active' : ''}`}
                  onClick={() => setGizmoMode(mode)}>
                  {mode === 'rotate' ? 'Rot' : mode === 'translate' ? 'Mov' : 'Esc'}
                </button>
              ))}
            </div>
          </div>

          <div className="anim-lab__sidebar">
            {/* Bone list */}
            <div className="anim-lab__bone-list">
              <h3 className="anim-lab__section-title">Bones</h3>
              <div className="anim-lab__bone-items">
                {PICKABLE_BONES.map(bone => {
                  const hasKf = keyframes.some(kf => kf.bone === bone);
                  return (
                    <button key={bone} type="button"
                      className={`anim-lab__bone-item${selectedBone === bone ? ' anim-lab__bone-item--sel' : ''}${hasKf ? ' anim-lab__bone-item--kf' : ''}`}
                      onClick={() => handleBoneListClick(bone)}>
                      {bone}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Inspector */}
            <div className="anim-lab__inspector">
              {selection.size > 1 ? (
                <>
                  <h3 className="anim-lab__section-title">
                    {selection.size} keyframes selecionados
                  </h3>
                  <button type="button" className="anim-lab__btn anim-lab__btn--sm"
                    onClick={clearSelection}>
                    Limpar selecao
                  </button>
                </>
              ) : (
                <>
                  <h3 className="anim-lab__section-title">
                    {selectedBone ? selectedBone : 'Selecione um bone'}
                  </h3>
                  {selectedBone && (
                    <>
                      {(['x', 'y', 'z'] as const).map(axis => (
                        <div key={axis} className="anim-lab__insp-row">
                          <span className="anim-lab__insp-axis"
                            style={{ color: axis === 'x' ? '#ef4444' : axis === 'y' ? '#22c55e' : '#3b82f6' }}>
                            {axis.toUpperCase()}
                          </span>
                          <input type="range" min="-180" max="180" step="0.5"
                            value={inspectorDelta[axis]}
                            onChange={e => handleInspectorAxisChange(axis, parseFloat(e.target.value))}
                            className="anim-lab__insp-slider" />
                          <span className="anim-lab__insp-val">
                            {inspectorDelta[axis].toFixed(1)}
                          </span>
                        </div>
                      ))}
                      <button type="button" className="anim-lab__btn anim-lab__btn--sm"
                        onClick={handleResetPose}>
                        Reset pose
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="anim-lab__timeline-area">
          <div className="anim-lab__timeline-actions">
            <button type="button" className="anim-lab__btn" onClick={handleInsertKeyframe}>
              Inserir keyframe (I)
            </button>
            <button type="button" className="anim-lab__btn"
              disabled={selection.size === 0} onClick={handleDeleteSelection}>
              {selection.size > 1 ? 'Apagar selecionados' : 'Apagar selecionado'}
            </button>
            <button type="button" className="anim-lab__btn" onClick={handleAddTangents}>
              + F-Curves
            </button>
            {keyframes.some(kf => kf.tangents) && (
              <button type="button"
                className={`anim-lab__btn${fcurveOpen ? ' anim-lab__btn--active' : ''}`}
                onClick={() => setFcurveOpen(v => !v)}>
                {fcurveOpen ? 'Fechar F-Curves' : 'F-Curves'}
              </button>
            )}
          </div>
          <AnimationTimeline
            duration={duration}
            keyframes={keyframes}
            selection={selection}
            primaryIdx={primaryIdx}
            scrubTime={scrubTime}
            onSelectKf={handleTimelineSelectKf}
            onClearSelection={clearSelection}
            onMultiKfTimeChange={handleMultiKfTimeChange}
            onScrubChange={setScrubTime}
            onRubberBandSelect={handleRubberBandSelect}
          />
        </div>

        {/* F-Curve editor (Phase 3) -- only when single kf selected */}
        {fcurveOpen && selectedBone && singleSelectedKf && (
          <div className="anim-lab__fcurve-area">
            <FCurveEditor
              bone={selectedBone}
              keyframes={keyframes}
              duration={duration}
              onUpdateTangent={handleUpdateTangent}
            />
          </div>
        )}

        {/* Feedback toast */}
        {feedback && <div className="anim-lab__feedback">{feedback}</div>}
      </div>
    </div>
  );
}
