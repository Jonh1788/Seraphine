import './obsidian.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';
import { AlertTriangleIcon, SparkleIcon } from '../icons/Icons';
import { VrmAvatar } from '../avatar/VrmAvatar';
import {
  addWaterIntake,
  getWaterProfile,
  getWaterToday,
} from '../water/api';
import type { WaterProfile, WaterToday } from '../water/types';
import { getBackendToday } from '../health/api';
import type { HealthSnapshot } from '../health/types';
import { fetchMoodToday } from '../mood/api';
import { MOOD_LABELS, moodColor } from '../mood/types';
import type { MoodToday } from '../mood/types';
import {
  WeeklyReportCard,
  getWeeklyReport,
} from '../insights';
import type { WeeklyReport } from '../insights';
import { useFocusTimer } from '../focus/useFocusTimer';
import { listHabits } from '../habits/api';
import type { HabitWithStatus } from '../habits/types';

interface OverdueItem {
  title: string;
  due_date: string;
  due_time?: string | null;
}

interface DashboardSummary {
  greeting: string;
  date: string;
  tasks_today: {
    total: number;
    completed: number;
    overdue: number;
    pending_titles: string[];
    completed_titles: string[];
    overdue_items: OverdueItem[];
  };
  next_events: Array<{
    title: string;
    time: string;
    type: string;
  }>;
  finance_month: {
    income: number;
    expenses: number;
    balance: number;
    pending_review: number;
    by_category?: Array<{
      category: string;
      total: number;
      count: number;
    }>;
  };
  habits_today?: {
    total: number;
    completed: number;
    best_streak: { title: string; days: number } | null;
  };
  focus_today?: {
    total_min: number;
    sessions: number;
    is_active: boolean;
  };
}

interface WorkProject {
  id: string;
  name: string;
  area?: string;
  priority?: string;
  due_date?: string | null;
}

