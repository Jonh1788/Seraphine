import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FocusPhase } from './useFocusTimer';
import { useFocus } from './FocusContext';
import { PlayIcon, PauseIcon, SkipIcon, TimerIcon, XIcon } from '../icons/Icons';

const PHASE_LABELS: Record<FocusPhase, string> = {
  work: 'Trabalho',
  break: 'Pausa',
  long_break: 'Pausa longa',
  idle: 'Foco',
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function FocusPill(): JSX.Element {
  const [state, actions] = useFocus();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Posição calculada do popover em viewport coords. O popover é
  // renderizado via portal pro <body> pra escapar do stacking context
  // criado pelo `backdrop-filter` da .topbar — sem isso o WebKit
  // borrava o conteúdo do popover inteiro.
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = ref.current?.contains(target);
      const insidePopover = (target as Element).closest?.('.focus-popover');
      if (!insideTrigger && !insidePopover) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Recalcula posição do popover ao abrir + em scroll/resize.
  useEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const update = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPopoverPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const isActive = state.phase !== 'idle';
  const phaseClass = isActive ? `focus-pill--${state.phase}` : '';

  return (
    <div className="focus-pill-wrap" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={`focus-pill ${isActive ? 'focus-pill--active' : ''} ${phaseClass}`}
        title={isActive ? `${PHASE_LABELS[state.phase]} ${formatTime(state.remaining)}` : 'Iniciar foco'}
        aria-label="Foco"
        onClick={() => {
          if (!isActive) {
            actions.start();
          } else {
            setOpen((v) => !v);
          }
        }}
      >
        {isActive ? (
          <>
            <span className={`focus-pill__dot focus-pill__dot--${state.phase}`} aria-hidden />
            <span className="focus-pill__time">{formatTime(state.remaining)}</span>
          </>
        ) : (
          <TimerIcon size={18} />
        )}
      </button>

      {open && isActive && popoverPos && createPortal(
        <div
          className="focus-popover"
          style={{ top: popoverPos.top, right: popoverPos.right }}
        >
          <div className="focus-popover__phase">{PHASE_LABELS[state.phase]}</div>
          <div className="focus-popover__timer">{formatTime(state.remaining)}</div>

          {state.task && (
            <div className="focus-popover__task">Focando em: {state.task}</div>
          )}

          <div className="focus-popover__cycles">
            {[1, 2, 3, 4].map((n) => (
              <span
                key={n}
                className={`focus-popover__cycle-dot${n <= ((state.cycle - 1) % 4) + (state.phase === 'work' ? 1 : 0) ? ' focus-popover__cycle-dot--done' : ''}`}
                aria-hidden
              />
            ))}
          </div>

          <div className="focus-popover__controls">
            {state.running ? (
              <button type="button" className="focus-popover__btn" title="Pausar" onClick={() => actions.pause()}>
                <PauseIcon size={18} />
              </button>
            ) : (
              <button type="button" className="focus-popover__btn" title="Continuar" onClick={() => actions.resume()}>
                <PlayIcon size={18} />
              </button>
            )}
            <button type="button" className="focus-popover__btn" title="Pular" onClick={() => actions.skip()}>
              <SkipIcon size={18} />
            </button>
            <button type="button" className="focus-popover__btn focus-popover__btn--danger" title="Parar" onClick={() => { actions.reset(); setOpen(false); }}>
              <XIcon size={18} />
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
