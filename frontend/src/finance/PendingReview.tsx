import { useState } from 'react';
import type { FinanceEntry } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from './types';
import { CheckIcon, XIcon } from '../icons/Icons';

function fmtBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

const SOURCE_LABELS: Record<string, string> = {
  pdf: 'PDF',
  email: 'Email',
  chat: 'Chat',
  manual: 'Manual',
};

interface PendingTask {
  id: number;
  type: string;
  title: string;
  description: string;
  source: string;
  payload: string;
  created_at: string;
}

interface PendingReviewProps {
  entries: FinanceEntry[];
  tasks?: PendingTask[];
  onRefresh: () => void;
}

export function PendingReview({ entries, tasks, onRefresh }: PendingReviewProps): JSX.Element {
  const [actioningId, setActioningId] = useState<number | null>(null);
  // Track dismissed items locally for instant removal animation
  const [dismissedEntries, setDismissedEntries] = useState<Set<number>>(new Set());
  const [dismissedTasks, setDismissedTasks] = useState<Set<number>>(new Set());

  const visibleEntries = entries.filter(e => !dismissedEntries.has(e.id));
  const visibleTasks = (tasks || []).filter(t => !dismissedTasks.has(t.id));
  const hasTasks = visibleTasks.length > 0;
  const hasEntries = visibleEntries.length > 0;

  if (!hasTasks && !hasEntries) {
    return (
      <div className="finance-pending-empty">
        Nenhum item pendente de revisao
      </div>
    );
  }

  const dismissEntry = (id: number) => {
    setDismissedEntries(prev => new Set(prev).add(id));
    // Background refresh to sync parent state (no loading flash)
    setTimeout(() => onRefresh(), 500);
  };

  const dismissTask = (id: number) => {
    setDismissedTasks(prev => new Set(prev).add(id));
    setTimeout(() => onRefresh(), 500);
  };

  const handleConfirm = async (id: number): Promise<void> => {
    setActioningId(id);
    try {
      const res = await fetch(`/finance/entries/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      if (!res.ok) throw new Error('Falha ao confirmar');
      dismissEntry(id);
    } catch (err) {
      console.error('Erro ao confirmar entrada:', err);
    } finally {
      setActioningId(null);
    }
  };

  const handleReject = async (id: number): Promise<void> => {
    setActioningId(id);
    try {
      const res = await fetch(`/finance/entries/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Falha ao rejeitar');
      dismissEntry(id);
    } catch (err) {
      console.error('Erro ao rejeitar entrada:', err);
    } finally {
      setActioningId(null);
    }
  };

  const handleExecuteTask = async (taskId: number): Promise<void> => {
    setActioningId(taskId);
    try {
      const res = await fetch(`/tasks/${taskId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('Failed');
      dismissTask(taskId);
    } catch (err) {
      console.error('Task execute error:', err);
    } finally {
      setActioningId(null);
    }
  };

  const handleRejectTask = async (taskId: number): Promise<void> => {
    setActioningId(taskId);
    try {
      const res = await fetch(`/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      });
      if (!res.ok) throw new Error('Failed');
      dismissTask(taskId);
    } catch (err) {
      console.error('Task reject error:', err);
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="finance-pending-list">
      {/* Seraphine Tasks / Suggestions */}
      {hasTasks && (
        <div className="finance-pending-section">
          <h3 className="finance-pending-section__title">Sugestoes da Seraphine</h3>
          {visibleTasks.map((task) => {
            let payload: Record<string, any> = {};
            try { payload = JSON.parse(task.payload || '{}'); } catch { /* ignore */ }
            const busy = actioningId === task.id;

            return (
              <div key={`task-${task.id}`} className="finance-pending-card finance-pending-card--task">
                <div className="finance-pending-card__header">
                  <span className="finance-pending-card__desc">{task.title}</span>
                  <span className="finance-pending-card__source-badge">{task.source}</span>
                </div>
                <p className="finance-pending-card__detail">{task.description}</p>
                {task.type === 'finance_import' && payload.filename && (
                  <p className="finance-pending-card__file">
                    Arquivo: {payload.filename}
                  </p>
                )}
                <div className="finance-pending-card__actions">
                  <button
                    type="button"
                    className="btn-confirm"
                    disabled={busy}
                    onClick={() => handleExecuteTask(task.id)}
                  >
                    {busy ? '...' : <><CheckIcon size={14} /> Importar</>}
                  </button>
                  <button
                    type="button"
                    className="btn-reject"
                    disabled={busy}
                    onClick={() => handleRejectTask(task.id)}
                  >
                    {busy ? '...' : <><XIcon size={14} /> Ignorar</>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Divider if both tasks and entries exist */}
      {hasTasks && hasEntries && (
        <div className="finance-pending-divider" />
      )}

      {/* Existing entry cards */}
      {visibleEntries.map((entry) => {
        const isIncome = entry.type === 'income';
        const color = CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.outros;
        const catLabel = CATEGORY_LABELS[entry.category] ?? entry.category;
        const sourceLabel = SOURCE_LABELS[entry.source] ?? entry.source;
        const busy = actioningId === entry.id;

        return (
          <div key={entry.id} className="finance-pending-card">
            <div className="finance-pending-card__header">
              <span className="finance-pending-card__desc">
                {entry.description}
              </span>
              <span
                className={`finance-pending-card__amount ${
                  isIncome
                    ? 'finance-pending-card__amount--income'
                    : 'finance-pending-card__amount--expense'
                }`}
              >
                {isIncome ? '+' : '-'}{fmtBRL(entry.amount)}
              </span>
            </div>
            <div className="finance-pending-card__meta">
              <span
                className="finance-badge"
                style={{
                  background: color + '22',
                  color,
                  borderColor: color + '44',
                }}
              >
                {catLabel}
              </span>
              <span>{fmtDate(entry.date)}</span>
              <span>{sourceLabel}</span>
            </div>
            <div className="finance-pending-card__actions">
              <button
                type="button"
                className="btn-confirm"
                disabled={busy}
                onClick={() => handleConfirm(entry.id)}
              >
                {busy ? '...' : <><CheckIcon size={14} /> Confirmar</>}
              </button>
              <button
                type="button"
                className="btn-reject"
                disabled={busy}
                onClick={() => handleReject(entry.id)}
              >
                {busy ? '...' : <><XIcon size={14} /> Rejeitar</>}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
