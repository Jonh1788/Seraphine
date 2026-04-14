import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  CalendarClock,
  ListChecks,
  Wallet,
  ArrowDownRight,
  ArrowUpRight,
} from "lucide-react";
import { GlassCard } from "../components/GlassCard";
import { StatCard } from "../components/StatCard";
import { MonthCalendar, type CalendarEvent } from "../components/MonthCalendar";
import * as financeApi from "../api/finance";
import * as tasksApi from "../api/tasks";
import type { FinanceSummary, Task } from "../types/api";

function formatBRL(n: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(n);
}

function isoToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function DashboardPage() {
  const now = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const today = isoToday();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, t] = await Promise.all([
          financeApi.getSummary({ month, year }),
          tasksApi.listTasks({ limit: 200 }),
        ]);
        if (!cancelled) {
          setSummary(s);
          setTasks(t);
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
      tasks
        .filter((t) => t.due_date)
        .map((t) => ({
          date: (t.due_date ?? "").slice(0, 10),
          color: t.status === "completed" ? "green" : t.status === "approved" ? "purple" : "blue",
        })),
    [tasks],
  );

  const completedToday = tasks.filter(
    (t) => t.status === "completed" && (t.due_date ?? "").slice(0, 10) === today,
  ).length;
  const pendingToday = tasks.filter(
    (t) => t.status === "pending" && (t.due_date ?? "").slice(0, 10) === today,
  ).length;
  const overdue = tasks.filter(
    (t) =>
      t.status !== "completed" &&
      t.due_date &&
      (t.due_date ?? "").slice(0, 10) < today,
  ).length;
  const upcoming = tasks.filter(
    (t) =>
      t.status !== "completed" &&
      t.due_date &&
      (t.due_date ?? "").slice(0, 10) > today,
  ).length;

  const monthTasks = tasks.filter((t) => {
    const d = (t.due_date ?? "").slice(0, 10);
    if (!d) return false;
    const [y, m] = d.split("-").map(Number);
    return y === year && m === month;
  });
  const monthCompleted = monthTasks.filter((t) => t.status === "completed").length;
  const monthPending = monthTasks.filter((t) => t.status === "pending").length;
  const monthApproved = monthTasks.filter((t) => t.status === "approved").length;
  const rate =
    monthTasks.length > 0 ? Math.round((monthCompleted / monthTasks.length) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <MonthCalendar month={month} year={year} events={events} onChangeMonth={(m, y) => {
        setMonth(m);
        setYear(y);
      }} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={CheckCircle2}
          label="Concluídas hoje"
          value={completedToday}
          color="green"
          hint="hoje"
        />
        <StatCard
          icon={Clock}
          label="Pendentes hoje"
          value={pendingToday}
          color="purple"
          hint={pendingToday === 0 ? "tudo em dia" : "em andamento"}
        />
        <StatCard
          icon={AlertTriangle}
          label="Atrasadas"
          value={overdue}
          color="red"
          hint={overdue > 0 ? "requerem atenção" : "sem pendências"}
        />
        <StatCard
          icon={CalendarClock}
          label="Próximos"
          value={upcoming}
          color="orange"
          hint="nos próximos dias"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <div className="h-8 w-8 rounded-md bg-mod-tasks/15 ring-1 ring-mod-tasks/30 grid place-items-center">
              <ListChecks className="h-4 w-4 text-mod-tasks" />
            </div>
            <div className="font-semibold">Tarefas — mês</div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-mod-finance/10 ring-1 ring-mod-finance/20 p-3 text-center">
              <div className="text-2xl font-bold text-mod-finance">{monthCompleted}</div>
              <div className="text-xs text-ink-dim mt-1">Concluídas</div>
            </div>
            <div className="rounded-lg bg-accent-purple/10 ring-1 ring-accent-purple/20 p-3 text-center">
              <div className="text-2xl font-bold text-accent-purple">{monthApproved}</div>
              <div className="text-xs text-ink-dim mt-1">Em andamento</div>
            </div>
            <div className="rounded-lg bg-mod-reminders/10 ring-1 ring-mod-reminders/20 p-3 text-center">
              <div className="text-2xl font-bold text-mod-reminders">{monthPending}</div>
              <div className="text-xs text-ink-dim mt-1">Pendentes</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-ink-dim flex items-center justify-between">
            <span>Taxa de conclusão</span>
            <span className="text-ink-primary font-medium">{rate}%</span>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <div className="h-8 w-8 rounded-md bg-mod-finance/15 ring-1 ring-mod-finance/30 grid place-items-center">
              <Wallet className="h-4 w-4 text-mod-finance" />
            </div>
            <div className="font-semibold">Resumo financeiro — mês</div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-ink-dim">
                <ArrowUpRight className="h-4 w-4 text-mod-finance" /> Receitas
              </div>
              <div className="text-mod-finance font-semibold">
                {formatBRL(summary?.income ?? 0)}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-ink-dim">
                <ArrowDownRight className="h-4 w-4 text-red-400" /> Despesas
              </div>
              <div className="text-red-400 font-semibold">
                {formatBRL(summary?.expenses ?? 0)}
              </div>
            </div>
            <div className="h-px bg-white/5" />
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Saldo do mês</div>
              <div
                className={[
                  "text-lg font-bold",
                  (summary?.balance ?? 0) >= 0 ? "text-mod-finance" : "text-red-400",
                ].join(" ")}
              >
                {formatBRL(summary?.balance ?? 0)}
              </div>
            </div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
