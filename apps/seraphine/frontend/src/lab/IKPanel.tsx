/**
 * Painel de autoria de IK targets para o Animation Lab.
 * Lista targets, edita parametros (time, fadeIn, hold, fadeOut, blend)
 * e posicao XYZ do target no espaço selecionado.
 */
import type { IKTarget } from '../avatar/gestures';
import { ikWeightAt } from './ikSolver';
import { PlusIcon, TrashIcon } from '../icons/Icons';

export interface IKPanelProps {
  targets: IKTarget[];
  selectedId: string | null;
  duration: number;
  scrubTime: number;
  onSelect: (id: string | null) => void;
  onAdd: (chain: IKTarget['chain']) => void;
  onUpdate: (id: string, patch: Partial<IKTarget>) => void;
  onDelete: (id: string) => void;
  onJumpTo: (time: number) => void;
}

export function IKPanel({
  targets, selectedId, duration, scrubTime,
  onSelect, onAdd, onUpdate, onDelete, onJumpTo,
}: IKPanelProps): JSX.Element {
  const sel = targets.find(t => t.id === selectedId) ?? null;
  return (
    <div className="anim-lab__card">
      <div className="anim-lab__card-head">
        <span className="anim-lab__card-title">IK targets</span>
        <span className="anim-lab__card-meta">{targets.length} ativo{targets.length !== 1 ? 's' : ''}</span>
      </div>

      {targets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
          {targets.map(t => (
            <button key={t.id} type="button"
              onClick={() => { onSelect(t.id); onJumpTo(t.time); }}
              className={`anim-lab__library-item${t.id === selectedId ? ' anim-lab__library-item--active' : ''}`}
              style={{ justifyContent: 'space-between', fontSize: 10 }}>
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>
                {t.chain} @ {t.time.toFixed(2)}s
              </span>
              <span className="anim-lab__library-badge">
                {(ikWeightAt(t, scrubTime) * 100).toFixed(0)}%
              </span>
            </button>
          ))}
        </div>
      )}

      {sel ? (
        <>
          {(['time', 'fadeIn', 'hold', 'fadeOut', 'blend'] as const).map(key => {
            const max = key === 'blend' ? 1 : duration;
            const step = key === 'blend' ? 0.05 : 0.05;
            return (
              <div key={key} className="anim-lab__insp-row">
                <span className="anim-lab__insp-axis" style={{ fontSize: 9 }}>
                  {key === 'fadeIn' ? 'IN' : key === 'fadeOut' ? 'OUT' : key === 'blend' ? 'BL' : key.toUpperCase()}
                </span>
                <input type="range" min={0} max={max} step={step}
                  value={sel[key]}
                  onChange={e => onUpdate(sel.id, { [key]: parseFloat(e.target.value) } as Partial<IKTarget>)}
                  className="anim-lab__insp-slider" />
                <span className="anim-lab__insp-val">
                  {key === 'blend' ? (sel[key] * 100).toFixed(0) + '%' : sel[key].toFixed(2) + 's'}
                </span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--lab-border-soft)' }}>
            <div style={{ fontSize: 9, color: 'var(--text-faint)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              target {sel.space}
            </div>
            {(['x', 'y', 'z'] as const).map(axis => (
              <div key={axis} className="anim-lab__insp-row">
                <span className={`anim-lab__insp-axis anim-lab__insp-axis--${axis}`}>
                  {axis.toUpperCase()}
                </span>
                <input type="range" min={-2} max={2} step={0.02}
                  value={sel.target[axis]}
                  onChange={e => onUpdate(sel.id, { target: { ...sel.target, [axis]: parseFloat(e.target.value) } })}
                  className={`anim-lab__insp-slider anim-lab__insp-slider--${axis}`} />
                <span className="anim-lab__insp-val">
                  {sel.target[axis].toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="anim-lab__card-actions">
            <button type="button" className="anim-lab__btn anim-lab__btn--sm anim-lab__btn--danger"
              onClick={() => onDelete(sel.id)}>
              <TrashIcon size={11} /> Remover
            </button>
          </div>
        </>
      ) : (
        <div className="anim-lab__inspector-empty" style={{ padding: 12, fontSize: 10 }}>
          {targets.length === 0
            ? 'Cabeca olhando para um ponto no mundo. Adicione um target para autoria com IK.'
            : 'Clique num target acima para editar.'}
        </div>
      )}

      <div className="anim-lab__card-actions">
        <button type="button" className="anim-lab__btn anim-lab__btn--sm" onClick={() => onAdd('head')}>
          <PlusIcon size={11} /> Head
        </button>
        <button type="button" className="anim-lab__btn anim-lab__btn--sm" onClick={() => onAdd('leftArm')}>
          <PlusIcon size={11} /> L arm
        </button>
        <button type="button" className="anim-lab__btn anim-lab__btn--sm" onClick={() => onAdd('rightArm')}>
          <PlusIcon size={11} /> R arm
        </button>
      </div>
    </div>
  );
}
