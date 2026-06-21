import './obsidian.css';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createHabit,
  deleteHabit,
  getCalendarBatch,
  listHabits,
  toggleHabit,
  updateHabit,
} from './api';
import { habitIcon } from './HabitIconMap';
import { HabitDetailModal } from './HabitDetailModal';
import { HabitEditorModal, type HabitEditorValue } from './HabitEditorModal';
import type { Habit, HabitWithStatus } from './types';

interface HabitsViewProps {
  onBack: () => void;
}

/** Weekday letters Mon..Sun (PT-BR: Segunda..Domingo). Sunday rendered accent. */
const WEEKDAY_LETTERS = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];

/** Local YYYY-MM-DD (avoids UTC off-by-one from toISOString). */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns the 7 dates of the current week, Monday..Sunday. */
function currentWeekDates(today: Date): Date[] {
  const monday = new Date(today);
  // getDay(): 0=Sun..6=Sat -> offset to Monday-based week.
  const offset = (today.getDay() + 6) % 7;
  monday.setDate(today.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const FlameSvg = ({ size = 13 }: { size?: number }): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 3c.5 2.5 2 4.2 3.5 5.5C17 9.8 18 11.5 18 13.5a6 6 0 1 1-12 0c0-1.2.4-2.3 1-3 .2 1.2 1 2 2 2a2.5 2.5 0 0 0 2.5-2.5c0-1.5-1-2.5-1-4 0-1 .4-2 1.5-3z" />
  </svg>
);

const CheckSvg = ({ size = 13 }: { size?: number }): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={3}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5 12l4 4 10-10" />
  </svg>
);

const BarChartSvg = (): JSX.Element => (
  <svg
    width={22}
    height={22}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--accent)"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5 21V7l8-4v18M19 21V11l-6-3" />
  </svg>
);

