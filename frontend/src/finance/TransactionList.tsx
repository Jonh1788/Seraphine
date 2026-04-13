import { useMemo } from 'react';
import type { FinanceEntry } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from './types';

const currencyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function fmtBRL(value: number): string {
  return currencyFmt.format(value);
}

function formatDateHeader(isoDate: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (isoDate === today) return 'Hoje';
  if (isoDate === yesterday) return 'Ontem';
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
}

function fmtDateShort(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

interface TransactionListProps {
  entries: FinanceEntry[];
  limit?: number;
}

export function TransactionList({ entries, limit }: TransactionListProps): JSX.Element {
  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.date.localeCompare(a.date)),
    [entries],
  );

  const limited = limit ? sorted.slice(0, limit) : sorted;

  const groups = useMemo(() => {
    const map = new Map<string, FinanceEntry[]>();
    for (const e of limited) {
      const key = e.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [limited]);

  if (limited.length === 0) {
    return (
      <p className="finance-tx-empty">
        Nenhuma transacao encontrada.
      </p>
    );
  }

  return (
    <div className="finance-tx-list">
      {groups.map(([date, items]) => (
        <div key={date} className="finance-tx-group">
          <div className="finance-tx-group__date">{formatDateHeader(date)}</div>
          <div className="finance-tx-group__items">
            {items.map((e, i) => {
              const isIncome = e.type === 'income';
              const color = CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.outros;
              const label = CATEGORY_LABELS[e.category] ?? e.category;

              return (
                <div
                  key={e.id}
                  className="finance-tx"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <div
                    className={`finance-tx__icon ${isIncome ? 'finance-tx__icon--income' : 'finance-tx__icon--expense'}`}
                  >
                    {isIncome ? '\u2191' : '\u2193'}
                  </div>

                  <div className="finance-tx__content">
                    <div className="finance-tx__desc">{e.description}</div>
                    <div className="finance-tx__meta">
                      <span
                        className="finance-tx__category-dot"
                        style={{ background: color }}
                      />
                      <span>{label}</span>
                      <span className="finance-tx__separator">&middot;</span>
                      <span>{fmtDateShort(e.date)}</span>
                      {e.source && (
                        <>
                          <span className="finance-tx__separator">&middot;</span>
                          <span className="finance-tx__source">{e.source}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <span
                    className={`finance-tx__amount ${isIncome ? 'finance-tx__amount--income' : 'finance-tx__amount--expense'}`}
                  >
                    {isIncome ? '+' : '-'}{fmtBRL(e.amount)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
