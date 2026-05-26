import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, TimerIcon, RefreshIcon } from '../icons/Icons';
import { fetchFocusStats, fetchTopApps } from './api';
import type { FocusStats, FocusDayStat, FocusAppEntry } from './types';

type Period = 'week' | 'month';

interface FocusAnalyticsProps {
  onBack: () => void;
}

/* ------------------------------------------------------------------ */
/*  Utility helpers                                                    */
/* ------------------------------------------------------------------ */

function formatMin(min: number): string {
  if (min < 60) return `${Math.round(min)}min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return formatMin(sec / 60);
}

function pct(v: number, max: number): number {
  return max > 0 ? (v / max) * 100 : 0;
}

/** Date range strings for the period. */
function periodRange(period: Period): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const d = new Date(now);
  d.setDate(d.getDate() - (period === 'week' ? 6 : 29));
  const start = d.toISOString().slice(0, 10);
  return { start, end };
}

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="focus-analytics__stat">
      <div className="focus-analytics__stat-value">{value}</div>
      <div className="focus-analytics__stat-label">{label}</div>
      {sub && <div className="focus-analytics__stat-sub">{sub}</div>}
    </div>
  );
}

function ByDayChart({ days, period }: { days: FocusDayStat[]; period: Period }) {
  const maxMin = useMemo(
    () => Math.max(1, ...days.map((d) => d.focus_min)),
    [days],
  );

  // For week: show all 7 days. For month: show all days.
  const barWidth = period === 'week' ? 32 : Math.max(6, Math.floor(300 / days.length));
  const chartH = 120;

  return (
    <div className="focus-analytics__chart-card">
      <h3 className="focus-analytics__chart-title">Foco por dia</h3>
      <div className="focus-analytics__bar-chart" style={{ overflowX: period === 'month' ? 'auto' : undefined }}>
        <svg
          width={Math.max(300, days.length * (barWidth + 4))}
          height={chartH + 24}
          style={{ display: 'block' }}
        >
          {days.map((d, i) => {
            const x = i * (barWidth + 4) + 2;
            const h = (d.focus_min / maxMin) * chartH;
            const dateObj = new Date(d.date + 'T12:00:00');
            const dayLabel = DAY_LABELS_PT[dateObj.getDay()];
            const dd = d.date.slice(8);
            return (
              <g key={d.date}>
                <title>
                  {d.date}: {formatMin(d.focus_min)} - {d.completed} completas, {d.cancelled} canceladas
                </title>
                {/* Completed portion */}
                <rect
                  x={x}
                  y={chartH - h}
                  width={barWidth}
                  height={Math.max(0, h * (d.completed / Math.max(1, d.completed + d.cancelled)))}
                  rx={3}
                  fill="var(--accent)"
                  opacity={0.85}
                />
                {/* Cancelled portion stacked on top */}
                {d.cancelled > 0 && (
                  <rect
                    x={x}
                    y={chartH - h + h * (d.completed / Math.max(1, d.completed + d.cancelled))}
                    width={barWidth}
                    height={h * (d.cancelled / Math.max(1, d.completed + d.cancelled))}
                    rx={3}
                    fill="var(--text-faint)"
                    opacity={0.5}
                  />
                )}
                {/* Full height background for empty days */}
                {d.focus_min === 0 && (
                  <rect
                    x={x}
                    y={chartH - 3}
                    width={barWidth}
                    height={3}
                    rx={1.5}
                    fill="var(--border-strong)"
                  />
                )}
                <text
                  x={x + barWidth / 2}
                  y={chartH + 14}
                  textAnchor="middle"
                  fill="var(--text-faint)"
                  fontSize={period === 'week' ? 10 : 8}
                >
                  {period === 'week' ? dayLabel : dd}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function TopAppsChart({ apps }: { apps: FocusAppEntry[] }) {
  const maxSec = useMemo(
    () => Math.max(1, ...apps.map((a) => a.total_sec)),
    [apps],
  );

  if (apps.length === 0) {
    return (
      <div className="focus-analytics__chart-card">
        <h3 className="focus-analytics__chart-title">Top apps durante foco</h3>
        <div className="focus-analytics__empty-hint">Nenhum dado de app registrado</div>
      </div>
    );
  }

  return (
    <div className="focus-analytics__chart-card">
      <h3 className="focus-analytics__chart-title">Top apps durante foco</h3>
      <div className="focus-analytics__hbar-list">
        {apps.slice(0, 10).map((app) => (
          <div key={app.app_name} className="focus-analytics__hbar-row">
            <span className="focus-analytics__hbar-label">{app.app_name}</span>
            <div className="focus-analytics__hbar-track">
              <div
                className="focus-analytics__hbar-fill"
                style={{ width: `${pct(app.total_sec, maxSec)}%` }}
              />
            </div>
            <span className="focus-analytics__hbar-value">{formatSec(app.total_sec)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WeeklyHeatmap({ days }: { days: FocusDayStat[] }) {
  // Build a 7-column grid (Seg-Dom) from the by_day data.
  // Fill missing days with zeros.
  const maxMin = useMemo(
    () => Math.max(1, ...days.map((d) => d.focus_min)),
    [days],
  );

  // Group days into weeks (rows) with 7 columns (Mon=0 .. Sun=6).
  const grid = useMemo(() => {
    if (days.length === 0) return [];
    const map = new Map<string, FocusDayStat>();
    for (const d of days) map.set(d.date, d);

    // Find first Monday on or before the first day
    const first = new Date(days[0].date + 'T12:00:00');
    const lastDate = new Date(days[days.length - 1].date + 'T12:00:00');
    const dayOfWeek = first.getDay();
    const mondayOff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(first);
    monday.setDate(first.getDate() - mondayOff);

    const rows: { date: string; min: number }[][] = [];
    const cursor = new Date(monday);
    let row: { date: string; min: number }[] = [];

    while (cursor <= lastDate || row.length > 0) {
      const iso = cursor.toISOString().slice(0, 10);
      const stat = map.get(iso);
      row.push({ date: iso, min: stat?.focus_min ?? 0 });
      if (row.length === 7) {
        rows.push(row);
        row = [];
      }
      cursor.setDate(cursor.getDate() + 1);
      if (cursor > lastDate && row.length === 0) break;
    }
    if (row.length > 0) {
      while (row.length < 7) row.push({ date: '', min: 0 });
      rows.push(row);
    }
    return rows;
  }, [days]);

  const colLabels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];

  function cellColor(min: number): string {
    if (min === 0) return 'rgba(255,255,255,0.04)';
    const intensity = Math.min(1, min / maxMin);
    // Purple gradient from dim to bright
    const alpha = 0.15 + intensity * 0.7;
    return `rgba(167, 139, 250, ${alpha.toFixed(2)})`;
  }

  return (
    <div className="focus-analytics__chart-card">
      <h3 className="focus-analytics__chart-title">Mapa semanal</h3>
      <div className="focus-analytics__heatmap">
        <div className="focus-analytics__heatmap-header">
          {colLabels.map((l) => (
            <span key={l} className="focus-analytics__heatmap-col">{l}</span>
          ))}
        </div>
        {grid.map((row, ri) => (
          <div key={ri} className="focus-analytics__heatmap-row">
            {row.map((cell, ci) => (
              <div
                key={ci}
                className="focus-analytics__heatmap-cell"
                style={{ background: cellColor(cell.min) }}
                title={cell.date ? `${cell.date}: ${formatMin(cell.min)}` : ''}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function FocusAnalytics({ onBack }: FocusAnalyticsProps): JSX.Element {
  const [period, setPeriod] = useState<Period>('week');
  const [stats, setStats] = useState<FocusStats | null>(null);
  const [apps, setApps] = useState<FocusAppEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: Period): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const range = periodRange(p);
      const [statsData, appsData] = await Promise.all([
        fetchFocusStats(p),
        fetchTopApps(range.start, range.end),
      ]);
      setStats(statsData);
      setApps(appsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [period, load]);

  const handleRefresh = useCallback(() => {
    void load(period);
  }, [period, load]);

  const hours = stats ? (stats.total_focus_min / 60).toFixed(1) : '--';
  const completedLabel = stats ? String(stats.completed_sessions) : '--';
  const streakLabel = stats ? `${stats.streak_days} dia${stats.streak_days !== 1 ? 's' : ''}` : '--';
  const interruptionLabel = stats
    ? `${(stats.interruption_rate * 100).toFixed(0)}%`
    : '--';

  return (
    <div className="tasks-view focus-analytics">
      {/* Header — reuses memory-view__header pattern */}
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
            <TimerIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Focus Analytics</h2>
            <p className="memory-view__subtitle">
              Acompanhe sua produtividade e sessoes de foco
            </p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button
            type="button"
            className="tasks-view__new-btn"
            onClick={handleRefresh}
            disabled={loading}
          >
            <RefreshIcon size={16} />
            <span>{loading ? 'Carregando...' : 'Atualizar'}</span>
          </button>
        </div>
      </div>

      {/* Period toggle */}
      <div className="insights-view__filters">
        {(['week', 'month'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`insights-view__chip${period === p ? ' insights-view__chip--active' : ''}`}
            onClick={() => setPeriod(p)}
          >
            {p === 'week' ? 'Semana' : 'Mes'}
          </button>
        ))}
        {loading && (
          <span className="calendar-view__loading">carregando...</span>
        )}
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      {/* Body */}
      <div className="focus-analytics__body">
        {/* Stats cards */}
        <div className="focus-analytics__stats">
          <StatCard
            label="Horas de foco"
            value={`${hours}h`}
            sub={stats ? `${stats.total_focus_min} min total` : undefined}
          />
          <StatCard
            label="Sessoes completas"
            value={completedLabel}
            sub={stats ? `${stats.cancelled_sessions} canceladas` : undefined}
          />
          <StatCard label="Streak" value={streakLabel} />
          <StatCard label="Taxa de interrupcao" value={interruptionLabel} />
        </div>

        {/* By-day bar chart */}
        {stats && stats.by_day.length > 0 && (
          <ByDayChart days={stats.by_day} period={period} />
        )}

        {/* Weekly heatmap */}
        {stats && stats.by_day.length > 0 && (
          <WeeklyHeatmap days={stats.by_day} />
        )}

        {/* Top apps */}
        <TopAppsChart apps={apps} />

        {/* Empty state */}
        {!loading && stats && stats.total_focus_min === 0 && (
          <div className="habits-view__empty">
            <div className="habits-view__empty-icon">
              <TimerIcon size={32} />
            </div>
            <p className="habits-view__empty-title">Nenhuma sessao de foco registrada</p>
            <p className="habits-view__empty-hint">
              Use o timer de foco na barra superior para comecar a registrar
              suas sessoes de produtividade.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
