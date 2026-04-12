import type { FinanceEntry } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from './types';

function fmtBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

interface TransactionListProps {
  entries: FinanceEntry[];
  limit?: number;
}

export function TransactionList({ entries, limit }: TransactionListProps): JSX.Element {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  const display = limit ? sorted.slice(0, limit) : sorted;

  if (display.length === 0) {
    return <p style={{ color: 'var(--text-dim)', padding: 'var(--space-4)' }}>Nenhuma transacao encontrada.</p>;
  }

  return (
    <div className="finance-tx-list">
      {display.map((e) => {
        const isIncome = e.type === 'income';
        const color = CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.outros;
        const label = CATEGORY_LABELS[e.category] ?? e.category;

        return (
          <div key={e.id} className="finance-tx">
            <span className="finance-tx__date">{fmtDate(e.date)}</span>
            <span className="finance-tx__desc">{e.description}</span>
            <span className="finance-badge" style={{ background: color + '22', color, borderColor: color + '44' }}>
              {label}
            </span>
            <span className={`finance-tx__amount ${isIncome ? 'finance-tx__amount--income' : 'finance-tx__amount--expense'}`}>
              {isIncome ? '+' : '-'}{fmtBRL(e.amount)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
