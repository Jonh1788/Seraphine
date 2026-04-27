import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Calendar,
  Check,
  CheckCircle2,
  CircleAlert,
  ListChecks,
  TrendingDown,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { HeroBriefing } from "../components/HeroBriefing";
import { InstallBanner } from "../pwa/InstallBanner";
import { getTodayBriefing, refreshBriefing, type Briefing } from "../api/briefing";
import * as tasksApi from "../api/tasks";
import * as financeApi from "../api/finance";
import { ApiError } from "../api/client";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useSwipeAction } from "../hooks/useSwipeAction";
import type { FinanceSummary, FinancialEntry, Task } from "../types/api";

interface KpiSpec {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone: "neutral" | "positive" | "negative" | "accent";
}

const TONE_CLASSES: Record<KpiSpec["tone"], string> = {
  neutral: "text-ink-primary",
  positive: "text-emerald-300",
  negative: "text-red-300",
  accent: "text-accent-blue-soft",
};

const TONE_BG: Record<KpiSpec["tone"], string> = {
  neutral: "bg-white/5 text-ink-dim",
  positive: "bg-emerald-500/15 text-emerald-300",
  negative: "bg-red-500/15 text-red-300",
  accent: "bg-accent-blue/15 text-accent-blue-soft",
};

function fmtBrl(v: number): string {
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

function shortName(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const local = email.split("@")[0] ?? "";
  if (!local) return undefined;
  const piece = local.split(/[._-]/)[0] ?? local;
  return piece.charAt(0).toUpperCase() + piece.slice(1);
}

export function HojePage() {
  const { user } = useAuth();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(true);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [recentEntries, setRecentEntries] = useState<FinancialEntry[]>([]);

  const loadBriefing = async () => {
    setBriefingLoading(true);
    setBriefingError(null);
    try {
      const b = await getTodayBriefing();
      setBriefing(b);
    } catch (err) {
      setBriefingError(
        err instanceof ApiError ? err.message : "Falha ao carregar briefing",
      );
    } finally {
      setBriefingLoading(false);
    }
  };

  const loadData = async () => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    try {
      const [openTasks, sum, entries] = await Promise.all([
        tasksApi.listTasks({ status: "pending", limit: 100 }),
        financeApi.getSummary({ month, year }),
        financeApi.listEntries({ month, year, limit: 5 }),
      ]);
      setTasks(openTasks);
      setSummary(sum);
      setRecentEntries(entries);
    } catch {
      // Best-effort: KPIs degrade individually below if data is missing.
    }
  };

  useEffect(() => {
    void loadBriefing();
    void loadData();
  }, []);

  const handleRefresh = useCallback(async () => {
    try {
      await refreshBriefing();
    } catch {
      /* tolerate */
    }
    await loadBriefing();
    await loadData();
  }, []);

  useRegisterPageRefresh(handleRefresh);

  const handleCompleteTask = useCallback(async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    try {
      await tasksApi.updateTaskStatus(taskId, "completed");
    } catch {
      // Reload to recover from optimistic-update mismatch.
      await loadData();
    }
  }, []);

  const todayIso = new Date().toISOString().slice(0, 10);
  const overdue = tasks.filter((t) => t.due_date && t.due_date < todayIso);
  const dueToday = tasks.filter((t) => t.due_date === todayIso);
  const upcomingTasks = [...tasks]
    .filter((t) => t.due_date)
    .sort((a, b) => {
      const da = `${a.due_date ?? ""}T${a.due_time ?? "23:59"}`;
      const db = `${b.due_date ?? ""}T${b.due_time ?? "23:59"}`;
      return da.localeCompare(db);
    })
    .slice(0, 3);

  const kpis: KpiSpec[] = [
    {
      label: "Tarefas hoje",
      value: String(dueToday.length),
      hint: tasks.length ? `${tasks.length} abertas` : undefined,
      icon: ListChecks,
      tone: dueToday.length > 0 ? "accent" : "neutral",
    },
    {
      label: "Atrasadas",
      value: String(overdue.length),
      hint: overdue.length > 0 ? "atenção" : "em dia",
      icon: CircleAlert,
      tone: overdue.length > 0 ? "negative" : "positive",
    },
    {
      label: "Saldo do mês",
      value: summary ? fmtBrl(summary.balance) : "—",
      hint: summary
        ? summary.balance >= 0
          ? "positivo"
          : "negativo"
        : undefined,
      icon: Wallet,
      tone: summary ? (summary.balance >= 0 ? "positive" : "negative") : "neutral",
    },
    {
      label: "Saídas",
      value: summary ? fmtBrl(summary.expenses) : "—",
      hint: summary && summary.income > 0
        ? `${Math.round((summary.expenses / summary.income) * 100)}% da renda`
        : undefined,
      icon: TrendingDown,
      tone: "neutral",
    },
  ];

  return (
    <div className="flex flex-col gap-5 max-w-5xl mx-auto">
      <InstallBanner />
      <HeroBriefing
        briefing={briefing}
        loading={briefingLoading}
        error={briefingError}
        greetingName={shortName(user?.email)}
        onRefresh={handleRefresh}
      />

      <ul className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <li
              key={k.label}
              className="rounded-xl2 border border-white/8 bg-bg-s1/70 p-4 flex flex-col gap-2 shadow-glass"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-ink-faint">
                  {k.label}
                </span>
                <span
                  className={[
                    "h-7 w-7 rounded-lg grid place-items-center",
                    TONE_BG[k.tone],
                  ].join(" ")}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
              </div>
              <div className={["font-mono text-2xl font-semibold tabular-nums", TONE_CLASSES[k.tone]].join(" ")}>
                {k.value}
              </div>
              {k.hint ? (
                <span className="text-xs text-ink-faint">{k.hint}</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title="Próximas tarefas"
          to="/tarefas"
          icon={ListChecks}
          empty="Nenhuma tarefa com prazo. Que paz."
        >
          {upcomingTasks.map((t) => (
            <SwipeableTaskRow
              key={t.id}
              task={t}
              todayIso={todayIso}
              onComplete={() => handleCompleteTask(t.id)}
            />
          ))}
        </SectionCard>

        <SectionCard
          title="Últimas transações"
          to="/financas"
          icon={Wallet}
          empty="Nenhuma transação no mês ainda."
        >
          {recentEntries.slice(0, 3).map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5">
              <span
                className={[
                  "h-7 w-7 rounded-lg grid place-items-center shrink-0",
                  e.type === "income"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-red-500/15 text-red-300",
                ].join(" ")}
              >
                {e.type === "income" ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-primary truncate">
                  {e.description ?? e.category}
                </div>
                <div className="text-xs text-ink-faint">
                  {e.date} · {e.category}
                </div>
              </div>
              <div
                className={[
                  "font-mono text-sm tabular-nums shrink-0",
                  e.type === "income" ? "text-emerald-300" : "text-red-300",
                ].join(" ")}
              >
                {e.type === "income" ? "+" : "−"}
                {fmtBrl(e.amount)}
              </div>
            </li>
          ))}
        </SectionCard>
      </div>

      <div className="flex items-center justify-between rounded-xl2 border border-white/8 bg-bg-s1/40 p-4">
        <div className="flex items-center gap-3">
          <span className="h-9 w-9 rounded-xl bg-mod-tasks/15 text-mod-tasks grid place-items-center">
            <Calendar className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm text-ink-primary">Calendário</div>
            <div className="text-xs text-ink-faint">Eventos do dia e da semana</div>
          </div>
        </div>
        <Link
          to="/calendario"
          className="inline-flex items-center gap-1.5 text-sm text-accent-blue-soft hover:text-accent-blue px-3 py-2 rounded-lg hover:bg-accent-blue/10 min-h-10"
        >
          Abrir
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {tasks.length > 0 && (
        <p className="text-xs text-ink-faint flex items-center gap-1.5 self-center">
          <CheckCircle2 className="h-3 w-3" />
          {tasks.length} tarefa(s) abertas no total.
        </p>
      )}
    </div>
  );
}

