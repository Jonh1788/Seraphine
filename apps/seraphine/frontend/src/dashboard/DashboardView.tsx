import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';
import {
  TasksIcon,
  FinanceIcon,
  CalendarIcon,
  ClockIcon,
  CircleIcon,
  CheckCircleIcon,
} from '../icons/Icons';
import { WaterWidget } from '../water';
import { HealthWidget } from '../health';
import { MoodWidget } from '../mood';
import { GoalsSummaryWidget } from '../goals';
import { FocusSummaryWidget } from '../focus/FocusSummaryWidget';
import { JournalRecentWidget } from '../journal';
import {
  InsightsDashboardWidget,
  WeeklyReportCard,
  getWeeklyReport,
} from '../insights';
import type { WeeklyReport } from '../insights';

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

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Returns true when `eventTime` (HH:MM) is earlier than `nowHHMM`.
 *  Safe for empty/invalid values (returns false). */
function isPastTime(eventTime: string, nowHHMM: string): boolean {
  if (!eventTime || eventTime.length < 4) return false;
  if (!nowHHMM || nowHHMM.length < 4) return false;
  return eventTime.slice(0, 5) < nowHHMM.slice(0, 5);
}

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

export function DashboardView({ onNavigate, connected }: DashboardViewProps): JSX.Element {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [clock, setClock] = useState<string>(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  });
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null);
  const [workBriefing, setWorkBriefing] = useState<{
    projects: WorkProject[];
    active_triages: unknown[];
    due_projects: WorkProject[];
  } | null>(null);
  const [workSuggestions, setWorkSuggestions] = useState<WorkSuggestion[]>([]);
  const [workToday, setWorkToday] = useState<WorkToday | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    const tick = (): void => {
      const now = new Date();
      setClock(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    };
    clockRef.current = setInterval(tick, 30_000);
    return () => {
      if (clockRef.current) clearInterval(clockRef.current);
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
  const progress = tasks ? (tasks.total > 0 ? (tasks.completed / tasks.total) * 100 : 0) : 0;

  // Next event for the agenda module card
  const nextEvent = events.length > 0 ? events[0] : null;
  const topWorkSuggestion = workSuggestions[0] || null;

  const modules: {
    key: string;
    icon: JSX.Element;
    color: string;
    title: string;
    detail: string;
    view: string;
  }[] = [
    {
      key: 'tasks',
      icon: <TasksIcon size={20} />,
      color: '#22d3ee',
      title: 'Tarefas',
      detail: tasks
        ? `${tasks.total - tasks.completed} pendentes` +
          (tasks.overdue > 0 ? ` \u00b7 ${tasks.overdue} atrasadas` : '')
        : 'Carregando...',
      view: 'tasks',
    },
    {
      key: 'finance',
      icon: <FinanceIcon size={20} />,
      color: '#4ade80',
      title: 'Financas',
      detail: finance
        ? `${formatBRL(finance.income)} receita \u00b7 ${formatBRL(finance.expenses)} despesa`
        : 'Carregando...',
      view: 'finance',
    },
    {
      key: 'calendar',
      icon: <CalendarIcon size={20} />,
      color: '#a78bfa',
      title: 'Agenda',
      detail: nextEvent
        ? `${nextEvent.title} \u00b7 ${nextEvent.time}`
        : 'Nenhum evento',
      view: 'calendar',
    },
    {
      key: 'summary',
      icon: <FinanceIcon size={20} />,
      color: '#f59e0b',
      title: 'Resumo',
      detail: finance ? `Saldo: ${formatBRL(finance.balance)}` : 'Carregando...',
      view: 'finance',
    },
    {
      key: 'work',
      icon: <TasksIcon size={20} />,
      color: '#f472b6',
      title: 'Trabalho',
      detail: workBriefing
        ? `${workBriefing.projects.length} projetos` +
          (workBriefing.active_triages.length > 0 ? ` · ${workBriefing.active_triages.length} triagens` : '')
        : 'Carregando...',
      view: 'trabalhos',
    },
  ];

  const dotColor: Record<string, string> = {
    task: '#22d3ee',
    agenda: '#a78bfa',
    finance: '#4ade80',
  };

  return (
    <div className="dashboard">
      {/* --- Header --- */}
      <div className="dashboard__header">
        <div className="dashboard__header-left">
          <div className="dashboard__greeting">
            {data?.greeting ?? 'Carregando...'}
          </div>
          <div className="dashboard__date">{data?.date ?? ''}</div>
        </div>
        <div className="dashboard__header-right">
          <div className="dashboard__clock">{clock}</div>
          <span
            className="dashboard__status"
            style={{ background: connected ? '#4ade80' : '#ef4444' }}
            title={connected ? 'Conectado' : 'Desconectado'}
          />
        </div>
      </div>

      {/* --- Weekly Report (Mondays only) --- */}
      {weeklyReport && (
        <WeeklyReportCard
          report={weeklyReport}
          onDismiss={handleWeeklyDismiss}
        />
      )}

      {/* --- Briefing --- */}
      {tasks && (
        <div className="dashboard__briefing">
          <div className="dashboard__briefing-top">
            <div className="dashboard__briefing-label">
              {tasks.completed} de {tasks.total} concluidos
            </div>
            <div className="dashboard__progress-bar">
              <div
                className="dashboard__progress-fill"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Completed tasks */}
          {tasks.completed_titles && tasks.completed_titles.length > 0 && (
            <div className="dashboard__task-list">
              <div className="dashboard__task-list-title dashboard__task-list-title--done">
                Concluidas
              </div>
              {tasks.completed_titles.map((t, i) => (
                <div key={`done-${i}`} className="dashboard__task-item dashboard__task-item--done">
                  <CheckCircleIcon size={14} />
                  <span>{t}</span>
                </div>
              ))}
            </div>
          )}

          {/* Overdue tasks */}
          {tasks.overdue_items && tasks.overdue_items.length > 0 && (
            <div className="dashboard__task-list">
              <div className="dashboard__task-list-title dashboard__task-list-title--overdue">
                Atrasadas
              </div>
              {tasks.overdue_items.map((item, i) => (
                <div key={`late-${i}`} className="dashboard__task-item dashboard__task-item--overdue">
                  <ClockIcon size={14} />
                  <span>{item.title}</span>
                  {item.due_time && (
                    <span className="dashboard__task-time">{item.due_time}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pending tasks */}
          {tasks.pending_titles && tasks.pending_titles.length > 0 && (
            <div className="dashboard__task-list">
              <div className="dashboard__task-list-title">Pendentes</div>
              {tasks.pending_titles.map((t, i) => (
                <div key={`pend-${i}`} className="dashboard__task-item">
                  <CircleIcon size={14} />
                  <span>{t}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- Planning CTA --- */}
      <button
        type="button"
        className="dashboard__planning-btn"
        onClick={() => onNavigate('planning')}
      >
        <CalendarIcon size={18} />
        <span>Plano do dia</span>
        <span className="dashboard__planning-arrow">&rarr;</span>
      </button>

      {/* --- Modules Grid --- */}
      <div className="dashboard__grid">
        {modules.map((mod) => (
          <button
            key={mod.key}
            type="button"
            className="dashboard__module"
            style={{ borderLeftColor: mod.color }}
            onClick={() => onNavigate(mod.view)}
          >
            <div
              className="dashboard__module-icon"
              style={{ background: `${mod.color}22`, color: mod.color }}
            >
              {mod.icon}
            </div>
            <div className="dashboard__module-body">
              <div className="dashboard__module-title">{mod.title}</div>
              <div className="dashboard__module-detail">{mod.detail}</div>
            </div>
          </button>
        ))}
      </div>

      {workBriefing && (
        <button
          type="button"
          className="dashboard__work-card"
          onClick={() => onNavigate('trabalhos')}
        >
          <div className="dashboard__work-card-top">
            <div>
              <span>Missao de hoje</span>
              <strong>{workToday?.top_project?.name || workBriefing.projects[0]?.name || 'Sem projeto principal'}</strong>
            </div>
            <span>{workToday?.counts.decisions ?? workSuggestions.length} decisao(oes)</span>
          </div>
          <p>
            {workToday?.next_decision
              ? `${workToday.next_decision.title}: ${workToday.next_decision.detail}`
              : workToday?.next_task?.title
                ? `Proxima tarefa: ${workToday.next_task.title}`
                : topWorkSuggestion
              ? `${topWorkSuggestion.title}: ${topWorkSuggestion.detail}`
              : 'Nenhuma decisao de trabalho pendente agora.'}
          </p>
          {workToday?.risk_project && (
            <small className="dashboard__work-risk">
              Risco: {workToday.risk_project.name}
            </small>
          )}
        </button>
      )}

      {/* --- Water --- */}
      <WaterWidget />

      {/* --- Health (Apple HealthKit) --- */}
      <HealthWidget />

      {/* --- Mood --- */}
      <MoodWidget />

      {/* --- Goals / Focus / Journal widgets --- */}
      <div className="dashboard__widgets-row">
        <GoalsSummaryWidget onNavigate={() => onNavigate('goals')} />
        <FocusSummaryWidget onNavigate={() => onNavigate('focus')} />
        <JournalRecentWidget onNavigate={() => onNavigate('journal')} />
      </div>

      {/* --- Insights --- */}
      <InsightsDashboardWidget onNavigate={() => onNavigate('insights')} />

      {/* --- Timeline --- */}
      <div className="dashboard__timeline">
        <div className="dashboard__timeline-title">
          <ClockIcon size={16} />
          <span>Proximos eventos</span>
        </div>
        {events.length === 0 ? (
          <div className="dashboard__timeline-empty">Nenhum evento hoje</div>
        ) : (
          events.slice(0, 5).map((ev, i) => {
            const overdue = isPastTime(ev.time, clock);
            return (
              <div
                key={i}
                className={`dashboard__timeline-item${overdue ? ' dashboard__timeline-item--overdue' : ''}`}
              >
                <span className="dashboard__timeline-time">{ev.time}</span>
                <span
                  className="dashboard__timeline-dot"
                  style={{ background: overdue ? '#ef4444' : (dotColor[ev.type] ?? '#a78bfa') }}
                />
                <span className="dashboard__timeline-label">{ev.title}</span>
                {overdue && (
                  <span className="dashboard__timeline-badge">atrasada</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