interface WorkSuggestion {
  id: string;
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

interface WorkToday {
  top_project?: WorkProject | null;
  risk_project?: WorkProject | null;
  next_task?: { title?: string; due_date?: string | null; priority?: string | null } | null;
  next_decision?: WorkSuggestion | null;
  counts: {
    projects: number;
    open_tasks: number;
    active_triages: number;
    decisions: number;
  };
}

interface DashboardViewProps {
  onNavigate: (view: string) => void;
  connected: boolean;
}

const AVATAR_LS_KEY = 'seraphine.avatarUrl';
const DEFAULT_AVATAR = '/avatars/seraphine.vrm';

function resolveAvatarUrl(): string {
  try {
    return localStorage.getItem(AVATAR_LS_KEY) || DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Format ml as "1,6 L" (>=1000) or "750 ml". */
function formatWater(ml: number): string {
  if (ml >= 1000) {
    const l = ml / 1000;
    return `${l.toFixed(1).replace('.', ',')} L`;
  }
  return `${Math.round(ml)} ml`;
}

/** Seconds -> "MM:SS" for the pomodoro countdown. */
function formatMMSS(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Phase totals mirror the constants in useFocusTimer (used only to derive the
// progress-bar fill ratio — the hook owns the real countdown).
const FOCUS_PHASE_TOTALS: Record<string, number> = {
  work: 25 * 60,
  break: 5 * 60,
  long_break: 15 * 60,
  idle: 25 * 60,
};

const FOCUS_PHASE_LABELS: Record<string, string> = {
  work: 'Trabalho',
  break: 'Pausa',
  long_break: 'Pausa longa',
  idle: 'Pronto',
};

/** Minutes -> "7h20" / "45min". */
function formatSleep(min: number | null | undefined): string {
  if (min == null || min <= 0) return '—';
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

// --- Category colors (finance / calendar) shared with the design system ---
const CATEGORY_COLORS: Record<string, string> = {
  Moradia: '#5c6bc0',
  'Alimentação': '#ff7043',
  Transporte: '#26a69a',
  'Saúde': '#ef5350',
  Lazer: '#ab47bc',
  'Educação': '#42a5f5',
  'Salário': '#66bb6a',
  Freelance: '#8bc34a',
  Investimento: '#ffa726',
  Outros: '#78909c',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  task: '#42a5f5',
  agenda: '#ab47bc',
  finance: '#26a69a',
  health: '#ef5350',
  work: '#5c6bc0',
};

const EVENT_FALLBACK_COLORS = ['#42a5f5', '#ab47bc', '#26a69a'];

const WEEKLY_REPORT_LS_KEY = 'seraphine.weeklyReportShown';

/** Returns the ISO date (YYYY-MM-DD) of the Monday of the current week,
 *  using LOCAL date components so late-Monday-in-SP doesn't roll into
 *  Tuesday's UTC date via toISOString(). */
function currentMondayISO(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun .. 6=Sat
  // Distance back to Monday. When today is Sunday (0), Monday was 6 days ago.
  const daysSinceMon = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMon);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Wellness card — merges Water / Health / Mood data into one Obsidian card.
// Preserves the existing data fetches (getWaterToday, addWaterIntake,
// getBackendToday, fetchMoodToday) and the water "+250ml" optimistic action.
// ---------------------------------------------------------------------------
function WellnessCard(): JSX.Element {
  const [profile, setProfile] = useState<WaterProfile | null>(null);
  const [water, setWater] = useState<WaterToday | null>(null);
  const [mood, setMood] = useState<MoodToday | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshWater = useCallback(async (): Promise<void> => {
    try {
      const t = await getWaterToday();
      if (mountedRef.current) setWater(t);
    } catch {
      // keep stale
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, w, m, h] = await Promise.allSettled([
        getWaterProfile(),
        getWaterToday(),
        fetchMoodToday(),
        getBackendToday(),
      ]);
      if (cancelled || !mountedRef.current) return;
      if (p.status === 'fulfilled') setProfile(p.value);
      if (w.status === 'fulfilled') setWater(w.value);
      if (m.status === 'fulfilled') setMood(m.value);
      if (h.status === 'fulfilled') setHealth(h.value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAddWater = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const amount = 250;
    const goal = water?.goal ?? profile?.daily_goal_ml ?? 2000;
    const newTotal = (water?.total ?? 0) + amount;
    // Optimistic bump
    setWater((prev) => ({
      total: newTotal,
      goal,
      percent: goal > 0 ? Math.round((newTotal / goal) * 100) : 0,
      logs: prev?.logs ?? [],
    }));
    try {
      const res = await addWaterIntake(amount);
      if (mountedRef.current) {
        setWater((prev) => ({
          total: res.total_today,
          goal: res.goal,
          percent: res.percent,
          logs: prev?.logs ?? [],
        }));
      }
    } catch {
      if (mountedRef.current) void refreshWater();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, water, profile, refreshWater]);

  const goal = water?.goal ?? profile?.daily_goal_ml ?? 2000;
  const total = water?.total ?? 0;
  const waterPct = Math.max(0, Math.min(100, water?.percent ?? (goal > 0 ? Math.round((total / goal) * 100) : 0)));

  const moodLabel = mood?.current?.label;
  const moodDisplay = moodLabel ? (MOOD_LABELS[moodLabel] ?? moodLabel) : 'Sem registro';
  const moodDot = moodLabel ? moodColor(moodLabel) : '#ff8a4c';

  const sleep = formatSleep(health?.sleep_minutes);
  const steps = health?.steps != null ? Math.round(health.steps).toLocaleString('pt-BR') : '—';

  return (
    <div className="dash-card dash-card--wellness">
      <div className="dash-card__head">
        <span className="dash-card__title">Bem-estar</span>
        <span className="dash-wellness__value">hoje</span>
      </div>
      <div className="dash-wellness">
        {/* Água */}
        <div>
          <div className="dash-wellness__water-head">
            <span className="dash-wellness__label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#42a5f5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
              </svg>
              Água
            </span>
            <div className="dash-wellness__water-right">
              <span className="dash-wellness__amount">{formatWater(total)} / {formatWater(goal)}</span>
              <button
                type="button"
                className="dash-wellness__add"
                onClick={() => void handleAddWater()}
                disabled={busy}
              >
                + 250 ml
              </button>
            </div>
          </div>
          <div className="dash-wellness__track">
            <div className="dash-wellness__fill" style={{ width: `${waterPct}%` }} />
          </div>
        </div>

        {/* Humor */}
        <div className="dash-wellness__row">
          <span className="dash-wellness__label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={moodDot} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M8.5 14.5s1.2 1.5 3.5 1.5 3.5-1.5 3.5-1.5M9 9.5h.01M15 9.5h.01" />
            </svg>
            Humor
          </span>
          <span className="dash-wellness__value dash-wellness__value--strong">{moodDisplay}</span>
        </div>

        {/* Sono */}
        <div className="dash-wellness__row">
          <span className="dash-wellness__label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
            Sono
          </span>
          <span className="dash-wellness__value">{sleep}</span>
        </div>

        {/* Passos */}
        <div className="dash-wellness__row">
          <span className="dash-wellness__label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h4l2-6 4 12 2-6h4" />
            </svg>
            Passos
          </span>
          <span className="dash-wellness__value">{steps}</span>
        </div>
      </div>
    </div>
  );
}

export function DashboardView({ onNavigate, connected }: DashboardViewProps): JSX.Element {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [focusState, focusActions] = useFocusTimer();
  const [habits, setHabits] = useState<HabitWithStatus[]>([]);
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null);
  const [workBriefing, setWorkBriefing] = useState<{
    projects: WorkProject[];
    active_triages: unknown[];
    due_projects: WorkProject[];
  } | null>(null);
  const [workSuggestions, setWorkSuggestions] = useState<WorkSuggestion[]>([]);
  const [workToday, setWorkToday] = useState<WorkToday | null>(null);
  const [avatarUrl] = useState<string>(() => resolveAvatarUrl());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchSummary = async (): Promise<void> => {
      try {
        const res = await fetch(`${API_BASE}/dashboard/summary`);
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        // network error — keep stale data
      }
    };

    void fetchSummary();
    timerRef.current = setInterval(fetchSummary, 60_000);

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchWork = async (): Promise<void> => {
      const [briefing, autopilot, today] = await Promise.allSettled([
        fetch(`${API_BASE}/work/briefing`).then((r) => r.ok ? r.json() : null),
        fetch(`${API_BASE}/work/autopilot`).then((r) => r.ok ? r.json() : { suggestions: [] }),
        fetch(`${API_BASE}/work/today`).then((r) => r.ok ? r.json() : null),
      ]);
      if (cancelled) return;
      if (briefing.status === 'fulfilled') setWorkBriefing(briefing.value);
      if (autopilot.status === 'fulfilled') setWorkSuggestions(autopilot.value?.suggestions || []);
      if (today.status === 'fulfilled') setWorkToday(today.value);
    };
    void fetchWork();
    const id = setInterval(fetchWork, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Real habits (top-3 active) for the Hábitos card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listHabits();
        if (!cancelled) setHabits(list);
      } catch {
        // backend offline — keep empty/stale
      }
    })();
    const id = setInterval(() => {
      void (async () => {
        try {
          const list = await listHabits();
          if (!cancelled) setHabits(list);
        } catch {
          // ignore
        }
      })();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Weekly report gate: show once per Monday on first dashboard visit.
  useEffect(() => {
    if (new Date().getDay() !== 1) return;
    const mondayIso = currentMondayISO();
    let shownFor: string | null = null;
    try {
      shownFor = localStorage.getItem(WEEKLY_REPORT_LS_KEY);
    } catch {
      // localStorage may be unavailable — fall through and show.
    }
    if (shownFor === mondayIso) return;

    let cancelled = false;
    (async () => {
      try {
        const report = await getWeeklyReport();
        if (!cancelled) setWeeklyReport(report);
      } catch {
        // Backend not ready / network error — silently skip.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleWeeklyDismiss = (): void => {
    setWeeklyReport(null);
    try {
      localStorage.setItem(WEEKLY_REPORT_LS_KEY, currentMondayISO());
    } catch {
      // best-effort; a fresh load may re-show the report.
    }
  };

  const tasks = data?.tasks_today;
  const finance = data?.finance_month;
  const events = data?.next_events ?? [];

  const topWorkSuggestion = workSuggestions[0] || null;

  // --- Header greeting/date ---
  const headerTitle = 'Visão geral';
  const headerDate = data?.date ?? '';

  // --- Hero greeting + summary (derived from real data) ---
  const heroGreeting = data?.greeting ?? 'Olá';
  const pendingCount = tasks ? Math.max(0, tasks.total - tasks.completed) : 0;
  const eventCount = events.length;

  // --- Hoje (agenda) rows ---
  const agendaRows = events.slice(0, 3);

  // --- Tarefas card rows: build from real titles ---
  type TaskRow = { label: string; state: 'todo' | 'later' | 'done' };
  const taskRows: TaskRow[] = [];
  if (tasks) {
    (tasks.pending_titles ?? []).slice(0, 2).forEach((t, i) => {
      taskRows.push({ label: t, state: i === 0 ? 'todo' : 'later' });
    });
    (tasks.completed_titles ?? []).slice(0, 1).forEach((t) => {
      taskRows.push({ label: t, state: 'done' });
    });
  }

  // --- Finance figures ---
  const balance = finance?.balance ?? 0;
  const expenses = finance?.expenses ?? 0;
  const income = finance?.income ?? 0;
  const budget = income > 0 ? income : Math.max(expenses, 1);
  const budgetPct = budget > 0 ? Math.min(100, Math.round((expenses / budget) * 100)) : 0;
  const balanceDelta = income - expenses;

  // Real per-category expense breakdown (top 3) from finance_month.by_category.
  const financeCategories = (finance?.by_category ?? []).slice(0, 3);

  // Real month name for the Finanças header (derived locally — pt-BR long month).
  const monthName = new Date().toLocaleDateString('pt-BR', { month: 'long' });
  const monthLabel = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  // --- Focus (real pomodoro session from useFocusTimer) ---
  const focusIdle = focusState.phase === 'idle';
  const focusPhaseTotal = FOCUS_PHASE_TOTALS[focusState.phase] ?? FOCUS_PHASE_TOTALS.work;
  const focusElapsed = Math.max(0, focusPhaseTotal - focusState.remaining);
  const focusPct = focusIdle
    ? 0
    : Math.max(0, Math.min(100, Math.round((focusElapsed / focusPhaseTotal) * 100)));
  const focusTimeLabel = focusIdle ? '25:00' : formatMMSS(focusState.remaining);
  const focusPhaseLabel = focusIdle
    ? 'Pronto pra focar'
    : focusState.running
      ? FOCUS_PHASE_LABELS[focusState.phase]
      : 'Pausado';
  const focusMinToday = data?.focus_today?.total_min ?? 0;
  const handleFocusButton = (): void => {
    if (focusIdle) {
      focusActions.start();
    } else if (focusState.running) {
      focusActions.pause();
    } else {
      focusActions.resume();
    }
  };
  const focusButtonLabel = focusIdle
    ? 'Iniciar foco'
    : focusState.running
      ? 'Pausar sessão'
      : 'Retomar sessão';

  // --- Habits (top-3 active real habits) ---
  const topHabits = habits.filter((h) => h.active).slice(0, 3);
  // Best current streak across all habits drives the flame number; fall back to
  // the dashboard summary's best_streak if the list call hasn't resolved yet.
  const habitFlameStreak =
    habits.reduce((max, h) => Math.max(max, h.current_streak ?? 0), 0) ||
    (data?.habits_today?.best_streak?.days ?? 0);

  // Work card values
  const workProjectName =
    workToday?.top_project?.name || workBriefing?.projects[0]?.name || 'Sem projeto principal';
  const workDecisions = workToday?.counts.decisions ?? workSuggestions.length;
  const workNext = workToday?.next_decision
    ? `${workToday.next_decision.title}: ${workToday.next_decision.detail}`
    : workToday?.next_task?.title
      ? `Próxima: ${workToday.next_task.title}`
      : topWorkSuggestion
        ? `${topWorkSuggestion.title}: ${topWorkSuggestion.detail}`
        : 'Nenhuma decisão de trabalho pendente agora.';

  // Suggestion (Seraphine sugere) — from work autopilot if present
  const suggestion = topWorkSuggestion;
  const suggestionText = suggestion
    ? `${suggestion.title}: ${suggestion.detail}`
    : 'Sem sugestões agora. Quando algo precisar da sua atenção, aparece aqui.';

  return (
    <div className="dashboard">
      {/* --- Header --- */}
      <div className="dashboard__header">
        <div className="dashboard__header-left">
          <div className="dashboard__greeting">{headerTitle}</div>
          <div className="dashboard__date">{headerDate}</div>
        </div>
        <div className="dashboard__header-right">
          <div className="dash-status">
            <span
              className="dash-status__dot"
              style={{ background: connected ? '#3fbf6a' : '#ef4444' }}
            />
            {connected ? 'online' : 'offline'}
          </div>
          <button
            type="button"
            className="dash-talk-btn"
            onClick={() => onNavigate('chat')}
          >
            Falar com a Seraphine
          </button>
        </div>
      </div>

      {/* --- Scrolling body --- */}
      <div className="dash-body">
        {/* --- Weekly Report (Mondays only) --- */}
        {weeklyReport && (
          <WeeklyReportCard
            report={weeklyReport}
            onDismiss={handleWeeklyDismiss}
          />
        )}

        {/* --- Hero card --- */}
        <div className="dash-hero">
          <div className="dash-hero__avatar">
            <div className="dash-hero__avatar-glow" />
            <div className="dash-hero__avatar-slot">
              <VrmAvatar avatarUrl={avatarUrl} width={120} height={150} />
            </div>
          </div>
          <div className="dash-hero__body">
            <div className="dash-hero__greeting">{heroGreeting}</div>
            <div className="dash-hero__summary">
              Você tem <strong>{pendingCount} {pendingCount === 1 ? 'tarefa' : 'tarefas'}</strong> e{' '}
              <strong>{eventCount} {eventCount === 1 ? 'evento' : 'eventos'}</strong> hoje.{' '}
              {!tasks && !events.length ? 'Tudo tranquilo por aqui. ' : ''}Quer que eu monte um plano pro seu dia?
            </div>
            <div className="dash-hero__actions">
              <button
                type="button"
                className="dash-cta-primary"
                onClick={() => onNavigate('planning')}
              >
                Montar meu dia
              </button>
              <button
                type="button"
                className="dash-cta-ghost"
                onClick={() => onNavigate('calendar')}
              >
                Ver agenda
              </button>
            </div>
          </div>
        </div>

        {/* --- 3-col grid --- */}
        <div className="dash-grid">
          {/* Hoje (agenda) */}
          <div className="dash-card">
            <div className="dash-card__head">
              <span className="dash-card__title">Hoje</span>
              <button
                type="button"
                className="dash-card__link"
                onClick={() => onNavigate('calendar')}
              >
                Calendário
              </button>
            </div>
            <div className="dash-agenda">
              {agendaRows.length === 0 ? (
                <div className="dash-agenda__empty">Nenhum evento hoje</div>
              ) : (
                agendaRows.map((ev, i) => {
                  const color =
                    EVENT_TYPE_COLORS[ev.type] ??
                    EVENT_FALLBACK_COLORS[i % EVENT_FALLBACK_COLORS.length];
                  return (
                    <div key={i} className="dash-agenda__row">
                      <span className="dash-agenda__time">{ev.time}</span>
                      <span className="dash-agenda__bar" style={{ background: color }} />
                      <div className="dash-agenda__text">
                        <div className="dash-agenda__title">{ev.title}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Tarefas */}
          <div className="dash-card">
            <div className="dash-card__head">
              <span className="dash-card__title">Tarefas</span>
              <span className="dash-card__chip">{pendingCount} hoje</span>
            </div>
            <div className="dash-tasks">
              {taskRows.length === 0 ? (
                <div className="dash-tasks__empty">Nenhuma tarefa hoje</div>
              ) : (
                taskRows.map((row, i) => (
                  <button
                    key={i}
                    type="button"
                    className="dash-tasks__row"
                    onClick={() => onNavigate('tasks')}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                  >
                    {row.state === 'done' ? (
                      <span className="dash-tasks__box dash-tasks__box--done">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l4 4 10-10" />
                        </svg>
                      </span>
                    ) : (
                      <span className={`dash-tasks__box dash-tasks__box--${row.state}`} />
                    )}
                    <span className={`dash-tasks__label${row.state === 'done' ? ' dash-tasks__label--done' : ''}`}>
                      {row.label}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Hábitos */}
          <div className="dash-card">
            <div className="dash-card__head">
              <span className="dash-card__title">Hábitos</span>
              <span className="dash-habit__streak">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3c.5 2.5 2 4.2 3.5 5.5C17 9.8 18 11.5 18 13.5a6 6 0 1 1-12 0c0-1.2.4-2.3 1-3 .2 1.2 1 2 2 2a2.5 2.5 0 0 0 2.5-2.5c0-1.5-1-2.5-1-4 0-1 .4-2 1.5-3z" />
                </svg>
                {habitFlameStreak}
              </span>
            </div>
            <div className="dash-habits">
              {topHabits.length === 0 ? (
                <div className="dash-tasks__empty">Nenhum hábito ativo</div>
              ) : (
                topHabits.map((h) => {
                  // Approximate the last-5-days dot pattern from the current
                  // streak (true per-day history isn't on the list endpoint).
                  // today_completed lights the most recent dot; the streak
                  // back-fills the rest. Deferred: exact per-day pattern.
                  const lit = Math.min(5, Math.max(h.current_streak ?? 0, h.today_completed ? 1 : 0));
                  return (
                    <div key={h.id} className="dash-habit-row">
                      <span className="dash-habit-row__label">{h.title}</span>
                      <div className="dash-habit-row__dots">
                        {[0, 1, 2, 3, 4].map((d) => (
                          <span
                            key={d}
                            className={`dash-dot ${d >= 5 - lit ? 'dash-dot--on' : 'dash-dot--off'}`}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Bem-estar (unified Water + Mood + Health) */}
          <WellnessCard />

          {/* Finanças (span 2) */}
          <div className="dash-card dash-card--span2">
            <div className="dash-card__head">
              <span className="dash-card__title">Finanças · {monthLabel}</span>
              <button
                type="button"
                className="dash-card__link"
                onClick={() => onNavigate('finance')}
              >
                Ver tudo
              </button>
            </div>
            <div className="dash-fin">
              <div className="dash-fin__balance">
                <div className="dash-fin__balance-label">Saldo do mês</div>
                <div className="dash-fin__balance-value">{formatBRL(balance)}</div>
                <div className={`dash-fin__delta ${balanceDelta >= 0 ? 'dash-fin__delta--up' : 'dash-fin__delta--down'}`}>
                  {balanceDelta >= 0 ? '+' : ''}{formatBRL(balanceDelta)}
                </div>
              </div>
              <div className="dash-fin__budget">
                <div className="dash-fin__budget-head">
                  <span>Gasto: {formatBRL(expenses)}</span>
                  <span>Receita: {formatBRL(income)}</span>
                </div>
                <div className="dash-fin__track">
                  <div className="dash-fin__fill" style={{ width: `${budgetPct}%` }} />
                </div>
                <div className="dash-fin__legend">
                  {financeCategories.length === 0 ? (
                    <div className="dash-fin__legend-item">
                      <span className="dash-fin__legend-text">Sem gastos categorizados este mês</span>
                    </div>
                  ) : (
                    financeCategories.map((c) => (
                      <div key={c.category} className="dash-fin__legend-item">
                        <span
                          className="dash-fin__legend-sq"
                          style={{ background: CATEGORY_COLORS[c.category] ?? CATEGORY_COLORS.Outros }}
                        />
                        <span className="dash-fin__legend-text">
                          {c.category} · {formatBRL(c.total)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Foco (pomodoro) */}
          <div className="dash-card">
            <div className="dash-card__head dash-foco__head">
              <span className="dash-card__title">Foco</span>
              <span className="dash-foco__chip">Pomodoro</span>
            </div>
            <div className="dash-foco__timer">
              <span className="dash-foco__time">{focusTimeLabel}</span>
              <span className="dash-foco__time-sub">
                {focusPhaseLabel}
                {focusMinToday > 0 ? ` · ${focusMinToday}min hoje` : ''}
              </span>
            </div>
            <div className="dash-foco__track">
              <div className="dash-foco__fill" style={{ width: `${focusPct}%` }} />
            </div>
            <button
              type="button"
              className="dash-foco__btn"
              onClick={handleFocusButton}
            >
              {focusButtonLabel}
            </button>
          </div>

          {/* Trabalho · Missão (span 2) */}
          <button
            type="button"
            className="dash-card dash-card--span2"
            onClick={() => onNavigate('trabalhos')}
            style={{ cursor: 'pointer' }}
          >
            <div className="dash-card__head">
              <span className="dash-card__title">Trabalho · Missão de hoje</span>
              <span className="dash-work__chip">{workDecisions} {workDecisions === 1 ? 'decisão' : 'decisões'}</span>
            </div>
            <div className="dash-work__project">{workProjectName}</div>
            <div className="dash-work__next">{workNext}</div>
            {workToday?.risk_project && (
              <div className="dash-work__risk">
                <AlertTriangleIcon size={13} />
                Risco: {workToday.risk_project.name}
              </div>
            )}
          </button>

          {/* Seraphine sugere (span 3) */}
          <div className="dash-suggest">
            <div className="dash-suggest__head">
              <span className="dash-suggest__icon">
                <SparkleIcon size={14} className="dash-suggest__icon-svg" />
              </span>
              <span className="dash-suggest__title">Seraphine sugere</span>
            </div>
            <div className="dash-suggest__body">{suggestionText}</div>
            <div className="dash-suggest__actions">
              <button
                type="button"
                className="dash-suggest__primary"
                onClick={() => onNavigate(suggestion ? 'trabalhos' : 'planning')}
              >
                {suggestion ? 'Resolver' : 'Montar meu dia'}
              </button>
              <button
                type="button"
                className="dash-suggest__ghost"
                onClick={() => onNavigate('insights')}
              >
                Agora não
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
