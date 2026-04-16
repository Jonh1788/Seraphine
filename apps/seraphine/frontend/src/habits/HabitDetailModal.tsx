import { useCallback, useEffect, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, TrashIcon, XIcon } from '../icons/Icons';
import { getCalendar, getStreaks } from './api';
import { habitIcon } from './HabitIconMap';
import type { HabitLog, HabitStreaks, HabitWithStatus } from './types';

const MONTH_LABELS = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const WEEKDAY_LABELS = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D']; // Mon..Sun (matches backend 0=Mon)

interface HabitDetailModalProps {
  habit: HabitWithStatus;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  busy?: boolean;
}

export function HabitDetailModal({
  habit,
  onClose,
  onEdit,
  onDelete,
  busy,
}: HabitDetailModalProps): JSX.Element {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1); // 1..12
  const [year, setYear] = useState(now.getFullYear());
  const [streaks, setStreaks] = useState<HabitStreaks | null>(null);
  const [logs, setLogs] = useState<HabitLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const color = habit.color || '#22d3ee';

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [s, cal] = await Promise.all([
        getStreaks(habit.id).catch(() => null),
        getCalendar(habit.id, month, year).catch(() => ({ logs: [] as HabitLog[] })),
      ]);
      if (s) setStreaks(s);
      setLogs(Array.isArray(cal.logs) ? cal.logs : []);
    } finally {
      setLoading(false);
    }
  }, [habit.id, month, year]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handlePrevMonth = (): void => {
    setMonth((m) => {
      if (m === 1) {
        setYear((y) => y - 1);
        return 12;
      }
      return m - 1;
    });
  };

  const handleNextMonth = (): void => {
    setMonth((m) => {
      if (m === 12) {
        setYear((y) => y + 1);
        return 1;
      }
      return m + 1;
    });
  };

  const handleDelete = (): void => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete();
  };

  // Build a set of completed YYYY-MM-DD strings (only completed=true).
  const doneDates = new Set(
    logs.filter((l) => l.completed).map((l) => l.date),
  );

  // Build the calendar grid. First cell aligns to Monday=0.
  const firstDay = new Date(year, month - 1, 1);
  // JS getDay(): 0=Sun..6=Sat. We want 0=Mon..6=Sun.
  const firstWeekdayJs = firstDay.getDay();
  const firstWeekday = (firstWeekdayJs + 6) % 7; // 0=Mon..6=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const cells: { day: number | null; dateStr: string | null }[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push({ day: null, dateStr: null });
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, dateStr });
  }
  // Pad to a multiple of 7 (keeps layout stable — 5 or 6 rows).
  while (cells.length % 7 !== 0) cells.push({ day: null, dateStr: null });

  return (
    <div className="password-modal-backdrop" onClick={onClose}>
      <div
        className="task-editor-modal habit-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="te__header habit-detail-modal__header">
          <span
            className="habit-detail-modal__icon"
            style={{ background: `${color}22`, color }}
            aria-hidden
          >
            {habitIcon(habit.icon, 22)}
          </span>
          <span className="te__title habit-detail-modal__title">{habit.title}</span>
          <div className="te__actions">
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  className="te__action te__action--danger"
                  disabled={busy}
                  onClick={handleDelete}
                >
                  Sim
                </button>
                <button
                  type="button"
                  className="te__action"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Nao
                </button>
              </>
            ) : (
              <button
                type="button"
                className="te__action te__action--danger"
                disabled={busy}
                onClick={handleDelete}
                title="Excluir"
              >
                <TrashIcon size={16} />
              </button>
            )}
            <button
              type="button"
              className="te__action"
              onClick={onEdit}
              disabled={busy}
              title="Editar"
            >
              Editar
            </button>
            <button
              type="button"
              className="te__action"
              onClick={onClose}
              title="Fechar"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {habit.description && (
          <p className="habit-detail-modal__description">{habit.description}</p>
        )}

        <div className="habit-detail-modal__stats">
          <div className="habit-detail-stat">
            <span className="habit-detail-stat__value" style={{ color }}>
              {streaks ? streaks.current : habit.current_streak}
            </span>
            <span className="habit-detail-stat__label">Streak atual</span>
          </div>
          <div className="habit-detail-stat">
            <span className="habit-detail-stat__value">
              {streaks ? streaks.best : '—'}
            </span>
            <span className="habit-detail-stat__label">Melhor</span>
          </div>
          <div className="habit-detail-stat">
            <span className="habit-detail-stat__value">
              {streaks ? streaks.total : '—'}
            </span>
            <span className="habit-detail-stat__label">Total</span>
          </div>
        </div>

        <div className="habit-detail-modal__calendar">
          <div className="habit-detail-modal__cal-header">
            <button
              type="button"
              className="habit-detail-modal__cal-nav"
              onClick={handlePrevMonth}
              disabled={loading}
              aria-label="Mes anterior"
            >
              <ChevronLeftIcon size={16} />
            </button>
            <span className="habit-detail-modal__cal-title">
              {MONTH_LABELS[month - 1]} {year}
            </span>
            <button
              type="button"
              className="habit-detail-modal__cal-nav"
              onClick={handleNextMonth}
              disabled={loading}
              aria-label="Proximo mes"
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>

          <div className="habit-calendar-grid habit-calendar-grid--header">
            {WEEKDAY_LABELS.map((w, i) => (
              <span key={i} className="habit-calendar-weekday">{w}</span>
            ))}
          </div>

          <div className="habit-calendar-grid">
            {cells.map((c, i) => {
              if (c.day == null || c.dateStr == null) {
                return <span key={i} className="habit-calendar-day habit-calendar-day--empty" />;
              }
              const done = doneDates.has(c.dateStr);
              const isToday = c.dateStr === todayStr;
              const isFuture = c.dateStr > todayStr;
              return (
                <span
                  key={i}
                  className={
                    'habit-calendar-day' +
                    (done ? ' habit-calendar-day--done' : '') +
                    (isToday ? ' habit-calendar-day--today' : '') +
                    (isFuture ? ' habit-calendar-day--future' : '')
                  }
                  title={c.dateStr}
                  style={done ? { background: color, borderColor: color } : undefined}
                >
                  <span className="habit-calendar-day__num">{c.day}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
