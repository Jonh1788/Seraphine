import { useMemo, useState } from 'react';
import { parseExpr, evalExpr, type Expr } from './mathexpr';

export type GraphSpec = {
  expr: string;
  x: { var: string; min: number; max: number };
  params?: { name: string; min: number; max: number; default: number }[];
};

const W = 560, H = 220, PAD = 28, SAMPLES = 120;

export function GraphBlock({ spec, hideSliders = false }: { spec: GraphSpec; hideSliders?: boolean }) {
  const ast: Expr | null = useMemo(() => { try { return parseExpr(spec.expr); } catch { return null; } }, [spec.expr]);
  const [params, setParams] = useState<Record<string, number>>(() =>
    Object.fromEntries((spec.params ?? []).map((p) => [p.name, p.default])));

  const pts = useMemo(() => {
    const out: [number, number][] = [];
    if (!ast) return out;
    for (let i = 0; i <= SAMPLES; i++) {
      const x = spec.x.min + (i / SAMPLES) * (spec.x.max - spec.x.min);
      let y: number;
      try { y = evalExpr(ast, { ...params, [spec.x.var]: x }); } catch { continue; }
      if (Number.isFinite(y)) out.push([x, y]);
    }
    return out;
  }, [ast, params, spec]);

  if (!ast) return null;
  if (!pts.length) return null;
  const ys = pts.map(([, y]) => y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const ySpan = yMax - yMin || 1;
  const sx = (x: number) => PAD + ((x - spec.x.min) / (spec.x.max - spec.x.min)) * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - yMin) / ySpan) * (H - 2 * PAD);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');

  return (
    <figure className="tr-graph">
      <svg viewBox={`0 0 ${W} ${H}`} className="tr-graph__svg" role="img" aria-label={spec.expr}>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="tr-graph__axis" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="tr-graph__axis" />
        <path d={d} className="tr-graph__curve" fill="none" />
        <text x={W - PAD} y={H - 8} className="tr-graph__lbl" textAnchor="end">{spec.x.var}</text>
      </svg>
      <figcaption className="tr-graph__expr"><code>{spec.expr}</code></figcaption>
      {!hideSliders && (spec.params ?? []).map((p) => (
        <label key={p.name} className="tr-graph__slider">
          <span>{p.name} = {params[p.name].toFixed(2)}</span>
          <input type="range" min={p.min} max={p.max} step={(p.max - p.min) / 100}
            value={params[p.name]}
            onChange={(e) => setParams({ ...params, [p.name]: Number(e.target.value) })} />
        </label>
      ))}
    </figure>
  );
}
