import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Briefcase,
  Loader2,
  Plus,
  ShoppingBag,
  Sparkles as SparklesIcon,
  Star,
} from "lucide-react";
import * as financeApi from "../api/finance";
import type {
  EntryStatus,
  EntryType,
  FinanceSummary,
  FinancialEntry,
} from "../types/api";
import { ApiError } from "../api/client";
import { Sheet } from "../components/Sheet";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useCountUp } from "../hooks/useCountUp";

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const WEEKDAYS_SHORT = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number | string }>> = {
  alimentacao: ShoppingBag,
  transporte: ArrowDownLeft,
  trabalho: Briefcase,
  lazer: SparklesIcon,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtBrl(v: number, signed = false): string {
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
  if (!signed) return formatted;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${formatted}`;
}

function fmtBrlDecimal(v: number): string {
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dayHeader(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  const wd = WEEKDAYS_SHORT[date.getDay()];
  return `${wd} · ${pad2(d)}/${pad2(m)}`;
}

function categoryIcon(category: string | null | undefined, type: EntryType): React.ReactNode {
  const key = (category ?? "").toLowerCase();
  if (CATEGORY_ICONS[key]) {
    const Icon = CATEGORY_ICONS[key];
    return <Icon className="h-4 w-4" strokeWidth={2.2} />;
  }
  return type === "income" ? (
    <ArrowUpRight className="h-4 w-4" strokeWidth={2.2} />
  ) : (
    <ArrowDownLeft className="h-4 w-4" strokeWidth={2.2} />
  );
}

interface DayGroup {
  iso: string;
  items: FinancialEntry[];
}

function groupByDay(entries: FinancialEntry[]): DayGroup[] {
  const map = new Map<string, FinancialEntry[]>();
  for (const e of entries) {
    if (!e.date) continue;
    const key = e.date.slice(0, 10);
    const arr = map.get(key) ?? [];
    arr.push(e);
    map.set(key, arr);
  }
  const groups: DayGroup[] = Array.from(map.entries()).map(([iso, items]) => ({
    iso,
    items: items.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")),
  }));
  groups.sort((a, b) => b.iso.localeCompare(a.iso));
  return groups;
}

export function FinancePage() {
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [prevSummary, setPrevSummary] = useState<FinanceSummary | null>(null);
  const [entries, setEntries] = useState<FinancialEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const today = useMemo(() => new Date(), []);
  const month = today.getMonth() + 1;
  const year = today.getFullYear();
  const prevMonthDate = useMemo(() => {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 1);
    return d;
  }, [today]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, ents, prev] = await Promise.all([
        financeApi.getSummary({ month, year }),
        financeApi.listEntries({ month, year, limit: 200 }),
        financeApi
          .getSummary({ month: prevMonthDate.getMonth() + 1, year: prevMonthDate.getFullYear() })
          .catch(() => null),
      ]);
      setSummary(sum);
      setEntries(ents);
      setPrevSummary(prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao carregar finanças");
    } finally {
      setLoading(false);
    }
    // intentionally exclude prevMonthDate to avoid refetch loop on re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year]);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  const balance = summary?.balance ?? 0;
  const income = summary?.income ?? 0;
  const expenses = summary?.expenses ?? 0;
  const totalFlow = income + expenses;
  const inPct = totalFlow > 0 ? Math.round((income / totalFlow) * 100) : 0;
  const outPct = totalFlow > 0 ? 100 - inPct : 0;

  const prevBalance = prevSummary?.balance ?? 0;
  const trendDelta = balance - prevBalance;

  const savedPct = income > 0 ? Math.max(0, Math.min(100, Math.round((balance / income) * 100))) : 0;
  const burnPerDay = useMemo(() => {
    const dayOfMonth = today.getDate();
    return dayOfMonth > 0 ? expenses / dayOfMonth : 0;
  }, [expenses, today]);

  const groups = useMemo(() => groupByDay(entries), [entries]);

  const topCategories = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const e of entries) {
      if (e.type !== "expense") continue;
      const cat = e.category || "Outros";
      byCat.set(cat, (byCat.get(cat) ?? 0) + e.amount);
    }
    const arr = Array.from(byCat.entries()).map(([name, total]) => ({ name, total }));
    arr.sort((a, b) => b.total - a.total);
    return arr.slice(0, 4);
  }, [entries]);
  const topMax = topCategories[0]?.total ?? 1;

  const txCount = entries.length;

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  const animBalance = useCountUp(Math.abs(balance), 950, balance);

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Finanças
        </h1>
        <span className="ml-auto text-[11px] font-mono" style={{ color: "#4D5E8A" }}>
          {MONTHS_PT[today.getMonth()]} · {year}
        </span>
      </div>

      {/* fin-hero gradient verde */}
      <section
        className="relative mx-4 mb-3.5 px-5 py-5 overflow-hidden screen-item"
        style={{
          ...animDelay(1),
          borderRadius: 22,
          background: "linear-gradient(135deg, #0F4339 0%, #0A2C26 60%, #061E1A 100%)",
          border: "1px solid rgba(45,212,191,0.25)",
        }}
      >
        <div
          aria-hidden="true"
          className="absolute pointer-events-none rounded-full"
          style={{
            top: -40,
            right: -40,
            width: 180,
            height: 180,
            background: "radial-gradient(circle, rgba(45,212,191,0.18), transparent 70%)",
          }}
        />
        <div className="relative">
          <div
            className="text-[10px] font-bold tracking-[0.16em] uppercase mb-1.5"
            style={{ color: "#2DD4BF", opacity: 0.9 }}
          >
            Patrimônio do Mês
          </div>
          <div
            className="font-mono leading-none mb-2"
            style={{
              color: balance < 0 ? "#FF5B72" : "#EEF2FF",
              fontSize: 36,
              fontWeight: 500,
              letterSpacing: "-0.02em",
            }}
          >
            {balance < 0 ? "−" : ""}
            {fmtBrl(animBalance)}
          </div>
          <div
            className="inline-flex items-center gap-1.5 text-[11px] font-medium"
            style={{ color: trendDelta >= 0 ? "#2DD4BF" : "#FF5B72" }}
          >
            {trendDelta >= 0 ? (
              <ArrowUpRight className="h-3 w-3" strokeWidth={2.4} />
            ) : (
              <ArrowDownLeft className="h-3 w-3" strokeWidth={2.4} />
            )}
            {prevSummary
              ? `${trendDelta >= 0 ? "+" : "−"}${fmtBrl(trendDelta)} vs ${MONTHS_PT[prevMonthDate.getMonth()].toLowerCase()}`
              : "primeiro mês"}
          </div>
        </div>
      </section>

      {/* fin-io-card */}
      <section
        className="mx-4 mb-3.5 p-4 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] screen-item"
        style={animDelay(2)}
      >
        <div className="flex gap-4 mb-3">
          <div className="flex-1">
            <div
              className="text-[10px] font-semibold tracking-[0.08em] uppercase mb-1"
              style={{ color: "#2DD4BF" }}
            >
              Receitas
            </div>
            <div className="font-mono text-[18px] font-medium tracking-[-0.01em]" style={{ color: "#2DD4BF" }}>
              {fmtBrl(income)}
            </div>
          </div>
          <div className="flex-1">
            <div
              className="text-[10px] font-semibold tracking-[0.08em] uppercase mb-1"
              style={{ color: "#FF5B72" }}
            >
              Despesas
            </div>
            <div className="font-mono text-[18px] font-medium tracking-[-0.01em]" style={{ color: "#FF5B72" }}>
              {fmtBrl(expenses)}
            </div>
          </div>
        </div>
        <FlowBar inPct={inPct} outPct={outPct} />
        <div className="flex flex-wrap gap-3.5 mt-2.5 text-[10px]" style={{ color: "#4D5E8A" }}>
          <div className="flex items-center gap-1.5">
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: "#2DD4BF" }} />
            {savedPct}% guardado
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: "#FF5B72" }} />
            ~{fmtBrlDecimal(burnPerDay)}/dia
          </div>
        </div>
      </section>

      {/* tx-list */}
      <section
        className="mx-4 mb-3.5 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] overflow-hidden screen-item"
        style={animDelay(3)}
      >
        {loading && entries.length === 0 ? (
          <div className="grid place-items-center py-10" style={{ color: "#4D5E8A" }}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px]" style={{ color: "#4D5E8A" }}>
            Sem transações neste mês ainda.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.iso}>
              <div
                className="px-4 py-2.5 font-mono text-[10px] font-medium tracking-[0.14em]"
                style={{
                  color: "#4D5E8A",
                  background: "rgba(0,0,0,0.2)",
                  borderBottom: "1px solid rgba(99,130,255,0.10)",
                }}
              >
                {dayHeader(g.iso)}
              </div>
              {g.items.map((e, i) => (
                <TxItem key={e.id} entry={e} isLast={i === g.items.length - 1} />
              ))}
            </div>
          ))
        )}
      </section>

      {/* analysis-card */}
      <section
        className="mx-4 mb-3.5 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] overflow-hidden screen-item"
        style={animDelay(4)}
      >
        <div className="px-4 pt-3.5 pb-2.5 border-b border-[rgba(99,130,255,0.10)]">
          <h3 className="font-display text-[13px] font-semibold tracking-tight text-[#EEF2FF]">
            Análise do Mês
          </h3>
        </div>
        <div className="grid grid-cols-2">
          <AcCell label="Transações" value={String(txCount)} />
          <AcCell label="Receitas" value={fmtBrl(income)} tone="green" border />
          <AcCell label="Despesas" value={fmtBrl(expenses)} tone="red" />
          <AcCell label="Patrimônio" value={fmtBrl(balance)} tone={balance >= 0 ? "green" : "red"} border />
        </div>

        <div className="px-4 py-3.5 border-t border-[rgba(99,130,255,0.10)]">
          <h4 className="text-[12px] font-semibold tracking-tight text-[#EEF2FF] mb-2">
            Ritmo do Mês
          </h4>
          <RhythmRow label="Gasto diário" value={fmtBrlDecimal(burnPerDay) + "/dia"} />
          <RhythmRow
            label="Economia"
            value={(savedPct >= 0 ? "+" : "") + savedPct + "% economizado"}
            tone={savedPct >= 50 ? "green" : savedPct >= 20 ? "amber" : "red"}
          />
        </div>

        {topCategories.length > 0 ? (
          <div className="px-4 py-3.5 border-t border-[rgba(99,130,255,0.10)]">
            <h4 className="text-[12px] font-semibold tracking-tight text-[#EEF2FF] mb-2">
              Top Categorias
            </h4>
            {topCategories.map((c, i) => (
              <CatRow
                key={c.name}
                name={c.name}
                amount={c.total}
                ratio={c.total / topMax}
                rank={i}
              />
            ))}
          </div>
        ) : null}

        <FinHealthPill saved={savedPct} balance={balance} />
      </section>

      {error ? (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg text-[11px]" style={{
          background: "rgba(255,91,114,0.12)",
          border: "1px solid rgba(255,91,114,0.2)",
          color: "#FF5B72",
        }}>
          {error}
        </div>
      ) : null}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setNewOpen(true)}
        aria-label="Nova transação"
        className="fixed grid place-items-center transition-transform active:scale-95"
        style={{
          right: 20,
          bottom: "calc(var(--safe-bottom) + 24px)",
          width: 50,
          height: 50,
          borderRadius: 16,
          background: "#4F7EFF",
          color: "white",
          boxShadow: "0 4px 20px rgba(79,126,255,0.5), 0 0 0 1px rgba(79,126,255,0.3)",
          zIndex: 20,
        }}
      >
        <Plus className="h-[22px] w-[22px]" strokeWidth={2.5} />
      </button>

      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="Nova transação" maxWidth="max-w-md">
        <NewEntryForm
          busy={busy}
          onCancel={() => setNewOpen(false)}
          onCreate={async (body) => {
            setBusy(true);
            try {
              await financeApi.createEntry(body);
              setNewOpen(false);
              await load();
            } finally {
              setBusy(false);
            }
          }}
        />
      </Sheet>
    </div>
  );
}

function FlowBar({ inPct, outPct }: { inPct: number; outPct: number }) {
  const [w, setW] = useState({ in: 0, out: 0 });
  useEffect(() => {
    const id = window.setTimeout(() => setW({ in: inPct, out: outPct }), 200);
    return () => window.clearTimeout(id);
  }, [inPct, outPct]);
  return (
    <div className="flex h-[6px] rounded-full overflow-hidden" style={{ background: "#162040" }}>
      <div
        className="h-full"
        style={{
          width: `${w.in}%`,
          background: "#2DD4BF",
          boxShadow: "0 0 8px rgba(45,212,191,0.5)",
          transition: "width 1s cubic-bezier(0.2,0.9,0.3,1)",
        }}
      />
      <div
        className="h-full"
        style={{
          width: `${w.out}%`,
          background: "#FF5B72",
          boxShadow: "0 0 8px rgba(255,91,114,0.4)",
          transition: "width 1s cubic-bezier(0.2,0.9,0.3,1)",
        }}
      />
    </div>
  );
}

function TxItem({ entry, isLast }: { entry: FinancialEntry; isLast: boolean }) {
  const isIncome = entry.type === "income";
  const iconBg = isIncome
    ? { background: "rgba(45,212,191,0.12)", color: "#2DD4BF", border: "1px solid rgba(45,212,191,0.2)" }
    : { background: "rgba(255,91,114,0.12)", color: "#FF5B72", border: "1px solid rgba(255,91,114,0.2)" };

  return (
    <div
      className="flex items-center gap-3 px-4 py-3.5"
      style={!isLast ? { borderBottom: "1px solid rgba(99,130,255,0.10)" } : undefined}
    >
      <span
        className="h-9 w-9 rounded-[12px] grid place-items-center shrink-0"
        style={iconBg}
      >
        {categoryIcon(entry.category, entry.type)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[#EEF2FF] truncate">
          {entry.description ?? entry.category ?? (isIncome ? "Receita" : "Despesa")}
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: "#4D5E8A" }}>
          {entry.category ?? "Sem categoria"}
        </div>
      </div>
      <span
        className="font-mono text-[14px] font-medium shrink-0"
        style={{ color: isIncome ? "#2DD4BF" : "#FF5B72" }}
      >
        {isIncome ? "+" : "−"}{fmtBrl(entry.amount)}
      </span>
    </div>
  );
}

interface AcCellProps {
  label: string;
  value: string;
  tone?: "green" | "red" | "amber" | "default";
  border?: boolean;
}

function AcCell({ label, value, tone = "default", border }: AcCellProps) {
  const color =
    tone === "green" ? "#2DD4BF" : tone === "red" ? "#FF5B72" : tone === "amber" ? "#F5A623" : "#EEF2FF";
  return (
    <div
      className="px-3.5 py-3"
      style={{
        borderRight: !border ? "1px solid rgba(99,130,255,0.10)" : undefined,
        borderTop: undefined,
      }}
    >
      <div
        className="text-[9px] font-bold tracking-[0.12em] uppercase mb-1"
        style={{ color: "#4D5E8A" }}
      >
        {label}
      </div>
      <div
        className="font-mono text-[16px] font-medium tracking-[-0.01em]"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  );
}

function RhythmRow({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" | "amber" }) {
  const color =
    tone === "green" ? "#2DD4BF" : tone === "red" ? "#FF5B72" : tone === "amber" ? "#F5A623" : "#EEF2FF";
  return (
    <div className="flex justify-between items-center mb-1.5">
      <span className="text-[11px]" style={{ color: "#8B9CC8" }}>{label}</span>
      <span className="font-mono text-[12px]" style={{ color }}>{value}</span>
    </div>
  );
}

function CatRow({ name, amount, ratio, rank }: { name: string; amount: number; ratio: number; rank: number }) {
  const palette = ["#FF5B72", "#F5A623", "#A78BFA", "#7DA4FF"];
  const color = palette[rank % palette.length];
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setW(Math.max(4, Math.round(ratio * 100))), 200);
    return () => window.clearTimeout(id);
  }, [ratio]);
  return (
    <div className="flex items-center gap-2.5 mt-2">
      <span className="text-[11px] w-[88px] shrink-0 truncate" style={{ color: "#8B9CC8" }}>
        {name}
      </span>
      <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: "#162040" }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${w}%`,
            background: color,
            boxShadow: `0 0 6px ${color}80`,
            transition: "width 1s cubic-bezier(0.2,0.9,0.3,1)",
          }}
        />
      </div>
      <span className="font-mono text-[11px] w-[60px] text-right" style={{ color: "#4D5E8A" }}>
        {fmtBrl(amount)}
      </span>
    </div>
  );
}

