import { CheckIcon } from '../icons/Icons';
import { habitIcon } from './HabitIconMap';
import type { HabitWithStatus } from './types';

/** Fallback denominator only when a habit has no record streak yet. */
const STREAK_FALLBACK = 30;

interface HabitCardProps {
  habit: HabitWithStatus;
  onToggle: () => void;
  onClick: () => void;
  busy?: boolean;
}

export function HabitCard({ habit, onToggle, onClick, busy }: HabitCardProps): JSX.Element {
  const color = habit.color || '#22d3ee';
  // Progress toward the real record streak (best_streak) rather than a magic
  // constant; when there is no record yet, fall back to a sensible default.
  const denom = habit.best_streak > 0 ? habit.best_streak : STREAK_FALLBACK;
  const pct = Math.min(100, Math.round((habit.current_streak / denom) * 100));
  const done = habit.today_completed;

  const handleToggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (busy) return;
    onToggle();
  };

  const handleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className="habit-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKey}
      style={{ borderLeftColor: color }}
    >
      <div className="habit-card__top">
        <span
          className="habit-card__icon"
          style={{ background: `${color}22`, color }}
          aria-hidden
        >
          {habitIcon(habit.icon, 20)}
        </span>
        <span className="habit-card__title" title={habit.title}>
          {habit.title}
        </span>
      </div>

      <div className="habit-card__streak">
        <div className="habit-card__streak-bar" aria-hidden>
          <div
            className="habit-card__streak-fill"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
        <span className="habit-card__streak-count">
          {habit.current_streak} {habit.current_streak === 1 ? 'dia' : 'dias'}
        </span>
      </div>

      <button
        type="button"
        className={`habit-card__toggle${done ? ' habit-card__toggle--done' : ''}`}
        onClick={handleToggle}
        disabled={busy}
        aria-pressed={done}
        aria-label={done ? 'Desmarcar hoje' : 'Marcar como concluido hoje'}
        style={done ? { background: color, borderColor: color } : { borderColor: color }}
      >
        <CheckIcon size={20} />
      </button>
    </div>
  );
}
