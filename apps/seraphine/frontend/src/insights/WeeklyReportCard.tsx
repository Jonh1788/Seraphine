import {
  CheckCircleIcon,
  FinanceIcon,
  FlameIcon,
  LightbulbIcon,
  TasksIcon,
  XIcon,
} from '../icons/Icons';
import { insightTypeLabel } from './InsightCard';
import type { WeeklyReport } from './types';

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return iso;
  }
}

export interface WeeklyReportCardProps {
  report: WeeklyReport;
  onDismiss: () => void;
}

export function WeeklyReportCard({
  report,
  onDismiss,
}: WeeklyReportCardProps): JSX.Element {
  const tasks = report.tasks ?? { created: 0, completed: 0, overdue: 0 };
  const fin = report.finance ?? { income: 0, expenses: 0, balance: 0 };
  const maintained = report.habits?.maintained ?? [];
  const broken = report.habits?.broken ?? [];
  const habitsTotal = maintained.length + broken.length;
  const topInsights = report.insights ?? [];
  const suggestion = report.suggestion ?? '';

  return (
    <section className="weekly-report">
      <header className="weekly-report__header">
        <div className="weekly-report__header-left">
          <span className="weekly-report__badge" aria-hidden>
            <LightbulbIcon size={18} />
          </span>
          <div>
            <h3 className="weekly-report__title">Relatorio semanal</h3>
            <p className="weekly-report__range">
              {formatDate(report.week_start)} — {formatDate(report.week_end)}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="weekly-report__close"
          onClick={onDismiss}
          aria-label="Fechar relatorio semanal"
          title="Dispensar"
        >
          <XIcon size={16} />
        </button>
      </header>

      <div className="weekly-report__metrics">
        <div className="weekly-report__metric">
          <div
            className="weekly-report__metric-icon"
            style={{ background: 'rgba(34, 211, 238, 0.15)', color: '#22d3ee' }}
            aria-hidden
          >
            <TasksIcon size={16} />
          </div>
          <div className="weekly-report__metric-body">
            <div className="weekly-report__metric-label">Tarefas</div>
            <div className="weekly-report__metric-value">
              {tasks.completed}/{tasks.created}
            </div>
            <div className="weekly-report__metric-sub">
              {tasks.overdue > 0
                ? `${tasks.overdue} atrasadas`
                : 'nenhuma atrasada'}
            </div>
          </div>
        </div>

        <div className="weekly-report__metric">
          <div
            className="weekly-report__metric-icon"
            style={{ background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80' }}
            aria-hidden
          >
            <FinanceIcon size={16} />
          </div>
          <div className="weekly-report__metric-body">
            <div className="weekly-report__metric-label">Financas</div>
            <div
              className="weekly-report__metric-value"
              style={{ color: fin.balance >= 0 ? '#4ade80' : '#ef4444' }}
            >
              {formatBRL(fin.balance)}
            </div>
            <div className="weekly-report__metric-sub">
              {formatBRL(fin.income)} in | {formatBRL(fin.expenses)} out
            </div>
          </div>
        </div>

        <div className="weekly-report__metric">
          <div
            className="weekly-report__metric-icon"
            style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}
            aria-hidden
          >
            <FlameIcon size={16} />
          </div>
          <div className="weekly-report__metric-body">
            <div className="weekly-report__metric-label">Habitos</div>
            <div className="weekly-report__metric-value">
              {maintained.length}/{habitsTotal}
            </div>
            <div className="weekly-report__metric-sub">mantidos</div>
          </div>
        </div>
      </div>

      {habitsTotal > 0 && (
        <div className="weekly-report__habits">
          {maintained.map((h) => (
            <div
              key={`kept-${h.title}`}
              className="weekly-report__habit weekly-report__habit--kept"
            >
              <span className="weekly-report__habit-status" aria-hidden>
                <CheckCircleIcon size={14} />
              </span>
              <span className="weekly-report__habit-title">{h.title}</span>
              <span className="weekly-report__habit-streak">
                {h.streak} {h.streak === 1 ? 'dia' : 'dias'}
              </span>
            </div>
          ))}
          {broken.map((h) => (
            <div
              key={`broken-${h.title}`}
              className="weekly-report__habit"
            >
              <span className="weekly-report__habit-status" aria-hidden>
                <XIcon size={14} />
              </span>
              <span className="weekly-report__habit-title">{h.title}</span>
              <span className="weekly-report__habit-streak">
                recorde {h.best_streak} {h.best_streak === 1 ? 'dia' : 'dias'}
              </span>
            </div>
          ))}
        </div>
      )}

      {topInsights.length > 0 && (
        <div className="weekly-report__insights">
          <h4 className="weekly-report__section-title">Insights da semana</h4>
          <ul className="weekly-report__insights-list">
            {topInsights.map((insight) => (
              <li key={insight.id} className="weekly-report__insight">
                <span className="weekly-report__insight-type">
                  {insightTypeLabel(insight.type)}
                </span>
                <span className="weekly-report__insight-title">{insight.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {suggestion && (
        <div className="weekly-report__focus">
          <span className="weekly-report__focus-label">Foco da semana</span>
          <p className="weekly-report__focus-text">{suggestion}</p>
        </div>
      )}

      <div className="weekly-report__actions">
        <button
          type="button"
          className="btn-confirm"
          onClick={onDismiss}
        >
          Entendido
        </button>
      </div>
    </section>
  );
}
