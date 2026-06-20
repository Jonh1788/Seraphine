/**
 * Editor de F-Curves (tangentes Bezier) para o Animation Lab.
 * Renderiza curvas X/Y/Z por bone com handles arrastáveis.
 */
import { useMemo } from 'react';
import type { KfDeg } from './labUtils';
import { RAD2DEG } from './labUtils';

export interface FCurveProps {
  bone: string;
  keyframes: KfDeg[];
  duration: number;
  onUpdateTangent: (kfIdx: number, axis: 'x' | 'y' | 'z', handle: 'in' | 'out', dy: number) => void;
}

export function FCurveEditor({ bone, keyframes, duration, onUpdateTangent }: FCurveProps): JSX.Element {
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
  const axisColors = { x: 'var(--lab-axis-x)', y: 'var(--lab-axis-y)', z: 'var(--lab-axis-z)' };

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
              <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD}
                stroke="var(--lab-border-soft)" strokeWidth={0.5} />
              <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD}
                stroke="var(--lab-border-soft)" strokeWidth={0.5} />
              <path d={path} fill="none" stroke={axisColors[axis]} strokeWidth={1.5} />
              {boneKfs.map((kf, i) => {
                const px = toSvgX(kf.time);
                const py = toSvgY(kf[axis]);
                const tang = kf.tangents?.[axis];
                return (
                  <g key={i}>
                    <circle cx={px} cy={py} r={4} fill={axisColors[axis]} />
                    {tang && (
                      <>
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
