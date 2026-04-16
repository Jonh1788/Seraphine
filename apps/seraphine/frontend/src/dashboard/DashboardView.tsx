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

interface DashboardViewProps {
  onNavigate: (view: string) => void;
  connected: boolean;
}

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

      {/* --- Water --- */}
      <WaterWidget />

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
          events.slice(0, 5).map((ev, i) => (
            <div key={i} className="dashboard__timeline-item">
              <span className="dashboard__timeline-time">{ev.time}</span>
              <span
                className="dashboard__timeline-dot"
                style={{ background: dotColor[ev.type] ?? '#a78bfa' }}
              />
              <span className="dashboard__timeline-label">{ev.title}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
