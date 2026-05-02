import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  LightbulbIcon,
} from '../icons/Icons';
import { dismissInsight, listInsights } from './api';
import type { Insight, InsightSeverity } from './types';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WIDGET_ITEMS = 2;

const SEVERITY_COLOR: Record<InsightSeverity, string> = {
  warning: '#f59e0b',
  positive: '#4ade80',
  info: '#22d3ee',
};

function severityIcon(severity: InsightSeverity, size = 16): JSX.Element {
  switch (severity) {
    case 'warning':
      return <AlertTriangleIcon size={size} />;
    case 'positive':
      return <CheckCircleIcon size={size} />;
    case 'info':
    default:
      return <LightbulbIcon size={size} />;
  }
}

export interface InsightsDashboardWidgetProps {
  /** Called when the user clicks "Ver todos". */
  onNavigate?: () => void;
}

export function InsightsDashboardWidget({
  onNavigate,
}: InsightsDashboardWidgetProps): JSX.Element {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await listInsights();
      if (!mountedRef.current) return;
      setInsights(data);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // Don't crash — surface nothing visually beyond the empty state so the
      // dashboard keeps rendering even when the backend is down.
      setInsights([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleDismiss = useCallback(
    async (id: string): Promise<void> => {
      // Snapshot prev inside the functional setter so the callback
      // identity stays stable across fetches; otherwise every refresh
      // would invalidate every InsightCard's onDismiss prop ref.
      let previous: Insight[] = [];
      setInsights((prev) => {
        previous = prev;
        return prev.filter((i) => i.id !== id);
      });
      try {
        await dismissInsight(id);
      } catch {
        if (mountedRef.current) setInsights(previous);
      }
    },
    [],
  );

  const active = insights.filter((i) => !i.dismissed);
  const shown = active.slice(0, MAX_WIDGET_ITEMS);

  return (
    <div className="insights-widget">
      <div className="insights-widget__header">
        <span className="insights-widget__title">
          <LightbulbIcon size={16} />
          Insights
        </span>
        {active.length > 0 && (
          <button
            type="button"
            className="insights-widget__link"
            onClick={onNavigate}
          >
            Ver todos ({active.length})
          </button>
        )}
      </div>

      {!loaded ? (
        <div className="insights-widget__loading">Carregando...</div>
      ) : shown.length === 0 ? (
        <div className="insights-widget__empty">
          <div className="insights-widget__empty-icon" aria-hidden>
            <LightbulbIcon size={24} />
          </div>
          <p className="insights-widget__empty-text">Nenhum insight novo</p>
          {error && (
            <p className="insights-widget__empty-hint" title={error}>
              Aguardando dados do backend
            </p>
          )}
        </div>
      ) : (
        <ul className="insights-widget__list">
          {shown.map((insight) => {
            const color = SEVERITY_COLOR[insight.severity] ?? SEVERITY_COLOR.info;
            return (
              <li
                key={insight.id}
                className="insights-widget__item"
                style={{ borderLeftColor: color }}
              >
                <span
                  className="insights-widget__icon"
                  style={{ background: `${color}22`, color }}
                  aria-hidden
                >
                  {severityIcon(insight.severity, 14)}
                </span>
                <div className="insights-widget__body">
                  <div className="insights-widget__item-title">{insight.title}</div>
                  <p className="insights-widget__item-desc">{insight.description}</p>
                </div>
                <button
                  type="button"
                  className="insights-widget__dismiss"
                  onClick={() => void handleDismiss(insight.id)}
                  title="Dispensar"
                  aria-label="Dispensar insight"
                >
                  &times;
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
