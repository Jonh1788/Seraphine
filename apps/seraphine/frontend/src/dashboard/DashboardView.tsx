import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';
import {
  TasksIcon,
  FinanceIcon,
  CalendarIcon,
  ClockIcon,
} from '../icons/Icons';

interface DashboardSummary {
  greeting: string;
  date: string;
  tasks_today: {
    total: number;
    completed: number;
    overdue: number;
    pending_titles: string[];
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

export function DashboardView({ onNavigate, connected }: DashboardViewProps): JSX.Element {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [clock, setClock] = useState<string>(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  });
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

      {/* --- Briefing --- */}
      {tasks && (
        <div className="dashboard__briefing">
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