interface SectionCardProps {
  title: string;
  to: string;
  icon: LucideIcon;
  empty: string;
  children: React.ReactNode;
}

function SectionCard({ title, to, icon: Icon, empty, children }: SectionCardProps) {
  const items = Array.isArray(children) ? children : [children];
  const hasContent = items.some((c) => c !== null && c !== false && c !== undefined);
  return (
    <section className="rounded-xl2 border border-white/8 bg-bg-s1/70 shadow-glass overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 text-ink-primary">
          <Icon className="h-4 w-4 text-ink-dim" />
          <span className="font-display text-sm font-semibold">{title}</span>
        </div>
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-xs text-ink-dim hover:text-accent-blue-soft transition-colors px-2 py-1.5 rounded-md hover:bg-white/5 min-h-9"
        >
          Ver tudo
          <ArrowRight className="h-3 w-3" />
        </Link>
      </header>
      {hasContent ? (
        <ul className="divide-y divide-white/5 px-4">{children}</ul>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-ink-faint">{empty}</div>
      )}
    </section>
  );
}

interface SwipeableTaskRowProps {
  task: Task;
  todayIso: string;
  onComplete: () => void;
}

function SwipeableTaskRow({ task, todayIso, onComplete }: SwipeableTaskRowProps) {
  const swipe = useSwipeAction({
    onSwipeRight: onComplete,
    threshold: 80,
  });

  const dotClass =
    task.due_date && task.due_date < todayIso
      ? "bg-red-400"
      : task.due_date === todayIso
        ? "bg-accent-blue-soft"
        : "bg-ink-faint/60";

  return (
    <li className="relative overflow-hidden -mx-4 px-0">
      <div
        className={[
          "absolute inset-y-0 left-0 flex items-center pl-4 pr-3 gap-2 text-emerald-300 transition-opacity",
          swipe.dx > 12 ? "opacity-100" : "opacity-0",
        ].join(" ")}
        aria-hidden="true"
      >
        <span
          className={[
            "h-7 w-7 rounded-full grid place-items-center",
            swipe.rightArmed
              ? "bg-emerald-500/30 text-emerald-200"
              : "bg-emerald-500/15",
          ].join(" ")}
        >
          <Check className="h-3.5 w-3.5" />
        </span>
        <span className="text-xs font-medium uppercase tracking-wider">
          {swipe.rightArmed ? "Concluir" : "Arraste"}
        </span>
      </div>
      <div
        {...swipe.bindings}
        style={swipe.bindings.style}
        className="relative flex items-start gap-3 py-2.5 px-4 bg-bg-s1/95 select-none"
      >
        <span className={`h-2 w-2 rounded-full mt-2 shrink-0 ${dotClass}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink-primary truncate">{task.title}</div>
          <div className="text-xs text-ink-faint">
            {task.due_date}
            {task.due_time ? ` · ${task.due_time}` : ""}
          </div>
        </div>
        {task.priority === "high" ? (
          <span className="text-[10px] uppercase tracking-wider text-red-300 self-center">
            alta
          </span>
        ) : null}
      </div>
    </li>
  );
}
