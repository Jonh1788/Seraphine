import { useEffect, useMemo, useState } from "react";
import { Wallet, ArrowUpRight, ArrowDownRight, TrendingUp, Tag } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { MonthCalendar, type CalendarEvent } from "../components/MonthCalendar";
import { TabPills } from "../components/TabPills";
import { GlassCard } from "../components/GlassCard";
import * as financeApi from "../api/finance";
import type { FinanceBalance, FinanceSummary, FinancialEntry } from "../types/api";

function formatBRL(n: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(n);
}

export function FinancePage() {
  const now = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [view, setView] = useState("mes");
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [balance, setBalance] = useState<FinanceBalance | null>(null);
  const [entries, setEntries] = useState<FinancialEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, b, e] = await Promise.all([
          financeApi.getSummary({ month, year }),
          financeApi.getBalance(),
          financeApi.listEntries({ month, year, limit: 200 }),
        ]);
        if (!cancelled) {
          setSummary(s);
          setBalance(b);
          setEntries(e);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, year]);

  const events = useMemo<CalendarEvent[]>(
    () =>
      entries
        .filter((e): e is FinancialEntry & { date: string } =>
          typeof e.date === "string" && e.date.length >= 10,
        )
        .map((e) => ({
          date: e.date.slice(0, 10),
          color: e.type === "income" ? "green" : "red",
        })),
    [entries],
  );

  const topCategory = useMemo(() => {
    if (!summary || !summary.by_category) return null;
    const pairs = Object.entries(summary.by_category);
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    return { name: pairs[0][0], value: pairs[0][1] };
  }, [summary]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={Wallet}
        title="Finanças"
        subtitle="Controle suas receitas e despesas"
        color="green"
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Saldo atual"
          value={formatBRL(balance?.balance ?? 0)}
          color="green"
        />
        <StatCard
          icon={ArrowUpRight}
          label="Receitas"
          value={formatBRL(summary?.income ?? 0)}
          color="green"
          hint="neste mês"
        />
        <StatCard
          icon={ArrowDownRight}
          label="Despesas"
          value={formatBRL(summary?.expenses ?? 0)}
          color="red"
          hint="neste mês"
        />
        <StatCard
          icon={Tag}
          label="Top categoria"
          value={topCategory?.name ?? "—"}
          color="orange"
          hint={topCategory ? formatBRL(topCategory.value) : "sem dados"}
        />
      </div>

      <GlassCard className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-mod-finance/15 ring-1 ring-mod-finance/30 grid place-items-center">
            <TrendingUp className="h-4 w-4 text-mod-finance" />
          </div>
          <div className="font-semibold">Visão financeira</div>
        </div>
        <TabPills
          items={[
            { id: "mes", label: "Mês" },
            { id: "semana", label: "Semana" },
            { id: "dia", label: "Dia" },
            { id: "categoria", label: "Categoria" },
            { id: "tendencia", label: "Tendência" },
          ]}
          active={view}
          onChange={setView}
          color="green"
        />
      </GlassCard>

      <div className="grid gap-3 lg:grid-cols-2">
        <MonthCalendar
          month={month}
          year={year}
          events={events}
          onChangeMonth={(m, y) => {
            setMonth(m);
            setYear(y);
          }}
        />

        <GlassCard className="flex flex-col">
          <div className="font-semibold mb-3">Últimos lançamentos</div>
          <div className="flex flex-col gap-2 flex-1 overflow-y-auto max-h-80">
            {entries.length === 0 ? (
              <div className="text-sm text-ink-faint text-center py-8">
                Nenhum lançamento no mês
              </div>
            ) : (
              entries.slice(0, 30).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-elevated/60 border border-white/5"
                >
                  <div
                    className={[
                      "h-8 w-8 rounded-md grid place-items-center shrink-0",
                      e.type === "income"
                        ? "bg-mod-finance/15 ring-1 ring-mod-finance/30 text-mod-finance"
                        : "bg-red-500/15 ring-1 ring-red-500/30 text-red-400",
                    ].join(" ")}
                  >
                    {e.type === "income" ? (
                      <ArrowUpRight className="h-4 w-4" />
                    ) : (
                      <ArrowDownRight className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-primary truncate">
                      {e.description ?? e.category}
                    </div>
                    <div className="text-xs text-ink-faint">
                      {e.category} · {new Date(e.date).toLocaleDateString("pt-BR")}
                    </div>
                  </div>
                  <div
                    className={[
                      "text-sm font-semibold shrink-0",
                      e.type === "income" ? "text-mod-finance" : "text-red-400",
                    ].join(" ")}
                  >
                    {e.type === "income" ? "+" : "-"}
                    {formatBRL(Math.abs(e.amount))}
                  </div>
                </div>
              ))
            )}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
