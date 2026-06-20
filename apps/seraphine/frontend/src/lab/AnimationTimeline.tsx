/**
 * Sub-componente de timeline do Animation Lab. Renderiza a ruler SVG,
 * diamonds de keyframe, playhead, rubber-band e snap guides.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { KfDeg } from './labUtils';

const TL_TRACK_H = 26;
const TL_RULER_H = 24;
const TL_LABEL_W = 92;
const TL_DIAMOND = 8;

function diamondPts(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

export interface TimelineProps {
  duration: number;
  keyframes: KfDeg[];
  selection: Set<number>;
  primaryIdx: number | null;
  scrubTime: number;
  viewStart: number;
  viewEnd: number;
  tickStep: number;
  snapEnabled: boolean;
  onSelectKf: (idx: number, modifier: boolean) => void;
  onClearSelection: () => void;
  onMultiKfTimeChange: (indices: number[], dt: number, origTimes: Map<number, number>) => void;
  onMultiKfTimeCommit: (indices: number[], origTimes: Map<number, number>) => void;
  onScrubChange: (t: number) => void;
  onRubberBandSelect: (indices: number[], additive: boolean) => void;
  onZoom: (delta: number, centerT: number) => void;
  onPan: (dt: number) => void;
}

export function AnimationTimeline({
  duration, keyframes, selection, primaryIdx, scrubTime,
  viewStart, viewEnd, tickStep, snapEnabled,
  onSelectKf, onClearSelection, onMultiKfTimeChange, onMultiKfTimeCommit,
  onScrubChange, onRubberBandSelect, onZoom, onPan,
}: TimelineProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragItem, setDragItem] = useState<
    | { type: 'kf'; idx: number; origTimes: Map<number, number>; committed: boolean }
    | { type: 'playhead' }
    | { type: 'rubberband'; startX: number; startY: number; additive: boolean }
    | { type: 'pan'; lastX: number }
    | null
  >(null);
  const [rubberRect, setRubberRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [containerW, setContainerW] = useState(600);
  const [showSnap, setShowSnap] = useState(false);

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
  const tlW = Math.max(containerW - TL_LABEL_W, 50);

  const roRef = useRef<ResizeObserver | null>(null);
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!node) return;
    const measure = () => setContainerW(node.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    roRef.current = ro;
  }, []);

  const viewSpan = Math.max(viewEnd - viewStart, 0.0001);
  const tToX = (t: number) => TL_LABEL_W + ((t - viewStart) / viewSpan) * tlW;
  const xToT = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - TL_LABEL_W;
    return Math.max(0, Math.min(duration, viewStart + (x / tlW) * viewSpan));
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

  // Adaptive ticks based on visible span.
  const ticks: number[] = [];
  const firstTick = Math.ceil(viewStart / tickStep) * tickStep;
  for (let t = firstTick; t <= viewEnd + 1e-6; t += tickStep) {
    ticks.push(Math.round(t * 1000) / 1000);
  }

  // Snap guides shown when Shift held during kf drag.
  const snapGuides = snapEnabled && dragItem?.type === 'kf' ? ticks : [];

  // Diamond pointerdown: select + start drag
  const onPtrDown = useCallback((e: React.PointerEvent, idx: number) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const modifier = e.shiftKey || e.metaKey || e.ctrlKey;

    if (modifier && (e.metaKey || e.ctrlKey)) {
      onSelectKf(idx, true);
      const nextSel = new Set(selection);
      if (nextSel.has(idx)) nextSel.delete(idx); else nextSel.add(idx);
      const origTimes = new Map<number, number>();
      for (const i of nextSel) origTimes.set(i, keyframes[i].time);
      setDragItem({ type: 'kf', idx, origTimes, committed: false });
    } else {
      if (!selection.has(idx)) {
        onSelectKf(idx, false);
        const origTimes = new Map<number, number>();
        origTimes.set(idx, keyframes[idx].time);
        setDragItem({ type: 'kf', idx, origTimes, committed: false });
      } else {
        const origTimes = new Map<number, number>();
        for (const i of selection) origTimes.set(i, keyframes[i].time);
        setDragItem({ type: 'kf', idx, origTimes, committed: false });
      }
    }
    if (e.shiftKey) setShowSnap(true);
  }, [onSelectKf, selection, keyframes]);

  const onPlayheadDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragItem({ type: 'playhead' });
  }, []);

  const onPtrMove = useCallback((e: React.PointerEvent) => {
    if (!dragItem) return;
    if (dragItem.type === 'kf') {
      let newT = xToT(e.clientX);
      const grabbedOrigT = dragItem.origTimes.get(dragItem.idx);
      if (grabbedOrigT === undefined) return;
      setShowSnap(e.shiftKey);
      if (e.shiftKey && snapEnabled) {
        const step = e.altKey ? tickStep / 5 : tickStep;
        newT = Math.round(newT / step) * step;
      }
      let dt = newT - grabbedOrigT;
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
    } else if (dragItem.type === 'pan') {
      const dx = e.clientX - dragItem.lastX;
      const dtSec = -(dx / tlW) * viewSpan;
      onPan(dtSec);
      setDragItem({ type: 'pan', lastX: e.clientX });
    }
  }, [dragItem, duration, onMultiKfTimeChange, onScrubChange, snapEnabled, tickStep, viewStart, viewSpan, tlW, onPan]);

  const onPtrUp = useCallback(() => {
    if (dragItem?.type === 'rubberband' && rubberRect) {
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
    if (dragItem?.type === 'kf') {
      onMultiKfTimeCommit(Array.from(dragItem.origTimes.keys()), dragItem.origTimes);
    }
    setDragItem(null);
    setRubberRect(null);
    setShowSnap(false);
  }, [dragItem, rubberRect, keyframes, onRubberBandSelect, onMultiKfTimeCommit]);

  const onBgPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 1 || e.buttons === 4) {
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      setDragItem({ type: 'pan', lastX: e.clientX });
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      const pos = clientToSvg(e.clientX, e.clientY);
      setDragItem({ type: 'rubberband', startX: pos.x, startY: pos.y, additive: e.shiftKey });
      return;
    }
    const t = xToT(e.clientX);
    onScrubChange(t);
    onClearSelection();
  }, [onScrubChange, onClearSelection, viewStart, viewSpan]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const centerT = xToT(e.clientX);
      onZoom(-e.deltaY, centerT);
    }
  }, [onZoom, viewStart, viewSpan]);

  const svgCursor = dragItem?.type === 'rubberband'
    ? 'crosshair'
    : dragItem?.type === 'kf'
      ? 'grabbing'
      : dragItem?.type === 'pan'
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
        onWheel={onWheel}
      >
        {/* track stripes (odd rows) */}
        {tracks.map((bone, ti) => (
          ti % 2 === 1 ? (
            <rect key={`stripe-${bone}`}
              x={0} y={TL_RULER_H + ti * TL_TRACK_H}
              width="100%" height={TL_TRACK_H}
              className="anim-timeline__track-stripe" />
          ) : null
        ))}

        {/* ruler baseline */}
        <line x1={TL_LABEL_W} y1={TL_RULER_H} x2={TL_LABEL_W + tlW} y2={TL_RULER_H}
          stroke="var(--lab-border-hi)" strokeWidth={1} />

        {/* ticks */}
        {ticks.map(t => (
          <g key={`t-${t}`}>
            <line x1={tToX(t)} y1={TL_RULER_H - 6} x2={tToX(t)} y2={TL_RULER_H}
              stroke="var(--lab-border-hi)" strokeWidth={1} />
            <line x1={tToX(t)} y1={TL_RULER_H} x2={tToX(t)} y2={svgH}
              stroke="var(--lab-border-soft)" strokeWidth={0.5} strokeDasharray="2,3" />
            <text x={tToX(t)} y={TL_RULER_H - 8} textAnchor="middle"
              fontSize={9} fill="var(--text-dim)" className="anim-timeline__label">
              {t.toFixed(2)}
            </text>
          </g>
        ))}

        {/* snap guides (shift held) */}
        {showSnap && snapGuides.map(t => (
          <line key={`snap-${t}`}
            x1={tToX(t)} y1={TL_RULER_H}
            x2={tToX(t)} y2={svgH}
            className="anim-timeline__snap-guide" />
        ))}

        {/* track baselines + labels */}
        {tracks.map((bone, ti) => {
          const y = TL_RULER_H + ti * TL_TRACK_H + TL_TRACK_H / 2;
          return (
            <g key={`tr-${bone}`}>
              <line x1={TL_LABEL_W} y1={y} x2={TL_LABEL_W + tlW} y2={y}
                stroke="var(--lab-border-soft)" strokeWidth={0.5} />
              <text x={TL_LABEL_W - 8} y={y + 3} textAnchor="end"
                fontSize={10} fill="var(--text-dim)" className="anim-timeline__label">
                {bone.length > 13 ? bone.slice(0, 13) : bone}
              </text>
            </g>
          );
        })}

        {/* keyframe diamonds */}
        {keyframes.map((kf, idx) => {
          const cx = tToX(kf.time);
          const cy = trackY(kf.bone);
          if (cx < TL_LABEL_W - 10 || cx > TL_LABEL_W + tlW + 10) return null;
          const sel = selection.has(idx);
          const isPrimary = idx === primaryIdx;
          const cls = `anim-timeline__diamond${sel ? ' anim-timeline__diamond--sel' : ''}${isPrimary ? ' anim-timeline__diamond--primary' : ''}`;
          return (
            <polygon key={idx}
              points={diamondPts(cx, cy, TL_DIAMOND / 2)}
              className={cls}
              onPointerDown={e => onPtrDown(e, idx)}>
              <title>{`${kf.bone} @ ${kf.time.toFixed(2)}s — (${kf.x.toFixed(1)}°, ${kf.y.toFixed(1)}°, ${kf.z.toFixed(1)}°)`}</title>
            </polygon>
          );
        })}

        {/* rubber-band rect */}
        {rubberRect && (
          <rect
            x={rubberRect.x} y={rubberRect.y}
            width={rubberRect.w} height={rubberRect.h}
            rx={3}
            className="anim-timeline__rubberband"
          />
        )}

        {/* playhead */}
        {scrubTime >= viewStart && scrubTime <= viewEnd && (
          <>
            <line x1={tToX(scrubTime)} y1={TL_RULER_H - 2}
              x2={tToX(scrubTime)} y2={svgH}
              className="anim-timeline__playhead-line" />
            <polygon
              points={`${tToX(scrubTime) - 6},0 ${tToX(scrubTime) + 6},0 ${tToX(scrubTime)},${TL_RULER_H - 3}`}
              className="anim-timeline__playhead-head"
              onPointerDown={onPlayheadDown} />
          </>
        )}
      </svg>
    </div>
  );
}
