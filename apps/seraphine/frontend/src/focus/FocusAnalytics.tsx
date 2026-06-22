import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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

/** pt-BR decimal (8.7 -> "8,7"). */
function hoursLabel(min: number): string {
  return (min / 60).toFixed(1).replace('.', ',');
}

function pct(v: number, max: number): number {
  return max > 0 ? (v / max) * 100 : 0;
}

function periodRange(period: Period): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const d = new Date(now);
  d.setDate(d.getDate() - (period === 'week' ? 6 : 29));
  const start = d.toISOString().slice(0, 10);
  return { start, end };
}

const DAY_SHORT_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const DAY_FULL_PT = [
  'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado',
];

function dayOf(dateIso: string): number {
  return new Date(dateIso + 'T12:00:00').getDay();
}

/* ------------------------------------------------------------------ */
/*  Hero — single gradient metric + sparkline (peak dot only)          */
/* ------------------------------------------------------------------ */

function HeroSparkline({ days }: { days: FocusDayStat[] }) {
  const W = 520;
  const H = 70;
  const pad = 4;
  const vals = days.map((d) => d.focus_min);
  const max = Math.max(1, ...vals);
  const peakIdx = vals.indexOf(max);
  const step = vals.length > 1 ? (W - pad * 2) / (vals.length - 1) : 0;
  const pts = vals.map((v, i) => [pad + i * step, H - pad - (v / max) * (H - pad * 2)] as const);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H} L ${pts[0][0].toFixed(1)} ${H} Z`;

  return (
    <svg
      className="fa-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={70}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="fa-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.34" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#fa-spark-grad)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      {pts[peakIdx] && (
        <circle
          cx={pts[peakIdx][0].toFixed(1)}
          cy={pts[peakIdx][1].toFixed(1)}
          r={3.4}
          fill="var(--accent-hi)"
          stroke="var(--bg-0)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Mini stat cards (neutral — no gradient)                            */
/* ------------------------------------------------------------------ */

function MiniStat({
  label, value, unit, sub, subTone, corner,
}: {
  label: ReactNode;
  value: string;
  unit?: string;
  sub?: string;
  subTone?: 'pos' | 'dim';
  corner?: ReactNode;
}) {
  return (
    <div className="fa-mini">
      {corner}
      <div className="fa-mini-label">{label}</div>
      <div className="fa-mini-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub && <div className={`fa-mini-sub${subTone === 'pos' ? ' fa-mini-sub--pos' : ''}`}>{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  By-day bar chart (avg reference line + stacked done/cancelled)     */
/* ------------------------------------------------------------------ */

function ByDayChart({ days, period, avgPerDay }: { days: FocusDayStat[]; period: Period; avgPerDay: number }) {
  const W = 700;
  const H = 200;
  const top = 20;
  const bottom = 34;
  const edge = 4;
  const plotH = H - top - bottom;
  const max = useMemo(() => Math.max(1, avgPerDay, ...days.map((d) => d.focus_min)), [days, avgPerDay]);
  const n = days.length;
  const slot = (W - edge * 2) / n;
  const bw = Math.min(46, slot * 0.52);
  const avgY = top + plotH - (avgPerDay / max) * plotH;

  return (
    <div className="focus-analytics__chart-card">
      <div className="fa-chart-head">
        <h3 className="focus-analytics__chart-title">Foco por dia</h3>
        <span className="fa-chart-note">média de <b>{formatMin(avgPerDay)}/dia</b></span>
      </div>
      <div className="fa-bars">
        <svg role="img" aria-label="Minutos de foco por dia no período" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="fa-bar-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent-hi)" />
              <stop offset="1" stopColor="var(--accent-dim)" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((t) => {
            const y = top + plotH - t * plotH;
            return <line key={t} x1={edge} y1={y} x2={W - edge} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />;
          })}
          <line x1={edge} y1={avgY} x2={W - edge} y2={avgY} stroke="var(--accent)" strokeWidth={1.3} strokeDasharray="5 5" opacity={0.6} />
          {days.map((d, i) => {
            const cx = edge + slot * i + slot / 2;
            const x = cx - bw / 2;
            const total = d.completed + d.cancelled || 1;
            const fullH = (d.focus_min / max) * plotH;
            const doneH = fullH * (d.completed / total);
            const cancH = fullH * (d.cancelled / total);
            const yDone = top + plotH - fullH;
            const label = period === 'week' ? DAY_SHORT_PT[dayOf(d.date)] : d.date.slice(8);
            return (
              <g key={d.date} className="fa-bar">
                <title>{`${d.date}: ${formatMin(d.focus_min)} — ${d.completed} completas, ${d.cancelled} canceladas`}</title>
                {d.focus_min === 0 ? (
                  <rect x={x} y={top + plotH - 3} width={bw} height={3} rx={1.5} fill="rgba(255,255,255,0.12)" />
                ) : (
                  <>
                    <rect className="fa-bar-fill" x={x} y={yDone} width={bw} height={doneH} rx={5} fill="url(#fa-bar-grad)" />
                    {d.cancelled > 0 && (
                      <rect x={x} y={yDone + doneH} width={bw} height={cancH} rx={3} fill="rgba(95,94,107,0.55)" />
                    )}
                  </>
                )}
                <text className="fa-bar-val" x={cx} y={yDone - 7} textAnchor="middle">{formatMin(d.focus_min)}</text>
                <text className="fa-bar-day" x={cx} y={H - 12} textAnchor="middle" fontSize={period === 'week' ? 11 : 9}>{label}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Consistency heatmap                                                */
/* ------------------------------------------------------------------ */

function ConsistencyHeatmap({ days }: { days: FocusDayStat[] }) {
  const max = useMemo(() => Math.max(1, ...days.map((d) => d.focus_min)), [days]);

  const grid = useMemo(() => {
    if (days.length === 0) return [];
    const map = new Map<string, FocusDayStat>();
    for (const d of days) map.set(d.date, d);
    const first = new Date(days[0].date + 'T12:00:00');
    const lastDate = new Date(days[days.length - 1].date + 'T12:00:00');
    const dow = first.getDay();
    const mondayOff = dow === 0 ? 6 : dow - 1;
    const monday = new Date(first);
    monday.setDate(first.getDate() - mondayOff);
    const rows: { date: string; min: number }[][] = [];
    const cursor = new Date(monday);
    let row: { date: string; min: number }[] = [];
    while (cursor <= lastDate || row.length > 0) {
      const iso = cursor.toISOString().slice(0, 10);
      const stat = map.get(iso);
      row.push({ date: iso, min: stat?.focus_min ?? 0 });
      if (row.length === 7) { rows.push(row); row = []; }
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
    const t = Math.min(1, min / max);
    return `rgba(154, 147, 255, ${(0.18 + t * 0.72).toFixed(2)})`;
  }

  return (
    <div className="focus-analytics__chart-card">
      <h3 className="focus-analytics__chart-title">Mapa de consistência</h3>
      <div>
        <div className="fa-hm-head">
          {colLabels.map((l) => <span key={l} className="fa-hm-col">{l}</span>)}
        </div>
        <div role="img" aria-label="Mapa de consistência de foco por dia da semana">
          {grid.map((r, ri) => (
            <div key={ri} className="fa-hm-row">
              {r.map((cell, ci) => (
                <div
                  key={ci}
                  className="fa-hm-cell"
                  style={{ background: cellColor(cell.min) }}
                  title={cell.date ? `${cell.date}: ${formatMin(cell.min)}` : ''}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="fa-hm-legend">
          <span>menos</span>
          <span className="fa-hm-scale">
            <i style={{ background: 'rgba(255,255,255,0.04)' }} />
            <i style={{ background: 'rgba(154,147,255,0.25)' }} />
            <i style={{ background: 'rgba(154,147,255,0.45)' }} />
            <i style={{ background: 'rgba(154,147,255,0.68)' }} />
            <i style={{ background: 'rgba(154,147,255,0.9)' }} />
          </span>
          <span>mais</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Top apps — ranked, badge, % share, accent only on #1               */
/* ------------------------------------------------------------------ */

function TopAppsChart({ apps }: { apps: FocusAppEntry[] }) {
  const list = apps.slice(0, 10);
  const max = useMemo(() => Math.max(1, ...list.map((a) => a.total_sec)), [list]);
  const total = useMemo(() => list.reduce((s, a) => s + a.total_sec, 0), [list]);

  if (list.length === 0) {
    return (
      <div className="focus-analytics__chart-card">
        <h3 className="focus-analytics__chart-title">Top apps durante o foco</h3>
        <div className="fa-empty-hint">Nenhum dado de app registrado neste período.</div>
      </div>
    );
  }

  function initials(name: string): string {
    return name.replace(/[^A-Za-z0-9 ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  }

  return (
    <div className="focus-analytics__chart-card">
      <h3 className="focus-analytics__chart-title">Top apps durante o foco</h3>
      <div className="fa-apps">
        {list.map((app, i) => (
          <div key={app.app_name} className="fa-app-row">
            <div className="fa-app-rank">{i + 1}</div>
            <div className="fa-app-main">
              <div className="fa-app-name">
                <span className={`fa-app-badge${i === 0 ? ' fa-app-badge--lead' : ''}`}>{initials(app.app_name)}</span>
                <span>{app.app_name}</span>
              </div>
              <div className="fa-app-track">
                <div className={`fa-app-fill${i === 0 ? ' fa-app-fill--lead' : ''}`} style={{ width: `${pct(app.total_sec, max)}%` }} />
              </div>
            </div>
            <div className="fa-app-meta">
              <div className="fa-app-time">{formatSec(app.total_sec)}</div>
              <div className="fa-app-pct">{total > 0 ? Math.round((app.total_sec / total) * 100) : 0}%</div>
            </div>
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

  useEffect(() => { void load(period); }, [period, load]);
  const handleRefresh = useCallback(() => { void load(period); }, [period, load]);

  const days = stats?.by_day ?? [];
  const hasData = !!stats && stats.total_focus_min > 0 && days.length > 0;

  /* Derived (all from real data — no invented deltas). */
  const derived = useMemo(() => {
    if (!stats || days.length === 0) return null;
    const avgPerDay = stats.total_focus_min / days.length;
    const peak = days.reduce((a, b) => (b.focus_min > a.focus_min ? b : a), days[0]);
    const active = days.filter((d) => d.focus_min > 0);
    const weakest = active.length > 0 ? active.reduce((a, b) => (b.focus_min < a.focus_min ? b : a), active[0]) : null;
    return { avgPerDay, peak, weakest, activeDays: active.length };
  }, [stats, days]);

  const hours = stats ? hoursLabel(stats.total_focus_min) : '--';

  return (
    <div className="tasks-view focus-analytics">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button className="memory-view__back" onClick={onBack} type="button" aria-label="Voltar">
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <TimerIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Focus Analytics</h2>
            <p className="memory-view__subtitle">Acompanhe sua produtividade e sessões de foco</p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button type="button" className="tasks-view__new-btn" onClick={handleRefresh} disabled={loading}>
            <RefreshIcon size={16} />
            <span>{loading ? 'Carregando...' : 'Atualizar'}</span>
          </button>
        </div>
      </div>

      <div className="insights-view__filters" role="group" aria-label="Período do relatório">
        {(['week', 'month'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`insights-view__chip${period === p ? ' insights-view__chip--active' : ''}`}
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
          >
            {p === 'week' ? 'Semana' : 'Mês'}
          </button>
        ))}
        {loading && <span className="calendar-view__loading">carregando...</span>}
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      <div className="focus-analytics__body" aria-busy={loading}>
        {/* Hero + mini-stat cluster */}
        <section className="fa-hero-row">
          <div className="focus-analytics__chart-card fa-hero">
            <div className="focus-analytics__chart-title">Horas de foco</div>
            <div className="fa-hero-value">{hours}<small>h</small></div>
            <div className="fa-hero-meta">
              <b>{stats?.total_focus_min ?? 0}</b> min em <b>{stats?.completed_sessions ?? 0}</b> sessões
              {stats && stats.avg_session_min > 0 && <> · média de <b>{Math.round(stats.avg_session_min)}</b> min</>}
              {derived && derived.peak.focus_min > 0 && (
                <> · pico em <b>{DAY_FULL_PT[dayOf(derived.peak.date)]}</b></>
              )}
            </div>
            {hasData && <HeroSparkline days={days} />}
          </div>

          <div className="fa-mini-grid">
            <MiniStat
              label="Sessões completas"
              value={stats ? String(stats.completed_sessions) : '--'}
              sub={stats ? `${stats.cancelled_sessions} canceladas` : undefined}
            />
            <MiniStat
              label="Streak"
              value={stats ? String(stats.streak_days) : '--'}
              unit={stats ? (stats.streak_days === 1 ? 'dia' : 'dias') : undefined}
            />
            <MiniStat
              label="Taxa de interrupção"
              value={stats ? String(Math.round(stats.interruption_rate * 100)) : '--'}
              unit={stats ? '%' : undefined}
            />
            <MiniStat
              label="Sessão média"
              value={stats ? String(Math.round(stats.avg_session_min)) : '--'}
              unit={stats ? 'min' : undefined}
            />
          </div>
        </section>

        {hasData && derived && (
          <ByDayChart days={days} period={period} avgPerDay={derived.avgPerDay} />
        )}

        {hasData && (
          <section className="fa-two-col">
            <ConsistencyHeatmap days={days} />
            <TopAppsChart apps={apps} />
          </section>
        )}

        {/* Insight summary — derived from real data only */}
        {hasData && derived && derived.peak.focus_min > 0 && (
          <section className="focus-analytics__chart-card fa-insight">
            <div className="fa-insight-ico" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.9 4.6L18.5 9l-3.5 3.1.9 4.9L12 14.7 8.1 17l.9-4.9L5.5 9l4.6-1.4z" />
              </svg>
            </div>
            <p className="fa-insight-body">
              Seu pico foi em <b>{DAY_FULL_PT[dayOf(derived.peak.date)]}</b>, com{' '}
              <span className="fa-hl">{formatMin(derived.peak.focus_min)}</span> de foco.
              {stats && stats.streak_days > 0 && <> Você mantém um <b>streak de {stats.streak_days} {stats.streak_days === 1 ? 'dia' : 'dias'}</b>.</>}
              {derived.weakest && derived.weakest.date !== derived.peak.date && (
                <> O dia mais fraco foi <b>{DAY_FULL_PT[dayOf(derived.weakest.date)]}</b>, com apenas{' '}
                  <span className="fa-hl">{formatMin(derived.weakest.focus_min)}</span>.</>
              )}
            </p>
          </section>
        )}

        {/* Empty state */}
        {!loading && stats && stats.total_focus_min === 0 && (
          <div className="habits-view__empty">
            <div className="habits-view__empty-icon">
              <TimerIcon size={32} />
            </div>
            <p className="habits-view__empty-title">Nenhuma sessão de foco registrada</p>
            <p className="habits-view__empty-hint">
              Use o timer de foco na barra superior para começar a registrar suas sessões de produtividade.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
