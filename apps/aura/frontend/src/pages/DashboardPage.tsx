import { useEffect, useMemo, useState } from "react";
import { CalendarDays, DollarSign, MoreHorizontal, Sparkles } from "lucide-react";
import { GreetingHeader } from "../components/GreetingHeader";
import { FilterPillBar, type FilterPill } from "../components/FilterPillBar";
import { CalendarToolbar, type CalendarView } from "../components/CalendarToolbar";
import { MonthCalendar, type CalendarEvent } from "../components/MonthCalendar";
import { DayDetailPanel } from "../components/DayDetailPanel";
import { BriefingCard } from "../components/BriefingCard";
import { AtividadeRecenteCard } from "../components/AtividadeRecenteCard";
import { CentroOperacoes } from "../components/CentroOperacoes";
import { EquilibrioBars } from "../components/EquilibrioBars";
import { InsightsCard } from "../components/InsightsCard";
import * as financeApi from "../api/finance";
import * as tasksApi from "../api/tasks";
import type { FinanceSummary, FinancialEntry, Task } from "../types/api";

const MONTH_NAMES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

const FILTERS: FilterPill[] = [
  { key: "agenda", label: "Agenda", icon: CalendarDays, color: "cyan" },
  { key: "financas", label: "Finanças", icon: DollarSign, color: "green" },
  { key: "projecoes", label: "Projeções", icon: Sparkles, color: "purple" },
  { key: "outros", label: "Outros", icon: MoreHorizontal, color: "slate" },
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function DashboardPage() {
  const now = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [selected, setSelected] = useState<string>(isoDate(now));
  const [view, setView] = useState<CalendarView>("month");
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    () => new Set(["agenda", "financas", "projecoes", "outros"]),
  );
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [entries, setEntries] = useState<FinancialEntry[]>([]);
  const todayIso = isoDate(now);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, t, e] = await Promise.all([
          financeApi.getSummary({ month, year }),
          tasksApi.listTasks({ limit: 200 }),
          financeApi.listEntries({ month, year, limit: 500 }),
        ]);
        if (!cancelled) {
          setSummary(s);
          setTasks(t);
          setEntries(e);
        }
      } catch {
        // ignore — dashboard is non-blocking
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, year]);

  const showAgenda = activeFilters.has("agenda");
  const showFinancas = activeFilters.has("financas");
  // 'projecoes' and 'outros' have no backing data yet — toggling them
  // is a visual no-op until those modules ship.

  const events = useMemo<CalendarEvent[]>(() => {
    const taskEvents: CalendarEvent[] = showAgenda
      ? tasks
          .filter((t) => t.due_date)
          .map((t) => ({
            date: (t.due_date ?? "").slice(0, 10),
            color:
              t.status === "completed"
                ? "green"
                : t.status === "approved"
                  ? "purple"
                  : "blue",
          }))
      : [];
    const financeEvents: CalendarEvent[] = showFinancas
      ? entries.map((e) => ({
          date: (e.date ?? "").slice(0, 10),
          color: e.type === "income" ? "green" : "red",
        }))
      : [];
    return [...taskEvents, ...financeEvents];
  }, [tasks, entries, showAgenda, showFinancas]);

  const selectedEvents = useMemo(() => {
    const taskItems = showAgenda
      ? tasks
          .filter((t) => (t.due_date ?? "").slice(0, 10) === selected)
          .map((t) => ({ id: `task-${t.id}`, title: t.title }))
      : [];
    const entryItems = showFinancas
      ? entries
          .filter((e) => (e.date ?? "").slice(0, 10) === selected)
          .map((e) => {
            const sign = e.type === "income" ? "+" : "-";
            const amt = e.amount.toLocaleString("pt-BR", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            return {
              id: `entry-${e.id}`,
              title: `${e.description} · ${sign}R$ ${amt}`,
            };
          })
      : [];
    return [...entryItems, ...taskItems];
  }, [tasks, entries, selected, showAgenda, showFinancas]);

  const pendingTasks = tasks.filter((t) => t.status === "pending").length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const approvedTasks = tasks.filter((t) => t.status === "approved").length;

  // Briefing — today
  const todayTasks = tasks.filter((t) => (t.due_date ?? "").slice(0, 10) === todayIso);
  const todayDone = todayTasks.filter((t) => t.status === "completed").length;

  // Finance mini — rough per-day average based on days elapsed in month.
  const income = summary?.income ?? 0;
  const expenses = summary?.expenses ?? 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  const perDay = Math.round(expenses / Math.max(1, daysInMonth));
  const savedPct = income > 0 ? Math.max(0, Math.round(((income - expenses) / income) * 100)) : 0;

  const goPrev = () => {
    const m = month === 1 ? 12 : month - 1;
    const y = month === 1 ? year - 1 : year;
    setMonth(m);
    setYear(y);
  };
  const goNext = () => {
    const m = month === 12 ? 1 : month + 1;
    const y = month === 12 ? year + 1 : year;
    setMonth(m);
    setYear(y);
  };
  const goToday = () => {
    const d = new Date();
    setMonth(d.getMonth() + 1);
    setYear(d.getFullYear());
    setSelected(isoDate(d));
  };

  const toggleFilter = (key: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedDate = selected ? parseIso(selected) : null;

  return (
    <div className="flex flex-col gap-5">
      <GreetingHeader />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterPillBar filters={FILTERS} active={activeFilters} onToggle={toggleFilter} />
      </div>

      <CalendarToolbar
        view={view}
        onViewChange={setView}
        onToday={goToday}
        onPrev={goPrev}
        onNext={goNext}
        label={`${MONTH_NAMES[month - 1]} ${year}`}
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <MonthCalendar
            month={month}
            year={year}
            selected={selected}
            events={events}
            onChangeMonth={(m, y) => {
              setMonth(m);
              setYear(y);
            }}
            onSelectDate={setSelected}
            hideHeader
          />
        </div>
        <div className="lg:col-span-1">
          <DayDetailPanel date={selectedDate} events={selectedEvents} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BriefingCard done={todayDone} total={todayTasks.length} />
        <AtividadeRecenteCard />
      </div>

      <CentroOperacoes
        tarefas={{ done: completedTasks, pending: pendingTasks + approvedTasks }}
        projetos={{ done: 0, active: 0 }}
        financeiro={{ income, expenses, savedPct, perDay }}
        habitosCount={0}
        radarValues={[0, 0, 0, 0, 0]}
      />

      <EquilibrioBars />

      <InsightsCard />
    </div>
  );
}
