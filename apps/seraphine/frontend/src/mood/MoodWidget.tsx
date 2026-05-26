import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { HeartIcon } from '../icons/Icons';
import { fetchMoodToday, fetchMoodTrend } from './api';
import { MoodCheckinModal } from './MoodCheckinModal';
import { MoodTrendChart } from './MoodTrendChart';
import type { MoodToday, MoodTrendDay } from './types';
import { MOOD_LABELS, moodColor } from './types';

const TREND_DAYS = 14;
const REFRESH_MS = 5 * 60 * 1000;

export function MoodWidget(): JSX.Element {
  const [today, setToday] = useState<MoodToday | null>(null);
  const [trend, setTrend] = useState<MoodTrendDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [todayData, trendData] = await Promise.all([
        fetchMoodToday(),
        fetchMoodTrend(TREND_DAYS),
      ]);
      if (!mountedRef.current) return;
      setToday(todayData);
      setTrend(trendData.days ?? []);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleCheckinDone = (): void => {
    setCheckinOpen(false);
    void refresh();
  };

  const currentLabel = today?.current?.label;
  const displayLabel = currentLabel
    ? MOOD_LABELS[currentLabel] ?? currentLabel
    : null;
  const dotColor = currentLabel ? moodColor(currentLabel) : undefined;

  // Mini SVG polyline for the header trend sparkline
  const miniW = 120;
  const miniH = 32;
  const miniPoints = (): string => {
    if (trend.length < 2) return '';
    const padX = 2;
    const padY = 4;
    const w = miniW - padX * 2;
    const h = miniH - padY * 2;
    return trend
      .map((d, i) => {
        const x = padX + (i / (trend.length - 1)) * w;
        const y = padY + h * (1 - (d.avg_valence + 1) / 2);
        return `${x},${y}`;
      })
      .join(' ');
  };

  return (
    <div className="mood-widget">
      <div className="mood-widget__header">
        <span className="mood-widget__title">
          <HeartIcon size={16} />
          Humor
        </span>
        {displayLabel && (
          <span className="mood-widget__current">
            <span
              className="mood-widget__current-dot"
              style={{ background: dotColor }}
              aria-hidden
            />
            {displayLabel}
          </span>
        )}
      </div>

      {loading ? (
        <div className="mood-widget__empty">Carregando...</div>
      ) : (
        <>
          {/* Today status */}
          {!today?.current && (
            <div className="mood-widget__no-log">Nenhum registro hoje</div>
          )}

          {/* Mini sparkline */}
          {trend.length >= 2 && (
            <div className="mood-widget__sparkline">
              <svg width={miniW} height={miniH} viewBox={`0 0 ${miniW} ${miniH}`}>
                <polyline
                  points={miniPoints()}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {trend.map((d, i) => {
                  const padX = 2;
                  const padY = 4;
                  const w = miniW - padX * 2;
                  const h = miniH - padY * 2;
                  const cx = padX + (i / (trend.length - 1)) * w;
                  const cy = padY + h * (1 - (d.avg_valence + 1) / 2);
                  return (
                    <circle
                      key={d.date}
                      cx={cx}
                      cy={cy}
                      r={2.5}
                      fill={moodColor(d.predominant_label)}
                    />
                  );
                })}
              </svg>
              <span className="mood-widget__sparkline-label">14 dias</span>
            </div>
          )}

          {/* Full trend chart (collapsed by default, visible if >0 data) */}
          {trend.length > 0 && (
            <div className="mood-widget__chart">
              <MoodTrendChart days={trend} width={320} height={140} />
            </div>
          )}

          {/* Check-in button */}
          <button
            type="button"
            className="mood-widget__checkin-btn"
            onClick={() => setCheckinOpen(true)}
          >
            Como voce esta?
          </button>
        </>
      )}

      {error && <div className="mood-widget__error">{error}</div>}

      <AnimatePresence>
        {checkinOpen && (
          <MoodCheckinModal
            onClose={() => setCheckinOpen(false)}
            onCheckinDone={handleCheckinDone}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
