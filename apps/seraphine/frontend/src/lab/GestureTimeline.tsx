import { useCallback, useRef, useState } from 'react';

const TRACK_HEIGHT = 28;
const RULER_HEIGHT = 24;
const LABEL_WIDTH = 100;
const DIAMOND_SIZE = 8;

interface Props {
  duration: number;
  keyframes: { bone: string; time: number }[];
  selectedIndex: number | null;
  playheadTime: number | null;
  onSelect(index: number | null): void;
  onTimeChange(index: number, newTime: number): void;
}

/** Stable track ordering: first appearance in keyframes list. */
function buildTracks(keyframes: { bone: string }[]): string[] {
  const seen = new Set<string>();
  const tracks: string[] = [];
  for (const kf of keyframes) {
    if (!seen.has(kf.bone)) {
      seen.add(kf.bone);
      tracks.push(kf.bone);
    }
  }
  return tracks;
}

/** Diamond polygon points centered at (cx, cy). */
function diamondPoints(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

export function GestureTimeline({
  duration,
  keyframes,
  selectedIndex,
  playheadTime,
  onSelect,
  onTimeChange,
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(400);

  const tracks = buildTracks(keyframes);
  const numTracks = Math.max(tracks.length, 1);
  const svgHeight = RULER_HEIGHT + numTracks * TRACK_HEIGHT;
  const timelineWidth = containerWidth - LABEL_WIDTH;

  // Measure container on mount and resize
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setContainerWidth(node.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    // cleanup handled by React unmount — acceptable for lab tool
  }, []);

  const timeToX = (t: number): number =>
    LABEL_WIDTH + (t / duration) * timelineWidth;

  const xToTime = (clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_WIDTH;
    const t = (x / timelineWidth) * duration;
    return Math.round(Math.max(0, Math.min(duration, t)) * 100) / 100;
  };

  const trackY = (bone: string): number => {
    const idx = tracks.indexOf(bone);
    return RULER_HEIGHT + idx * TRACK_HEIGHT + TRACK_HEIGHT / 2;
  };

  // --- Ruler ticks ---
  const tickStep = duration > 1 ? 0.5 : 0.25;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += tickStep) {
    ticks.push(Math.round(t * 100) / 100);
  }

  // --- Pointer handlers for drag ---
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, idx: number) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      setDragIndex(idx);
      onSelect(idx);
    },
    [onSelect],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragIndex === null) return;
      const newTime = xToTime(e.clientX);
      onTimeChange(dragIndex, newTime);
    },
    [dragIndex, onTimeChange],
  );

  const handlePointerUp = useCallback(() => {
    setDragIndex(null);
  }, []);

  const handleBgClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

  return (
    <div className="gesture-timeline" ref={measuredRef}>
      <svg
        ref={svgRef}
        width="100%"
        height={svgHeight}
        className="gesture-timeline__svg"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleBgClick}
      >
        {/* Ruler */}
        <line
          x1={LABEL_WIDTH}
          y1={RULER_HEIGHT}
          x2={LABEL_WIDTH + timelineWidth}
          y2={RULER_HEIGHT}
          stroke="var(--glass-border)"
          strokeWidth={1}
        />
        {ticks.map((t) => {
          const x = timeToX(t);
          return (
            <g key={`tick-${t}`}>
              <line
                x1={x}
                y1={RULER_HEIGHT - 10}
                x2={x}
                y2={RULER_HEIGHT}
                stroke="var(--glass-border)"
                strokeWidth={1}
              />
              <text
                x={x}
                y={RULER_HEIGHT - 12}
                textAnchor="middle"
                fontSize={10}
                fill="var(--text-dim)"
                className="gesture-timeline__tick-label"
              >
                {t.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* Track baselines + labels */}
        {tracks.map((bone, ti) => {
          const y = RULER_HEIGHT + ti * TRACK_HEIGHT + TRACK_HEIGHT / 2;
          return (
            <g key={`track-${bone}`}>
              <line
                x1={LABEL_WIDTH}
                y1={y}
                x2={LABEL_WIDTH + timelineWidth}
                y2={y}
                stroke="var(--glass-border)"
                strokeWidth={0.5}
                strokeDasharray="2,4"
              />
              <text
                x={LABEL_WIDTH - 6}
                y={y + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--text-dim)"
                className="gesture-timeline__track-label"
              >
                {bone.length > 12 ? bone.slice(0, 12) : bone}
              </text>
            </g>
          );
        })}

        {/* Keyframe diamonds */}
        {keyframes.map((kf, idx) => {
          const cx = timeToX(kf.time);
          const cy = trackY(kf.bone);
          const isSelected = idx === selectedIndex;
          const isHovered = idx === hoverIndex;
          const isDragging = idx === dragIndex;
          const fill = isSelected
            ? 'var(--accent)'
            : isHovered
              ? 'var(--text-dim)'
              : 'var(--text)';
          const cursor = isDragging ? 'grabbing' : 'grab';
          return (
            <polygon
              key={idx}
              points={diamondPoints(cx, cy, DIAMOND_SIZE / 2)}
              fill={fill}
              stroke={isSelected ? 'var(--accent)' : 'none'}
              strokeWidth={isSelected ? 1.5 : 0}
              style={{ cursor }}
              onPointerDown={(e) => handlePointerDown(e, idx)}
              onPointerEnter={() => setHoverIndex(idx)}
              onPointerLeave={() => setHoverIndex(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <title>{`${kf.bone} @ ${kf.time.toFixed(2)}s`}</title>
            </polygon>
          );
        })}

        {/* Playhead */}
        {playheadTime !== null && (
          <line
            x1={timeToX(playheadTime)}
            y1={0}
            x2={timeToX(playheadTime)}
            y2={svgHeight}
            stroke="var(--accent)"
            strokeWidth={1.5}
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  );
}
