import { useEffect, useRef, useState } from 'react';
import { TimerIcon } from '../icons/Icons';
import { fetchFocusStats } from './api';
import type { FocusStats, FocusDayStat } from './types';

const REFRESH_MS = 5 * 60 * 1000;

interface FocusSummaryWidgetProps {
  onNavigate: () => void;
}

/** Inline SVG sparkline for focus_min by day (last 7 days). */
function FocusSparkline({ days }: { days: FocusDayStat[] }): JSX.Element | null {
  if (days.length < 2) return null;

  const W = 120;
  const H = 32;
  const padX = 2;
  const padY = 4;
  const w = W - padX * 2;
  const h = H - padY * 2;
  const maxVal = Math.max(...days.map((d) => d.focus_min), 1);

  const points = days
    .map((d, i) => {
      const x = padX + (i / (days.length - 1)) * w;
      const y = padY + h * (1 - d.focus_min / maxVal);
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="focus-widget__sparkline">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {days.map((d, i) => {
          const cx = padX + (i / (days.length - 1)) * w;
          const cy = padY + h * (1 - d.focus_min / maxVal);
          return (
            <circle
              key={d.date}
              cx={cx}
              cy={cy}
              r={2.5}
              fill="var(--accent)"
            />
          );
        })}
      </svg>
      <span className="focus-widget__sparkline-label">7 dias</span>
    </div>
  );
}

export function FocusSummaryWidget({ onNavigate }: FocusSummaryWidgetProps): JSX.Element {
  const [stats, setStats] = useState<FocusStats | null>(null);
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
        const data = await fetchFocusStats('week');
        if (!cancelled && mountedRef.current) {
          setStats(data);
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

  // Today's focus from by_day array
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayDay = stats?.by_day?.find((d) => d.date === todayISO);
  const todayMin = todayDay?.focus_min ?? 0;
  const todayH = (todayMin / 60).toFixed(1);

  return (
    <button type="button" className="focus-widget" onClick={onNavigate}>
      <div className="focus-widget__header">
        <span className="focus-widget__title">
          <TimerIcon size={16} />
          Foco
        </span>
      </div>

      {loading ? (
        <div className="focus-widget__empty">Carregando...</div>
      ) : stats ? (
        <>
          <div className="focus-widget__stats">
            <span className="focus-widget__stat">
              {todayH}h foco hoje
            </span>
            <span className="focus-widget__stat">
              {stats.completed_sessions} sessoes
            </span>
            {stats.streak_days > 0 && (
              <span className="focus-widget__stat focus-widget__stat--streak">
                {stats.streak_days} dias de streak
              </span>
            )}
          </div>
          <FocusSparkline days={(stats.by_day ?? []).slice(-7)} />
        </>
      ) : (
        <div className="focus-widget__empty">Sem dados</div>
      )}
    </button>
  );
}
