import { useEffect, useRef, useState } from 'react';
import { FlagIcon } from '../icons/Icons';
import { getGoalSummary } from './api';
import type { GoalSummary } from './types';

const REFRESH_MS = 5 * 60 * 1000;

interface GoalsSummaryWidgetProps {
  onNavigate: () => void;
}

/** SVG progress ring for the goal completion ratio. */
function ProgressRing({
  progress,
  size = 48,
  stroke = 4,
}: {
  progress: number;
  size?: number;
  stroke?: number;
}): JSX.Element {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(progress, 100) / 100);

  return (
    <svg
      className="goals-widget__ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function GoalsSummaryWidget({ onNavigate }: GoalsSummaryWidgetProps): JSX.Element {
  const [data, setData] = useState<GoalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const summary = await getGoalSummary();
        if (!cancelled && mountedRef.current) {
          setData(summary);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const total = data?.total_active ?? 0;
  const completed = data?.goals_completed ?? 0;
  const progress = total + completed > 0
    ? Math.round((completed / (total + completed)) * 100)
    : 0;

  return (
    <button type="button" className="goals-widget" onClick={onNavigate}>
      <div className="goals-widget__header">
        <span className="goals-widget__title">
          <FlagIcon size={16} />
          Objetivos
        </span>
      </div>

      {loading ? (
        <div className="goals-widget__empty">Carregando...</div>
      ) : data ? (
        <div className="goals-widget__body">
          <ProgressRing progress={progress} />
          <div className="goals-widget__stats">
            <span className="goals-widget__stat">
              {data.total_active} ativo{data.total_active !== 1 ? 's' : ''}
            </span>
            {data.goals_at_risk > 0 && (
              <span className="goals-widget__stat goals-widget__stat--risk">
                {data.goals_at_risk} em risco
              </span>
            )}
            {data.goals_on_track > 0 && (
              <span className="goals-widget__stat goals-widget__stat--ok">
                {data.goals_on_track} no caminho
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="goals-widget__empty">Sem dados</div>
      )}
    </button>
  );
}
