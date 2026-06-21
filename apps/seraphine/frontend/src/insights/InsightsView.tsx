import './obsidian.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LightbulbIcon, SparkleIcon } from '../icons/Icons';
import {
  dismissInsight,
  getFocusStats,
  getTimeByCategory,
  getWeeklyReport,
  listInsights,
  refreshInsights,
} from './api';
import type {
  FocusStats,
  Insight,
  InsightSeverity,
  TimeByCategoryEntry,
  WeeklyReport,
} from './types';

// 'year' has no backing aggregation in the backend (no yearly tasks/focus
// rollup), so the period control is limited to the two periods /focus/stats
// actually supports.
type Period = 'week' | 'month';

const PERIODS: { id: Period; label: string }[] = [
  { id: 'week', label: 'Semana' },
  { id: 'month', label: 'Mês' },
];

// Weekday columns for the productivity bar chart. Heights are derived from
// real focus minutes per day (see `weeklyBars`). `todayIndex` highlights the
// current weekday (0 = Sunday … 6 = Saturday → mapped to Mon-first order).
const WEEK_LABELS = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];

const NOTICED_COLORS: Record<InsightSeverity, string> = {
  warning: '#ff8a4c',
  info: '#42a5f5',
  positive: '#4ade80',
};

// Stable color ramp for the "Onde foi seu tempo" category bars. Categories
// are assigned a color by their position in the (focus-minutes-desc) list,
// so the busiest category always reads as the strongest accent.
const CATEGORY_COLORS = [
  '#9a93ff',
  '#42a5f5',
  '#4ade80',
  '#ff8a4c',
  '#f472b6',
  '#fbbf24',
];

