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

/** Relative day for compact meta: Hoje / Ontem / N dias / dd/mm */
function relativeDay(iso: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, (m || 1) - 1, d || 1);
  const diff = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diff <= 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  if (diff < 7) return `${diff} dias`;
  return fmtDateShort(iso);
}

/** Strip leading emoji from a CATEGORY_LABELS value (e.g. "🏠 Moradia" → "Moradia") */
function stripCategoryEmoji(text: string): string {
  return text.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '');
}

/** Up-right / down-right directional glyph rendered in the category color (no emoji). */
function DirectionGlyph({ isIncome, color }: { isIncome: boolean; color: string }): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {isIncome ? <path d="M7 17L17 7M9 7h8v8" /> : <path d="M17 7L7 17M15 17H7V9" />}
    </svg>
  );
}

interface TransactionListProps {
  entries: FinanceEntry[];
  limit?: number;
  /** Flat list (no date-group headers), single-line "Hoje · Categoria" meta. Used in the dashboard recent panel. */
  compact?: boolean;
}

/** One transaction row — flat, with a category-tinted rounded-square tile. */
function TxRow({ entry, index }: { entry: FinanceEntry; index: number }): JSX.Element {
  const isIncome = entry.type === 'income';
  const color = CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.outros;
  const label = stripCategoryEmoji(CATEGORY_LABELS[entry.category] ?? entry.category);

  return (
    <div className="finance-tx" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="finance-tx__icon" style={{ background: `${color}29` }}>
        <DirectionGlyph isIncome={isIncome} color={color} />
      </div>

      <div className="finance-tx__content">
        <div className="finance-tx__desc">{entry.description}</div>
        <div className="finance-tx__meta">
          <span>{relativeDay(entry.date)}</span>
          <span className="finance-tx__separator">&middot;</span>
          <span>{label}</span>
          {entry.source && (
            <>
              <span className="finance-tx__separator">&middot;</span>
              <span className="finance-tx__source">{entry.source}</span>
            </>
          )}
        </div>
      </div>

      <span
        className={`finance-tx__amount ${isIncome ? 'finance-tx__amount--income' : 'finance-tx__amount--expense'}`}
      >
        {isIncome ? '+' : '-'}{fmtBRL(entry.amount)}
      </span>
    </div>
  );
}

export function TransactionList({ entries, limit, compact = false }: TransactionListProps): JSX.Element {
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

  // Compact (dashboard recent panel): flat list, hairline dividers, no date-group headers.
  if (compact) {
    return (
      <div className="finance-tx-list finance-tx-list--compact">
        {limited.map((e, i) => (
          <TxRow key={e.id} entry={e} index={i} />
        ))}
      </div>
    );
  }

  // Full Transações tab: keep date-group headers.
  return (
    <div className="finance-tx-list">
      {groups.map(([date, items]) => (
        <div key={date} className="finance-tx-group">
          <div className="finance-tx-group__date">{formatDateHeader(date)}</div>
          <div className="finance-tx-group__items">
            {items.map((e, i) => (
              <TxRow key={e.id} entry={e} index={i} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
