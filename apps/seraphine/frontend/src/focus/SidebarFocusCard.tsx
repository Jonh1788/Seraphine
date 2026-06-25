import { useFocus } from './FocusContext';
import type { FocusPhase } from './useFocusTimer';

const FOCUS_PHASE_SECS: Record<FocusPhase, number> = {
  work: 25 * 60,
  break: 5 * 60,
  long_break: 15 * 60,
  idle: 25 * 60,
};

export function SidebarFocusCard(): JSX.Element {
  const [focusState, focusActions] = useFocus();
  const focusTotal = FOCUS_PHASE_SECS[focusState.phase];
  const focusRemaining = focusState.phase === 'idle' ? focusTotal : focusState.remaining;
  const focusMmss = `${Math.floor(focusRemaining / 60)
    .toString()
    .padStart(2, '0')}:${(focusRemaining % 60).toString().padStart(2, '0')}`;
  const focusPct =
    focusState.phase === 'idle'
      ? 0
      : Math.max(0, Math.min(100, ((focusTotal - focusRemaining) / focusTotal) * 100));

  return (
    <button
      type="button"
      className={`sidebar__foco${focusState.phase === 'idle' ? ' sidebar__foco--idle' : ''}`}
      aria-label={focusState.phase === 'idle' ? 'Iniciar foco Pomodoro' : 'Foco Pomodoro'}
      onClick={() => {
        if (focusState.phase === 'idle') focusActions.start();
        else if (focusState.running) focusActions.pause();
        else focusActions.resume();
      }}
    >
      <div className="sidebar__foco-head">
        <span className="sidebar__foco-label">FOCO</span>
        <span className="sidebar__foco-mode">
          {focusState.phase === 'idle'
            ? 'Iniciar'
            : focusState.phase === 'work'
              ? 'Pomodoro'
              : focusState.phase === 'long_break'
                ? 'Pausa longa'
                : 'Pausa'}
        </span>
      </div>
      <div className="sidebar__foco-time">
        <span className="sidebar__foco-num">{focusMmss}</span>
        <span className="sidebar__foco-rest">
          {focusState.phase === 'idle' ? 'Pomodoro' : focusState.running ? 'restante' : 'pausado'}
        </span>
      </div>
      <div className="sidebar__foco-bar">
        <div style={{ width: `${focusPct}%` }} />
      </div>
    </button>
  );
}