function FinHealthPill({ saved, balance }: { saved: number; balance: number }) {
  const tone: "green" | "amber" | "red" =
    balance < 0 ? "red" : saved >= 30 ? "green" : "amber";
  const label =
    tone === "green"
      ? "Saúde financeira boa"
      : tone === "amber"
        ? "Atenção: economize mais"
        : "Saúde financeira ruim";
  const style: React.CSSProperties =
    tone === "green"
      ? { background: "rgba(45,212,191,0.12)", border: "1px solid rgba(45,212,191,0.25)", color: "#2DD4BF" }
      : tone === "amber"
        ? { background: "rgba(245,166,35,0.15)", border: "1px solid rgba(245,166,35,0.25)", color: "#F5A623" }
        : { background: "rgba(255,91,114,0.12)", border: "1px solid rgba(255,91,114,0.25)", color: "#FF5B72" };
  return (
    <div
      className="inline-flex items-center gap-1.5 m-3.5 px-3 py-2 rounded-full text-[11px] font-medium"
      style={style}
    >
      <Star className="h-3 w-3" strokeWidth={2.2} />
      {label}
    </div>
  );
}

interface NewEntryFormProps {
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: financeApi.CreateEntryBody) => Promise<void> | void;
}

function NewEntryForm({ busy, onCancel, onCreate }: NewEntryFormProps) {
  const [type, setType] = useState<EntryType>("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(() => isoLocal(new Date()));
  const [status, setStatus] = useState<EntryStatus>("paid");
  const [err, setErr] = useState<string | null>(null);

  const numericAmount = useMemo(() => {
    const v = parseFloat(amount.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(v) ? v : 0;
  }, [amount]);
  const canSubmit = numericAmount > 0 && category.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setErr(null);
    void onCreate({
      type,
      amount: numericAmount,
      currency: "BRL",
      category: category.trim(),
      description: description.trim() || undefined,
      date,
      status: type === "income" ? (status === "paid" ? "received" : status) : status,
    });
  };

  const inputStyle: React.CSSProperties = {
    background: "rgba(17,27,56,0.6)",
    border: "1px solid rgba(99,130,255,0.10)",
    color: "#EEF2FF",
  };

  const tabStyle = (active: boolean): React.CSSProperties =>
    active
      ? { background: "#162040", color: "#EEF2FF" }
      : { background: "transparent", color: "#4D5E8A" };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Tipo
        </span>
        <div
          className="flex p-[3px] gap-[2px] rounded-[10px]"
          style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}
        >
          <button
            type="button"
            onClick={() => setType("expense")}
            className="flex-1 px-3 py-2 rounded-[7px] text-[12px] font-medium transition-colors"
            style={tabStyle(type === "expense")}
          >
            Despesa
          </button>
          <button
            type="button"
            onClick={() => setType("income")}
            className="flex-1 px-3 py-2 rounded-[7px] text-[12px] font-medium transition-colors"
            style={tabStyle(type === "income")}
          >
            Receita
          </button>
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Valor (R$)
        </span>
        <input
          autoFocus
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0,00"
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none font-mono text-[16px]"
          style={inputStyle}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Categoria
        </span>
        <input
          required
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder={type === "income" ? "Ex.: Trabalho" : "Ex.: Alimentação"}
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={inputStyle}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Descrição (opcional)
        </span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex.: iFood almoço"
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={inputStyle}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Data
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Status
          </span>
          <div
            className="flex p-[3px] gap-[2px] rounded-[10px]"
            style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}
          >
            <button
              type="button"
              onClick={() => setStatus("paid")}
              className="flex-1 px-2 py-1.5 rounded-[7px] text-[11px] font-medium"
              style={tabStyle(status === "paid")}
            >
              {type === "income" ? "Recebido" : "Pago"}
            </button>
            <button
              type="button"
              onClick={() => setStatus("pending")}
              className="flex-1 px-2 py-1.5 rounded-[7px] text-[11px] font-medium"
              style={tabStyle(status === "pending")}
            >
              Pendente
            </button>
          </div>
        </label>
      </div>

      {err ? (
        <div className="text-[12px]" style={{ color: "#FF5B72" }}>{err}</div>
      ) : null}

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-[#EEF2FF]"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canSubmit || busy}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-white font-medium disabled:opacity-50"
          style={{ background: "#4F7EFF", boxShadow: "0 4px 20px rgba(79,126,255,0.5)" }}
        >
          {busy ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </form>
  );
}
