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

interface PendingReviewProps {
  entries: FinanceEntry[];
  onRefresh: () => void;
}

export function PendingReview({ entries, onRefresh }: PendingReviewProps): JSX.Element {
  const [actioningId, setActioningId] = useState<number | null>(null);

  if (entries.length === 0) {
    return (
      <div className="finance-pending-empty">
        Nenhum item pendente de revisao
      </div>
    );
  }

  const handleConfirm = async (id: number): Promise<void> => {
    setActioningId(id);
    try {
      const res = await fetch(`/api/finance/entries/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      if (!res.ok) throw new Error('Falha ao confirmar');
      onRefresh();
    } catch (err) {
      console.error('Erro ao confirmar entrada:', err);
    } finally {
      setActioningId(null);
    }
  };

  const handleReject = async (id: number): Promise<void> => {
    setActioningId(id);
    try {
      const res = await fetch(`/api/finance/entries/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Falha ao rejeitar');
      onRefresh();
    } catch (err) {
      console.error('Erro ao rejeitar entrada:', err);
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="finance-pending-list">
      {entries.map((entry) => {
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
