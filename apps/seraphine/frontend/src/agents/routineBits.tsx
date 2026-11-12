/** Small pieces of the routines feature shared by the conversation, Início and the routine lists (no store access here). */
import { ClockIcon, PauseIcon, StopIcon, TickIcon, TimerIcon } from './icons';
import { WarningIcon } from './setupIcons';
import { routineRunWord, routineStateView } from './routines';
import type { Routine, RoutineRunStatus } from './types';

/** "Rotina · {título}" (or just "Rotina"): icon plus words. A button when `onClick` is given (opens the "Rotinas" tab). */
export function RoutineBadge({ title, onClick }: { title?: string | null; onClick?: () => void }): JSX.Element {
  const text = title ? `Rotina · ${title}` : 'Rotina';
  const inner = (
    <>
      <ClockIcon size={12} />
      <span className="a-routine-badge__text">{text}</span>
    </>
  );
  if (!onClick) return <span className="a-routine-badge">{inner}</span>;
  return (
    <button type="button" className="a-routine-badge a-routine-badge--button" title="Ver as rotinas" onClick={onClick}>
      {inner}
    </button>
  );
}

/** The state chip of a routine ("Ativa", "Pausada", "Pausada por falhas", "Rodando agora"): icon and word, never colour alone. */
export function RoutineStateChip({ routine }: { routine: Routine }): JSX.Element {
  const view = routineStateView(routine);
  const icon =
    view.icon === 'tick' ? <TickIcon size={12} /> : view.icon === 'pause' ? <PauseIcon size={12} /> : view.icon === 'warning' ? <WarningIcon size={12} /> : <TimerIcon size={12} />;
  return (
    <span className={`a-chip a-routine-chip a-routine-chip--${view.tone}`}>
      {icon}
      {view.word}
    </span>
  );
}

/** The state of one line of the ledger, in words with an icon. */
export function RoutineRunChip({ status }: { status: RoutineRunStatus }): JSX.Element {
  const icon =
    status === 'reported' || status === 'quiet' ? (
      <TickIcon size={12} />
    ) : status === 'failed' ? (
      <WarningIcon size={12} />
    ) : status === 'cancelled' ? (
      <StopIcon size={10} />
    ) : status === 'running' ? (
      <TimerIcon size={12} />
    ) : status === 'skipped' ? (
      <PauseIcon size={12} />
    ) : (
      <ClockIcon size={12} />
    );
  const tone = status === 'failed' ? 'warn' : status === 'reported' ? 'ok' : status === 'running' ? 'busy' : 'dim';
  return (
    <span className={`a-chip a-routine-chip a-routine-chip--${tone}`}>
      {icon}
      {routineRunWord(status)}
    </span>
  );
}
