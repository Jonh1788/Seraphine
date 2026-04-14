import { TrendingUp, TrendingDown, Calendar as CalendarIcon, DollarSign } from "lucide-react";
import type { InlineTransaction } from "../api/chat";

interface Props {
  transactions: InlineTransaction[];
}

function fmtMoney(n: number): string {
  // Locale formatting with thousands sep + 2 decimals.
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateShort(iso: string): string {
  // YYYY-MM-DD → "DD/MM"
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}`;
}

function totalSigned(items: InlineTransaction[]): number {
  return items.reduce(
    (acc, t) => acc + (t.type === "income" ? t.amount : -t.amount),
    0,
  );
}

export function TransactionsBlock({ transactions }: Props) {
  if (transactions.length === 0) return null;
  const total = totalSigned(transactions);
  const totalSign = total >= 0 ? "+" : "-";
  const totalColor = total >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <div className="my-3 border-l-2 border-emerald-500/50 pl-4">
      {/* Header summary */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-emerald-500/15 grid place-items-center">
            <TrendingUp className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink-primary">Transações</div>
            <div className="text-xs text-ink-faint">
              {transactions.length} {transactions.length === 1 ? "transação" : "transações"}
            </div>
          </div>
        </div>
        <div className="text-sm">
          <span className="text-ink-dim mr-1">Saldo:</span>
          <span className={`font-semibold ${totalColor}`}>
            {totalSign}R$ {fmtMoney(Math.abs(total))}
          </span>
        </div>
      </div>

      {/* Per-transaction cards */}
      <div className="flex flex-col gap-2">
        {transactions.map((t) => (
          <Card key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}

function Card({ t }: { t: InlineTransaction }) {
  const isIncome = t.type === "income";
  const Icon = isIncome ? TrendingUp : TrendingDown;
  const sign = isIncome ? "+" : "-";
  // Static class names so Tailwind's JIT can include them in the build.
  const iconBg = isIncome ? "bg-emerald-500/15" : "bg-red-500/15";
  const iconFg = isIncome ? "text-emerald-400" : "text-red-400";
  const amountFg = isIncome ? "text-emerald-400" : "text-red-400";
  const labelFg = isIncome ? "text-emerald-400/80" : "text-red-400/80";

  return (
    <div className="flex items-start gap-3 rounded-lg bg-white/[0.03] border border-white/5 p-3">
      <div className={`h-9 w-9 rounded-full grid place-items-center shrink-0 ${iconBg}`}>
        <Icon className={`h-4 w-4 ${iconFg}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-ink-primary">{t.description}</div>
        <div className="flex items-center gap-2 mt-1 text-xs text-ink-faint">
          <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2 py-0.5">
            <DollarSign className="h-3 w-3" />
            <span className="capitalize">{t.category}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarIcon className="h-3 w-3" />
            {fmtDateShort(t.date)}
          </span>
        </div>
      </div>
      <div className="text-right">
        <div className={`text-[15px] font-semibold ${amountFg}`}>
          {sign}R$ {fmtMoney(t.amount)}
        </div>
        <div className={`text-xs mt-0.5 ${labelFg}`}>
          {isIncome ? "Receita" : "Despesa"}
        </div>
      </div>
    </div>
  );
}