// Format a count of minutes as "14h20" (or "45min" when under an hour).
function formatFocusMinutes(min: number): string {
  if (min <= 0) return '0h';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}min`;
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// Map a weekly mood block (trend + valence) to a stat-card face/label/sub.
// Valence is roughly -1..1; we lean on the trend for the sub-copy and the
// best/worst day average for the face when present.
type MoodFace = 'happy' | 'neutral' | 'sad';

function moodFromReport(mood: WeeklyReport['mood']): {
  label: string;
  face: MoodFace;
  sub: string;
} | null {
  if (!mood || mood.total_logs == null || mood.total_logs === 0) return null;
  const avgs = mood.daily_avgs ?? [];
  let face: MoodFace = 'neutral';
  let label = 'Neutro';
  if (avgs.length > 0) {
    const mean = avgs.reduce((s, d) => s + d.avg_valence, 0) / avgs.length;
    if (mean > 0.3) {
      face = 'happy';
      label = 'Bem';
    } else if (mean < -0.3) {
      face = 'sad';
      label = 'Baixo';
    }
  }
  const trendSub: Record<string, string> = {
    subindo: 'em alta esta semana',
    caindo: 'em queda esta semana',
    estavel: 'estável esta semana',
  };
  const sub = trendSub[mood.trend ?? 'estavel'] ?? 'estável esta semana';
  return { label, face, sub };
}

interface InsightsViewProps {
  onBack: () => void;
}

export function InsightsView({ onBack: _onBack }: InsightsViewProps): JSX.Element {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [focusStats, setFocusStats] = useState<FocusStats | null>(null);
  const [timeByCategory, setTimeByCategory] = useState<TimeByCategoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('week');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [data, weekly] = await Promise.all([
        listInsights(),
        getWeeklyReport().catch(() => null),
      ]);
      setInsights(data);
      setReport(weekly);
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

  // Focus stats back the "Tempo de foco" card and the weekly productivity
  // bars; time-by-category backs the "Onde foi seu tempo" breakdown. Both
  // re-fetch when the period toggles (week ↔ month).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stats, byCat] = await Promise.all([
        getFocusStats(period).catch(() => null),
        getTimeByCategory(period).catch(() => null),
      ]);
      if (cancelled) return;
      setFocusStats(stats);
      setTimeByCategory(byCat?.categories ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const [data, weekly, stats, byCat] = await Promise.all([
        refreshInsights(),
        getWeeklyReport().catch(() => null),
        getFocusStats(period).catch(() => null),
        getTimeByCategory(period).catch(() => null),
      ]);
      setInsights(data);
      setReport(weekly);
      setFocusStats(stats);
      setTimeByCategory(byCat?.categories ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, period]);

  // Preserved dismiss flow (optimistic + rollback). Wired behind the
  // "Seraphine notou" items so the existing API contract stays exercised.
  const handleDismiss = useCallback(
    async (insight: Insight): Promise<void> => {
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

  const active = useMemo(
    () => insights.filter((i) => !i.dismissed),
    [insights],
  );

  // Top 3 active insights feed the "Seraphine notou" card. Falls back to
  // a neutral empty state when there are none (handled in render).
  const noticed = useMemo(() => active.slice(0, 3), [active]);

  // Real productivity bars: normalise per-day focus minutes (0-100% of the
  // week's busiest day) and map the by_day dates onto the Mon-first column
  // order. by_day is chronological (oldest → today) covering the last 7 days
  // for 'week'; we key by weekday so partial weeks land in the right column.
  const weeklyBars = useMemo<number[]>(() => {
    const days = focusStats?.by_day ?? [];
    if (days.length === 0) return WEEK_LABELS.map(() => 0);
    const cols = WEEK_LABELS.map(() => 0);
    const maxMin = Math.max(...days.map((d) => d.focus_min), 0);
    for (const d of days) {
      // Parse YYYY-MM-DD as a local date to avoid TZ off-by-one.
      const [y, m, day] = d.date.split('-').map(Number);
      const js = new Date(y, (m ?? 1) - 1, day ?? 1).getDay();
      const col = js === 0 ? 6 : js - 1; // Mon-first
      const pct = maxMin > 0 ? Math.round((d.focus_min / maxMin) * 100) : 0;
      cols[col] = pct;
    }
    return cols;
  }, [focusStats]);

  const hasFocusData = (focusStats?.by_day ?? []).some((d) => d.focus_min > 0);

  const todayIndex = useMemo(() => {
    // JS getDay: 0=Sun..6=Sat → map to Mon-first (S T Q Q S S D = Seg..Dom).
    const js = new Date().getDay();
    return js === 0 ? 6 : js - 1;
  }, []);

  // Real "Onde foi seu tempo" bars: each row is a category's focus minutes,
  // its share of the busiest category drives the bar width, and a stable
  // palette color is assigned by rank (busiest = strongest accent).
  const timeRows = useMemo(() => {
    if (timeByCategory.length === 0) return [];
    const maxMin = Math.max(...timeByCategory.map((c) => c.focus_min), 0);
    return timeByCategory.map((c, i) => ({
      name: c.category,
      value: formatFocusMinutes(c.focus_min),
      width: maxMin > 0 ? Math.round((c.focus_min / maxMin) * 100) : 0,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));
  }, [timeByCategory]);

  // Real completed-task count for the current ISO week, from the weekly report.
  const completedCount = useMemo(() => {
    const completed = report?.tasks?.completed;
    return typeof completed === 'number' ? String(completed) : '—';
  }, [report]);

  // Focus stat card: prefer live /focus/stats (matches the selected period),
  // fall back to the weekly report's focus block when stats are unavailable.
  const focusCard = useMemo(() => {
    if (focusStats) {
      return {
        value: formatFocusMinutes(focusStats.total_focus_min),
        sub:
          focusStats.completed_sessions === 1
            ? '1 sessão pomodoro'
            : `${focusStats.completed_sessions} sessões pomodoro`,
      };
    }
    const f = report?.focus;
    if (f && typeof f.total_hours === 'number') {
      const sessions = f.completed_sessions ?? f.total_sessions ?? 0;
      return {
        value: formatFocusMinutes(Math.round(f.total_hours * 60)),
        sub:
          sessions === 1
            ? '1 sessão pomodoro'
            : `${sessions} sessões pomodoro`,
      };
    }
    return { value: '—', sub: 'sem sessões registradas' };
  }, [focusStats, report]);

  // Mood stat card derived from the weekly report's mood block.
  const moodCard = useMemo(() => moodFromReport(report?.mood ?? {}), [report]);

  return (
    <div className="tasks-view insights-view">
      <div className="insights-view__header">
        <div className="insights-view__heading">
          <h2 className="insights-view__title">Insights</h2>
          <p className="insights-view__subtitle">Padrões da sua semana</p>
        </div>
        <div className="insights-view__period" role="tablist" aria-label="Período">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={period === p.id}
              className={`insights-view__period-btn${
                period === p.id ? ' insights-view__period-btn--active' : ''
              }`}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="insights-view__body">
        {error && <div className="insights-view__error">{error}</div>}

        {/* Stat cards */}
        <div className="insights-view__stats">
          <div className="insights-view__stat">
            <div className="insights-view__stat-label">Tarefas concluídas</div>
            <div className="insights-view__stat-row">
              <span className="insights-view__stat-value">{completedCount}</span>
            </div>
            <div className="insights-view__stat-sub">esta semana</div>
          </div>
          <div className="insights-view__stat">
            <div className="insights-view__stat-label">Tempo de foco</div>
            <div className="insights-view__stat-row">
              <span className="insights-view__stat-value">{focusCard.value}</span>
            </div>
            <div className="insights-view__stat-sub">{focusCard.sub}</div>
          </div>
          <div className="insights-view__stat">
            <div className="insights-view__stat-label">Humor médio</div>
            <div className="insights-view__stat-row">
              <span className="insights-view__stat-value">
                {moodCard?.label ?? '—'}
              </span>
              <span className="insights-view__stat-mood" aria-hidden>
                <MoodFaceIcon face={moodCard?.face ?? 'neutral'} />
              </span>
            </div>
            <div className="insights-view__stat-sub">
              {moodCard?.sub ?? 'sem registros de humor'}
            </div>
          </div>
        </div>

        {/* Weekly chart + time split */}
        <div className="insights-view__split">
          <div className="insights-view__chart-card">
            <h3 className="insights-view__chart-title">
              {period === 'month' ? 'Produtividade no mês' : 'Produtividade na semana'}
            </h3>
            <div className="insights-view__bars">
              {weeklyBars.map((h, i) => (
                <div key={i} className="insights-view__bar-col">
                  <div
                    className={`insights-view__bar${h >= 65 ? ' insights-view__bar--hi' : ''}`}
                    style={{ height: `${h}%` }}
                  />
                  <span
                    className={`insights-view__bar-label${
                      i === todayIndex ? ' insights-view__bar-label--today' : ''
                    }`}
                  >
                    {WEEK_LABELS[i]}
                  </span>
                </div>
              ))}
            </div>
            {!hasFocusData && (
              <p className="insights-view__chart-empty">
                Sem sessões de foco registradas neste período.
              </p>
            )}
          </div>
          {/*
            "Onde foi seu tempo": real time-by-category breakdown. Focus
            sessions are tagged with a category (default 'Foco') and summed
            by /insights/time-by-category. Bars are normalised to the busiest
            category; shows an empty state when no sessions exist yet.
          */}
          <div className="insights-view__time-card">
            <h3 className="insights-view__time-title">Onde foi seu tempo</h3>
            {timeRows.length > 0 ? (
              <div className="insights-view__time-rows">
                {timeRows.map((row) => (
                  <div key={row.name}>
                    <div className="insights-view__time-head">
                      <span className="insights-view__time-name">{row.name}</span>
                      <span className="insights-view__time-value">{row.value}</span>
                    </div>
                    <div className="insights-view__time-track">
                      <div
                        className="insights-view__time-fill"
                        style={{ width: `${row.width}%`, background: row.color }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="insights-view__chart-empty">
                Marque suas sessões de foco com uma categoria para ver onde seu
                tempo está indo.
              </p>
            )}
          </div>
        </div>

        {/* Seraphine notou */}
        <div className="insights-view__noticed">
          <div className="insights-view__noticed-head">
            <span className="insights-view__noticed-badge" aria-hidden>
              <SparkleIcon size={15} />
            </span>
            <span className="insights-view__noticed-title">Seraphine notou</span>
          </div>
          <div className="insights-view__noticed-grid">
            {noticed.length > 0 ? (
              noticed.map((insight) => (
                <button
                  key={insight.id}
                  type="button"
                  className="insights-view__noticed-item"
                  onClick={() => void handleDismiss(insight)}
                  title="Dispensar"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <span
                    className="insights-view__noticed-icon"
                    style={{ color: NOTICED_COLORS[insight.severity] ?? NOTICED_COLORS.info }}
                    aria-hidden
                  >
                    <NoticedIcon severity={insight.severity} />
                  </span>
                  <span className="insights-view__noticed-text">{insight.title}</span>
                </button>
              ))
            ) : (
              <div className="insights-view__noticed-item">
                <span
                  className="insights-view__noticed-icon"
                  style={{ color: NOTICED_COLORS.info }}
                  aria-hidden
                >
                  <NoticedIcon severity="info" />
                </span>
                <span className="insights-view__noticed-text">
                  Ainda não há padrões para mostrar. A Seraphine analisa suas
                  tarefas, finanças, hábitos e foco conforme você usa o app.
                </span>
              </div>
            )}
          </div>
        </div>

        {!loading && active.length === 0 && (
          <div className="insights-view__empty">
            <LightbulbIcon size={28} />
            <p className="insights-view__empty-title">Nenhum insight ainda</p>
            <p className="insights-view__empty-hint">
              A Seraphine gera insights automaticamente conforme você usa tarefas,
              finanças e hábitos.{' '}
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  padding: 0,
                  font: 'inherit',
                }}
              >
                {refreshing ? 'Atualizando…' : 'Atualizar agora'}
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function MoodFaceIcon({ face }: { face: MoodFace }): JSX.Element {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  // Mouth path varies by mood; eyes are shared.
  const mouth =
    face === 'happy'
      ? 'M8 14s1.5 2 4 2 4-2 4-2'
      : face === 'sad'
        ? 'M16 16s-1.5-2-4-2-4 2-4 2'
        : 'M8 15h8';
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d={mouth} />
      <path d="M9 9h.01M15 9h.01" />
    </svg>
  );
}

function NoticedIcon({ severity }: { severity: InsightSeverity }): JSX.Element {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (severity === 'warning') {
    // Sun / "morning" glyph.
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (severity === 'positive') {
    // Flame / streak glyph.
    return (
      <svg {...common}>
        <path d="M12 3c.5 2.5 2 4.2 3.5 5.5C17 9.8 18 11.5 18 13.5a6 6 0 1 1-12 0c0-1.2.4-2.3 1-3 .2 1.2 1 2 2 2a2.5 2.5 0 0 0 2.5-2.5c0-1.5-1-2.5-1-4 0-1 .4-2 1.5-3z" />
      </svg>
    );
  }
  // info → chart trend glyph.
  return (
    <svg {...common}>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  );
}