export function HabitsView({ onBack: _onBack }: HabitsViewProps): JSX.Element {
  const [habits, setHabits] = useState<HabitWithStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Per-habit weekly completion: habitId -> Set<YYYY-MM-DD>. */
  const [weekLogs, setWeekLogs] = useState<Record<string, Set<string>>>({});

  const [showNew, setShowNew] = useState(false);
  const [newBusy, setNewBusy] = useState(false);

  const [detailHabit, setDetailHabit] = useState<HabitWithStatus | null>(null);
  const [editHabit, setEditHabit] = useState<Habit | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [busyCell, setBusyCell] = useState<string | null>(null);

  const weekDates = useMemo(() => currentWeekDates(new Date()), []);
  const todayIso = useMemo(() => isoDate(new Date()), []);

  /**
   * Fetch this week's logs for every active habit in one batch call per spanned
   * month (replaces the previous N+1 per-habit calendar fetch).
   */
  const refreshWeek = useCallback(
    async (list: HabitWithStatus[]): Promise<void> => {
      const monthsNeeded = new Map<string, { month: number; year: number }>();
      for (const d of weekDates) {
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        monthsNeeded.set(key, { month: d.getMonth() + 1, year: d.getFullYear() });
      }
      const next: Record<string, Set<string>> = {};
      for (const habit of list) next[habit.id] = new Set<string>();
      try {
        await Promise.all(
          [...monthsNeeded.values()].map(async ({ month, year }) => {
            const batch = await getCalendarBatch(month, year);
            for (const [habitId, logs] of Object.entries(batch.logs)) {
              const set = next[habitId] ?? new Set<string>();
              for (const log of logs) {
                if (log.completed) set.add(log.date);
              }
              next[habitId] = set;
            }
          }),
        );
      } catch {
        // Graceful: leave habits without weekly data; cells fall back below.
      }
      setWeekLogs(next);
    },
    [weekDates],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await listHabits();
      setHabits(list);
      void refreshWeek(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [refreshWeek]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh when the tab/window becomes visible again.
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const stats = useMemo(() => {
    const active = habits.length;
    // "Concluído hoje" is scoped to habits actually due today (is_target_today),
    // so a weekdays habit on a weekend no longer counts against the %.
    const dueToday = habits.filter((h) => h.is_target_today);
    const total = dueToday.length;
    const completed = dueToday.filter((h) => h.today_completed).length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    let best = 0;
    let current = 0;
    for (const h of habits) {
      // Real record streak from the backend (was previously max current_streak).
      if (h.best_streak > best) best = h.best_streak;
      if (h.current_streak > current) current = h.current_streak;
    }
    const avg =
      active > 0
        ? Math.round(habits.reduce((s, h) => s + h.current_streak, 0) / active)
        : 0;
    return { active, total, completed, pct, best, current, avg };
  }, [habits]);

  /** Toggle completion for a specific habit + date (preserves optimistic flow). */
  const handleToggleDate = useCallback(
    async (habit: HabitWithStatus, date: string): Promise<void> => {
      const cellKey = `${habit.id}:${date}`;
      if (busyCell) return;
      setBusyCell(cellKey);

      const wasDone = weekLogs[habit.id]?.has(date) ?? false;
      const isToday = date === todayIso;

      // Optimistic update of the week grid.
      setWeekLogs((prev) => {
        const set = new Set(prev[habit.id] ?? []);
        if (wasDone) set.delete(date);
        else set.add(date);
        return { ...prev, [habit.id]: set };
      });
      // Optimistic update of today_completed / streak when toggling today.
      if (isToday) {
        setHabits((prev) =>
          prev.map((h) => {
            if (h.id !== habit.id) return h;
            const nextCurrent = wasDone
              ? Math.max(0, h.current_streak - 1)
              : h.current_streak + 1;
            return {
              ...h,
              today_completed: !wasDone,
              current_streak: nextCurrent,
              best_streak: Math.max(h.best_streak, nextCurrent),
            };
          }),
        );
      }

      try {
        const res = await toggleHabit(habit.id, isToday ? undefined : date);
        const nowDone = !!res.log?.completed;
        setWeekLogs((prev) => {
          const set = new Set(prev[habit.id] ?? []);
          if (nowDone) set.add(date);
          else set.delete(date);
          return { ...prev, [habit.id]: set };
        });
        if (isToday) {
          setHabits((prev) =>
            prev.map((h) =>
              h.id === habit.id
                ? {
                    ...h,
                    today_completed: nowDone,
                    current_streak: res.current_streak,
                    best_streak: res.best_streak,
                    total_completed: res.total_completed,
                  }
                : h,
            ),
          );
          setDetailHabit((prev) =>
            prev && prev.id === habit.id
              ? { ...prev, today_completed: nowDone, current_streak: res.current_streak }
              : prev,
          );
        } else {
          setHabits((prev) =>
            prev.map((h) =>
              h.id === habit.id
                ? {
                    ...h,
                    current_streak: res.current_streak,
                    best_streak: res.best_streak,
                    total_completed: res.total_completed,
                  }
                : h,
            ),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void refresh();
      } finally {
        setBusyCell(null);
      }
    },
    [busyCell, weekLogs, todayIso, refresh],
  );

  const handleCreate = useCallback(
    async (value: HabitEditorValue): Promise<void> => {
      setNewBusy(true);
      try {
        await createHabit({
          title: value.title,
          icon: value.icon,
          color: value.color,
          frequency: value.frequency,
          target_days: value.target_days,
          description: value.description || null,
        });
        setShowNew(false);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setNewBusy(false);
      }
    },
    [refresh],
  );

  const handleUpdate = useCallback(
    async (value: HabitEditorValue): Promise<void> => {
      if (!editHabit) return;
      setEditBusy(true);
      try {
        await updateHabit(editHabit.id, {
          title: value.title,
          icon: value.icon,
          color: value.color,
          frequency: value.frequency,
          target_days: value.target_days,
          description: value.description || null,
        });
        setEditHabit(null);
        // If detail was open, update its basics too.
        setDetailHabit((prev) =>
          prev && prev.id === editHabit.id
            ? {
                ...prev,
                title: value.title,
                icon: value.icon,
                color: value.color,
                frequency: value.frequency,
                target_days: value.target_days,
                description: value.description || null,
              }
            : prev,
        );
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setEditBusy(false);
      }
    },
    [editHabit, refresh],
  );

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      setEditBusy(true);
      try {
        await deleteHabit(id);
        setEditHabit(null);
        setDetailHabit((prev) => (prev && prev.id === id ? null : prev));
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setEditBusy(false);
      }
    },
    [refresh],
  );

  const hasHabits = habits.length > 0;

  return (
    <div className="tasks-view habits-view habits-obs">
      <div className="habits-obs__header">
        <div className="habits-obs__titles">
          <h2 className="habits-obs__title">Hábitos</h2>
          <p className="habits-obs__sub">
            {stats.active} {stats.active === 1 ? 'ativo' : 'ativos'} · sequência média
            de {stats.avg} {stats.avg === 1 ? 'dia' : 'dias'}
            {loading ? ' · atualizando…' : ''}
          </p>
        </div>
        <button
          type="button"
          className="habits-obs__new"
          onClick={() => setShowNew(true)}
        >
          <span aria-hidden>+</span>
          <span>Novo hábito</span>
        </button>
      </div>

      <div className="habits-obs__body">
        {error && <div className="habits-obs__error">{error}</div>}

        {/* ---- Stats row ---- */}
        <div className="habits-stats">
          <div className="habits-stat">
            <span
              className="habits-stat__tile"
              style={{ background: 'rgba(255,138,76,0.14)' }}
              aria-hidden
            >
              <span style={{ color: '#ff8a4c', display: 'inline-flex' }}>
                <FlameSvg size={22} />
              </span>
            </span>
            <div>
              <div className="habits-stat__value">
                {stats.current} {stats.current === 1 ? 'dia' : 'dias'}
              </div>
              <div className="habits-stat__label">Sequência atual</div>
            </div>
          </div>

          <div className="habits-stat">
            <span
              className="habits-stat__ring"
              style={{
                background: `conic-gradient(var(--accent) ${stats.pct}%, rgba(255,255,255,0.08) 0)`,
              }}
              aria-hidden
            >
              <span className="habits-stat__ring-inner">
                {stats.completed}/{stats.total}
              </span>
            </span>
            <div>
              <div className="habits-stat__value">{stats.pct}%</div>
              <div className="habits-stat__label">Concluído hoje</div>
            </div>
          </div>

          <div className="habits-stat">
            <span
              className="habits-stat__tile"
              style={{ background: 'var(--accent-soft)' }}
              aria-hidden
            >
              <BarChartSvg />
            </span>
            <div>
              <div className="habits-stat__value">
                {stats.best} {stats.best === 1 ? 'dia' : 'dias'}
              </div>
              <div className="habits-stat__label">Melhor sequência</div>
            </div>
          </div>
        </div>

        {/* ---- Weekly check-grid ---- */}
        {!hasHabits && !loading ? (
          <div className="habits-obs__empty">
            <div className="habits-obs__empty-icon" aria-hidden>
              <FlameSvg size={28} />
            </div>
            <p className="habits-obs__empty-title">Nenhum hábito ainda</p>
            <p className="habits-obs__empty-hint">
              Crie seu primeiro hábito para começar a rastrear rotinas diárias.
            </p>
            <button
              type="button"
              className="habits-obs__new"
              onClick={() => setShowNew(true)}
            >
              <span aria-hidden>+</span>
              <span>Novo hábito</span>
            </button>
          </div>
        ) : (
          <div className="habits-grid">
            <div className="habits-grid__row habits-grid__head">
              <span className="habits-grid__head-label">HÁBITO</span>
              <div className="habits-grid__days">
                {WEEKDAY_LETTERS.map((letter, i) => (
                  <span
                    key={i}
                    className={`habits-grid__day-letter${
                      i === 6 ? ' habits-grid__day-letter--accent' : ''
                    }`}
                  >
                    {letter}
                  </span>
                ))}
              </div>
              <span
                className="habits-grid__head-label"
                style={{ width: 54, textAlign: 'right' }}
              >
                SEQ.
              </span>
            </div>

            {habits.map((habit) => {
              const done = weekLogs[habit.id];
              const hot = habit.current_streak > 0;
              return (
                <div className="habits-grid__row" key={habit.id}>
                  <button
                    type="button"
                    className="habits-grid__name"
                    onClick={() => setDetailHabit(habit)}
                    title={habit.title}
                  >
                    <span
                      className="habits-grid__icon"
                      style={{ color: habit.color || 'var(--text-dim)' }}
                      aria-hidden
                    >
                      {habitIcon(habit.icon, 16)}
                    </span>
                    <span className="habits-grid__name-text">{habit.title}</span>
                  </button>

                  <div className="habits-grid__days">
                    {weekDates.map((date) => {
                      const iso = isoDate(date);
                      const isDone = done?.has(iso) ?? false;
                      const isFuture = iso > todayIso;
                      const cellKey = `${habit.id}:${iso}`;
                      return (
                        <button
                          type="button"
                          key={iso}
                          className={`habits-grid__cell${
                            isDone ? ' habits-grid__cell--done' : ''
                          }${isFuture ? ' habits-grid__cell--future' : ''}`}
                          disabled={isFuture || busyCell === cellKey}
                          onClick={() => void handleToggleDate(habit, iso)}
                          aria-pressed={isDone}
                          aria-label={`${habit.title} — ${iso}${
                            isDone ? ' concluído' : ''
                          }`}
                        >
                          {isDone && <CheckSvg size={13} />}
                        </button>
                      );
                    })}
                  </div>

                  <span
                    className={`habits-grid__seq${hot ? ' habits-grid__seq--hot' : ''}`}
                  >
                    <FlameSvg size={13} />
                    {habit.current_streak}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showNew && (
        <HabitEditorModal
          busy={newBusy}
          onClose={() => setShowNew(false)}
          onSubmit={(v) => void handleCreate(v)}
        />
      )}

      {editHabit && (
        <HabitEditorModal
          habit={editHabit}
          busy={editBusy}
          onClose={() => setEditHabit(null)}
          onSubmit={(v) => void handleUpdate(v)}
          onDelete={() => void handleDelete(editHabit.id)}
        />
      )}

      {detailHabit && !editHabit && (
        <HabitDetailModal
          habit={detailHabit}
          busy={editBusy}
          onClose={() => setDetailHabit(null)}
          onEdit={() => setEditHabit(detailHabit)}
          onDelete={() => void handleDelete(detailHabit.id)}
        />
      )}
    </div>
  );
}
