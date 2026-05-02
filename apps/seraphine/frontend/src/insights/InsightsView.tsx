import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  LightbulbIcon,
  RefreshIcon,
} from '../icons/Icons';
import { dismissInsight, listInsights, refreshInsights } from './api';
import { InsightCard } from './InsightCard';
import type { Insight, InsightType } from './types';

type Filter = 'all' | InsightType;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'finance', label: 'Financas' },
  { id: 'tasks', label: 'Tarefas' },
  { id: 'habits', label: 'Habitos' },
  { id: 'productivity', label: 'Produtividade' },
];

interface InsightsViewProps {
  onBack: () => void;
}

export function InsightsView({ onBack }: InsightsViewProps): JSX.Element {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await listInsights();
      setInsights(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setInsights([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const data = await refreshInsights();
      setInsights(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const handleDismiss = useCallback(
    async (insight: Insight): Promise<void> => {
      // Capture previous state inside the functional setter so we don't
      // close over the `insights` array — the callback would otherwise
      // be recreated on every fetch and cascade fresh prop refs through
      // every InsightCard. Roll-back on failure restores the snapshot.
      let previous: Insight[] = [];
      setInsights((prev) => {
        previous = prev;
        return prev.filter((i) => i.id !== insight.id);
      });
      try {
        await dismissInsight(insight.id);
      } catch (e) {
        setInsights(previous);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const filtered = useMemo(() => {
    const active = insights.filter((i) => !i.dismissed);
    if (filter === 'all') return active;
    return active.filter((i) => i.type === filter);
  }, [insights, filter]);

  const grouped = useMemo(() => {
    const map = new Map<InsightType, Insight[]>();
    for (const insight of filtered) {
      const bucket = map.get(insight.type) ?? [];
      bucket.push(insight);
      map.set(insight.type, bucket);
    }
    // Stable order.
    const order: InsightType[] = ['finance', 'tasks', 'habits', 'productivity'];
    return order
      .filter((t) => map.has(t))
      .map((t) => ({ type: t, items: map.get(t) ?? [] }));
  }, [filtered]);

  return (
    <div className="tasks-view insights-view">
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
            <LightbulbIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Insights</h2>
            <p className="memory-view__subtitle">
              Padroes detectados nas suas tarefas, financas e habitos
            </p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button
            type="button"
            className="tasks-view__new-btn"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
          >
            <RefreshIcon size={16} />
            <span>{refreshing ? 'Atualizando...' : 'Atualizar'}</span>
          </button>
        </div>
      </div>

      <div className="insights-view__filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`insights-view__chip${filter === f.id ? ' insights-view__chip--active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        {loading && (
          <span className="calendar-view__loading">carregando...</span>
        )}
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      <div className="insights-view__body">
        {!loading && filtered.length === 0 ? (
          <div className="habits-view__empty">
            <div className="habits-view__empty-icon">
              <LightbulbIcon size={32} />
            </div>
            <p className="habits-view__empty-title">Nenhum insight no momento</p>
            <p className="habits-view__empty-hint">
              A Seraphine gera insights automaticamente conforme voce usa tarefas,
              financas e habitos. Volte mais tarde ou clique em Atualizar.
            </p>
            <button
              type="button"
              className="tasks-view__new-btn"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
            >
              <RefreshIcon size={16} />
              <span>{refreshing ? 'Atualizando...' : 'Atualizar agora'}</span>
            </button>
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.type} className="insights-view__group">
              <h3 className="insights-view__group-title">
                {filterLabel(group.type)}
                <span className="insights-view__group-count">{group.items.length}</span>
              </h3>
              <div className="insights-view__grid">
                {group.items.map((insight) => (
                  <InsightCard
                    key={insight.id}
                    insight={insight}
                    onDismiss={(i) => void handleDismiss(i)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function filterLabel(t: InsightType): string {
  const match = FILTERS.find((f) => f.id === t);
  return match ? match.label : t;
}
