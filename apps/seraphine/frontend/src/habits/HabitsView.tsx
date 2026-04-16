import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, FlameIcon } from '../icons/Icons';
import {
  createHabit,
  deleteHabit,
  listHabits,
  toggleHabit,
  updateHabit,
} from './api';
import { HabitCard } from './HabitCard';
import { HabitDetailModal } from './HabitDetailModal';
import { HabitEditorModal, type HabitEditorValue } from './HabitEditorModal';
import type { Habit, HabitWithStatus } from './types';

interface HabitsViewProps {
  onBack: () => void;
}

export function HabitsView({ onBack }: HabitsViewProps): JSX.Element {
  const [habits, setHabits] = useState<HabitWithStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [newBusy, setNewBusy] = useState(false);

  const [detailHabit, setDetailHabit] = useState<HabitWithStatus | null>(null);
  const [editHabit, setEditHabit] = useState<Habit | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [busyHabitId, setBusyHabitId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await listHabits();
      setHabits(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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
    const total = habits.length;
    const completed = habits.filter((h) => h.today_completed).length;
    let bestHabit: HabitWithStatus | null = null;
    for (const h of habits) {
      if (!bestHabit || h.current_streak > bestHabit.current_streak) bestHabit = h;
    }
    return { total, completed, bestHabit };
  }, [habits]);

  const handleToggle = useCallback(
    async (habit: HabitWithStatus): Promise<void> => {
      if (busyHabitId) return;
      setBusyHabitId(habit.id);
      // Optimistic update
      setHabits((prev) =>
        prev.map((h) =>
          h.id === habit.id
            ? {
                ...h,
                today_completed: !h.today_completed,
                current_streak: h.today_completed
                  ? Math.max(0, h.current_streak - 1)
                  : h.current_streak + 1,
              }
            : h,
        ),
      );
      try {
        const res = await toggleHabit(habit.id);
        setHabits((prev) =>
          prev.map((h) =>
            h.id === habit.id
              ? {
                  ...h,
                  today_completed: !!res.log?.completed,
                  current_streak: res.current_streak,
                }
              : h,
          ),
        );
        // Keep detail modal in sync if open.
        setDetailHabit((prev) =>
          prev && prev.id === habit.id
            ? {
                ...prev,
                today_completed: !!res.log?.completed,
                current_streak: res.current_streak,
              }
            : prev,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Roll back optimistic update by refetching.
        void refresh();
      } finally {
        setBusyHabitId(null);
      }
    },
    [busyHabitId, refresh],
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

  return (
    <div className="tasks-view habits-view">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button
            className="memory-view__back"
            onClick={onBack}
            type="button"
            aria-label="Voltar"
          >
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <FlameIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Habitos</h2>
            <p className="memory-view__subtitle">
              Rastreie rotinas diarias e mantenha sequencias
            </p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button
            type="button"
            className="tasks-view__new-btn"
            onClick={() => setShowNew(true)}
          >
            <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
            <span>Novo habito</span>
          </button>
        </div>
      </div>

      <div className="tasks-view__summary habits-view__stats">
        <div className="tasks-summary-pill">
          <span className="tasks-summary-pill__value">
            {stats.completed}/{stats.total}
          </span>
          <span className="tasks-summary-pill__label">hoje</span>
        </div>
        {stats.bestHabit && stats.bestHabit.current_streak > 0 && (
          <div className="tasks-summary-pill">
            <span className="tasks-summary-pill__value">
              {stats.bestHabit.current_streak}
            </span>
            <span className="tasks-summary-pill__label">
              melhor streak: {stats.bestHabit.title}
            </span>
          </div>
        )}
        {loading && <span className="calendar-view__loading">atualizando...</span>}
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      <div className="habits-view__body">
        {habits.length === 0 && !loading ? (
          <div className="habits-view__empty">
            <div className="habits-view__empty-icon">
              <FlameIcon size={32} />
            </div>
            <p className="habits-view__empty-title">Nenhum habito ainda</p>
            <p className="habits-view__empty-hint">
              Crie seu primeiro habito para comecar a rastrear rotinas diarias.
            </p>
            <button
              type="button"
              className="tasks-view__new-btn"
              onClick={() => setShowNew(true)}
            >
              <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
              <span>Novo habito</span>
            </button>
          </div>
        ) : (
          <div className="habits-view__grid">
            {habits.map((habit) => (
              <HabitCard
                key={habit.id}
                habit={habit}
                busy={busyHabitId === habit.id}
                onToggle={() => void handleToggle(habit)}
                onClick={() => setDetailHabit(habit)}
              />
            ))}
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
