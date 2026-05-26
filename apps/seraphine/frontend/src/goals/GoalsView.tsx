import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, FlagIcon } from '../icons/Icons';
import './goals.css';
import { GoalProgressBar } from './GoalProgressBar';
import { GoalEditorModal, type GoalEditorValue } from './GoalEditorModal';
import { GoalDetailPanel } from './GoalDetailPanel';
import { createGoal, getGoalSummary, listGoals } from './api';
import type { Goal, GoalArea, GoalSummary } from './types';
import {
  AREA_LABELS,
  AREA_COLORS,
  ALL_AREAS,
  TIMEFRAME_LABELS,
} from './types';

interface GoalsViewProps {
  onBack: () => void;
}

type StatusFilter = 'active' | 'paused' | 'completed' | 'all';

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Ativos' },
  { value: 'paused', label: 'Pausados' },
  { value: 'completed', label: 'Concluidos' },
  { value: 'all', label: 'Todos' },
];

function daysRemaining(endDate: string | null): number | null {
  if (!endDate) return null;
  return Math.ceil(
    (new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
}

export function GoalsView({ onBack }: GoalsViewProps): JSX.Element {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [summary, setSummary] = useState<GoalSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [areaFilter, setAreaFilter] = useState<GoalArea | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const [showNew, setShowNew] = useState(false);
  const [newBusy, setNewBusy] = useState(false);

  const [detailGoalId, setDetailGoalId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [goalsList, sum] = await Promise.all([
        listGoals(
          areaFilter || undefined,
          statusFilter !== 'all' ? statusFilter : undefined,
        ),
        getGoalSummary(),
      ]);
      setGoals(goalsList);
      setSummary(sum);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [areaFilter, statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh on visibility change
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const handleCreate = useCallback(
    async (value: GoalEditorValue) => {
      setNewBusy(true);
      try {
        await createGoal({
          title: value.title,
          description: value.description || null,
          area: value.area,
          timeframe: value.timeframe,
          start_date: value.start_date || null,
          end_date: value.end_date || null,
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

  // Sorted goals: completed at the bottom
  const sortedGoals = useMemo(() => {
    return [...goals].sort((a, b) => {
      if (a.status === 'completed' && b.status !== 'completed') return 1;
      if (a.status !== 'completed' && b.status === 'completed') return -1;
      return 0;
    });
  }, [goals]);

  // If a detail panel is open, show it instead of the list
  if (detailGoalId) {
    return (
      <GoalDetailPanel
        goalId={detailGoalId}
        onBack={() => setDetailGoalId(null)}
        onDeleted={() => {
          setDetailGoalId(null);
          void refresh();
        }}
        onUpdated={() => void refresh()}
      />
    );
  }

  return (
    <div className="tasks-view goals-view">
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
            <FlagIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Objetivos</h2>
            <p className="memory-view__subtitle">
              Defina metas e acompanhe resultados-chave
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
            <span>Novo objetivo</span>
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {summary && (
        <div className="tasks-view__summary goals-view__summary">
          <div className="tasks-summary-pill">
            <span className="tasks-summary-pill__value goals-view__pill--danger">
              {summary.goals_at_risk}
            </span>
            <span className="tasks-summary-pill__label">em risco</span>
          </div>
          <div className="tasks-summary-pill">
            <span className="tasks-summary-pill__value goals-view__pill--accent">
              {summary.goals_on_track}
            </span>
            <span className="tasks-summary-pill__label">no caminho</span>
          </div>
          <div className="tasks-summary-pill">
            <span className="tasks-summary-pill__value goals-view__pill--success">
              {summary.goals_completed}
            </span>
            <span className="tasks-summary-pill__label">concluidos</span>
          </div>
          <div className="tasks-summary-pill">
            <span className="tasks-summary-pill__value">
              {summary.total_active}
            </span>
            <span className="tasks-summary-pill__label">total</span>
          </div>
          {loading && <span className="calendar-view__loading">atualizando...</span>}
        </div>
      )}

      {/* Filters */}
      <div className="goals-view__filters">
        <div className="goals-view__filter-group">
          <button
            type="button"
            className={`goals-view__filter-chip${areaFilter === null ? ' goals-view__filter-chip--active' : ''}`}
            onClick={() => setAreaFilter(null)}
          >
            Todos
          </button>
          {ALL_AREAS.map((a) => (
            <button
              key={a}
              type="button"
              className={`goals-view__filter-chip${areaFilter === a ? ' goals-view__filter-chip--active' : ''}`}
              onClick={() => setAreaFilter(areaFilter === a ? null : a)}
              style={
                areaFilter === a
                  ? { background: `${AREA_COLORS[a]}22`, color: AREA_COLORS[a], borderColor: AREA_COLORS[a] }
                  : undefined
              }
            >
              {AREA_LABELS[a]}
            </button>
          ))}
        </div>
        <div className="goals-view__filter-group">
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`goals-view__filter-chip${statusFilter === opt.value ? ' goals-view__filter-chip--active' : ''}`}
              onClick={() => setStatusFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      <div className="goals-view__body">
        {sortedGoals.length === 0 && !loading ? (
          <div className="habits-view__empty">
            <div className="habits-view__empty-icon">
              <FlagIcon size={32} />
            </div>
            <p className="habits-view__empty-title">Nenhum objetivo encontrado</p>
            <p className="habits-view__empty-hint">
              Crie seu primeiro objetivo para comecar a rastrear metas e resultados-chave.
            </p>
            <button
              type="button"
              className="tasks-view__new-btn"
              onClick={() => setShowNew(true)}
            >
              <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
              <span>Novo objetivo</span>
            </button>
          </div>
        ) : (
          <div className="goals-view__grid">
            {sortedGoals.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                onClick={() => setDetailGoalId(goal.id)}
              />
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <GoalEditorModal
          busy={newBusy}
          onClose={() => setShowNew(false)}
          onSubmit={(v) => void handleCreate(v)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  GoalCard sub-component                                             */
/* ------------------------------------------------------------------ */

function GoalCard({
  goal,
  onClick,
}: {
  goal: Goal;
  onClick: () => void;
}): JSX.Element {
  const days = daysRemaining(goal.end_date);

  return (
    <button
      type="button"
      className="goal-card"
      onClick={onClick}
      style={{ borderLeftColor: AREA_COLORS[goal.area] }}
    >
      <div className="goal-card__top">
        <h3 className="goal-card__title">{goal.title}</h3>
        <div className="goal-card__badges">
          <span
            className="goal-card__area-badge"
            style={{
              background: `${AREA_COLORS[goal.area]}22`,
              color: AREA_COLORS[goal.area],
              borderColor: `${AREA_COLORS[goal.area]}44`,
            }}
          >
            {AREA_LABELS[goal.area]}
          </span>
          <span className="goal-card__timeframe-badge">
            {TIMEFRAME_LABELS[goal.timeframe]}
          </span>
        </div>
      </div>

      <GoalProgressBar progress={goal.progress} endDate={goal.end_date} />

      {days !== null && (
        <span
          className={`goal-card__days${days <= 0 ? ' goal-card__days--overdue' : days < 14 ? ' goal-card__days--warning' : ''}`}
        >
          {days > 0
            ? `${days} ${days === 1 ? 'dia restante' : 'dias restantes'}`
            : 'Prazo encerrado'}
        </span>
      )}
    </button>
  );
}
