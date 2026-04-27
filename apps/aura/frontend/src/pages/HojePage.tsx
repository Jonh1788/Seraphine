import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  CreditCard,
  Folder,
  RefreshCw,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { AuraSphere } from "../aura/sphere/AuraSphere";
import { InstallBanner } from "../pwa/InstallBanner";
import { getTodayBriefing, refreshBriefing, type Briefing } from "../api/briefing";
import * as tasksApi from "../api/tasks";
import * as financeApi from "../api/finance";
import { ApiError } from "../api/client";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import type {
  FinanceSummary,
  FinancialEntry,
  Task,
  TaskPriority,
} from "../types/api";

const TYPE_INTERVAL_MS = 18;

const SEGMENT_CLASS: Record<string, string> = {
  text: "text-ink-dim",
  urgent: "text-aura-red font-medium",
  good: "text-aura-green font-medium",
  blue: "text-accent-blue-soft font-medium",
};

const TONE_VAL: Record<"blue" | "red" | "amber" | "green" | "purple", string> = {
  blue: "text-accent-blue-soft",
  red: "text-aura-red",
  amber: "text-aura-amber",
  green: "text-aura-green font-mono",
  purple: "text-aura-purple",
};

interface SnapKpi {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  value: string;
  tone: keyof typeof TONE_VAL;
  to?: string;
}

function fmtBrl(v: number): string {
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

function dateAbbr(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${d} de ${months[m - 1]}.`;
}

function shortName(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const local = email.split("@")[0] ?? "";
  if (!local) return undefined;
  const piece = local.split(/[._-]/)[0] ?? local;
  return piece.charAt(0).toUpperCase() + piece.slice(1);
}

function dotByPriority(p: TaskPriority | null | undefined): "red" | "amber" | "blue" {
  if (p === "high") return "red";
  if (p === "med") return "amber";
  return "blue";
}

export function HojePage() {
  const { user } = useAuth();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(true);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [recentEntries, setRecentEntries] = useState<FinancialEntry[]>([]);

  const loadBriefing = useCallback(async () => {
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
  }, []);

  const loadData = useCallback(async () => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    try {
      const [openTasks, sum, entries] = await Promise.all([
        tasksApi.listTasks({ status: "pending", limit: 200 }),
        financeApi.getSummary({ month, year }),
        financeApi.listEntries({ month, year, limit: 5 }),
      ]);
      setTasks(openTasks);
      setSummary(sum);
      setRecentEntries(entries);
    } catch {
      /* tolerate */
    }
  }, []);

  useEffect(() => {
    void loadBriefing();
    void loadData();
  }, [loadBriefing, loadData]);

  const handleRefresh = useCallback(async () => {
    try {
      await refreshBriefing();
    } catch {
      /* tolerate */
    }
    await Promise.all([loadBriefing(), loadData()]);
  }, [loadBriefing, loadData]);

  useRegisterPageRefresh(handleRefresh);

  const todayIso = new Date().toISOString().slice(0, 10);
  const overdue = useMemo(
    () => tasks.filter((t) => t.due_date && t.due_date < todayIso),
    [tasks, todayIso],
  );
  const dueToday = useMemo(
    () => tasks.filter((t) => t.due_date === todayIso),
    [tasks, todayIso],
  );
  const upcomingTasks = useMemo(
    () =>
      [...tasks]
        .sort((a, b) => {
          const da = `${a.due_date ?? "9999"}T${a.due_time ?? "23:59"}`;
          const db = `${b.due_date ?? "9999"}T${b.due_time ?? "23:59"}`;
          return da.localeCompare(db);
        })
        .slice(0, 4),
    [tasks],
  );

  const kpis: SnapKpi[] = [
    {
      label: "Tarefas",
      icon: CheckCircle2,
      iconClass: "text-accent-blue-soft",
      value: String(dueToday.length || tasks.length),
      tone: "blue",
      to: "/tarefas",
    },
    {
      label: "Atrasadas",
      icon: AlertTriangle,
      iconClass: "text-aura-red",
      value: String(overdue.length),
      tone: "red",
      to: "/tarefas",
    },
    {
      label: "Projetos",
      icon: Folder,
      iconClass: "text-aura-purple",
      value: "0",
      tone: "purple",
    },
    {
      label: "Saldo",
      icon: CreditCard,
      iconClass: "text-aura-green",
      value: summary ? fmtBrl(summary.balance) : "—",
      tone: "green",
      to: "/financas",
    },
  ];

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-bg-base">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleRefresh}
          disabled={briefingLoading}
          aria-label="Atualizar briefing"
          className="grid place-items-center h-9 w-9 rounded-xl bg-accent-blue-dim/40 border border-aura-border text-ink-dim hover:text-accent-blue-soft hover:border-accent-blue/30 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${briefingLoading ? "animate-spin" : ""}`} />
        </button>
        <Link
          to="/"
          aria-label="Fechar"
          title="Voltar pra Aura"
          className="grid place-items-center h-9 w-9 rounded-xl bg-accent-blue-dim/40 border border-aura-border text-ink-dim hover:text-accent-blue-soft hover:border-accent-blue/30 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </Link>
      </div>

      <InstallBanner />

      <SnapGridWithOrb kpis={kpis} />

      <SectionCard
        title="Prioridades"
        icon={CheckCircle2}
        iconColorClass="text-aura-green"
        count={String(upcomingTasks.length)}
        empty="Nenhuma tarefa pendente."
      >
        {upcomingTasks.map((t) => {
          const isOverdue = t.due_date != null && t.due_date < todayIso;
          const dot = isOverdue ? "red" : dotByPriority(t.priority);
          const meta = isOverdue
            ? dateAbbr(t.due_date)
            : t.due_date === todayIso
              ? "hoje"
              : t.due_date
                ? dateAbbr(t.due_date)
                : (t.priority?.toUpperCase() ?? "");
          return (
            <Link
              key={t.id}
              to="/tarefas"
              className="brief-prio-row flex items-center gap-3 px-4 py-3 hover:bg-bg-s2/60 transition-colors border-t border-aura-border first:border-t-0"
            >
              <PrioDot color={dot} />
              <span className="flex-1 text-[13px] text-ink-primary truncate">{t.title}</span>
              <span
                className={[
                  "flex items-center gap-1 text-[10px] tracking-wider shrink-0",
                  isOverdue
                    ? "text-aura-red"
                    : t.priority === "high"
                      ? "text-aura-red font-semibold uppercase"
                      : t.priority === "med"
                        ? "text-aura-amber font-semibold uppercase"
                        : "text-ink-faint",
                ].join(" ")}
              >
                {isOverdue ? <Clock className="h-2.5 w-2.5" /> : null}
                {meta}
              </span>
            </Link>
          );
        })}
      </SectionCard>

      <SectionCard
        title="Finanças"
        icon={Wallet}
        iconColorClass="text-aura-green"
        count={summary ? "3" : "—"}
        empty="Nenhuma transação no mês."
      >
        {summary ? (
          <>
            <FinRow
              name="Saldo do mês"
              value={fmtBrl(summary.balance)}
              positive={summary.balance >= 0}
            />
            <FinRow
              name="Receitas do mês"
              value={fmtBrl(summary.income)}
              positive
            />
            <FinRow
              name="Despesas do mês"
              value={fmtBrl(summary.expenses)}
              positive={false}
            />
          </>
        ) : null}
      </SectionCard>

      {recentEntries.length > 0 ? (
        <SectionCard
          title="Últimas transações"
          icon={Activity}
          iconColorClass="text-accent-blue-soft"
          count={String(recentEntries.length)}
        >
          {recentEntries.slice(0, 4).map((e) => (
            <FinRow
              key={e.id}
              name={e.description ?? e.category}
              value={fmtBrl(e.amount)}
              positive={e.type === "income"}
              meta={dateAbbr(e.date)}
            />
          ))}
        </SectionCard>
      ) : null}

      <BriefAnalise />

      <NarrationBottom
        briefing={briefing}
        loading={briefingLoading}
        error={briefingError}
        greetingName={shortName(user?.email)}
      />
    </div>
  );
}

interface SnapGridWithOrbProps {
  kpis: SnapKpi[];
}

function SnapGridWithOrb({ kpis }: SnapGridWithOrbProps) {
  return (
    <div className="relative px-4 pt-3 pb-4">
      <div className="grid grid-cols-2 gap-2.5">
        {kpis.map((k, i) => {
          const Inner = (
            <>
              <div className="flex items-center gap-1.5 text-[9px] font-bold tracking-[0.14em] uppercase text-ink-faint mb-1.5">
                <k.icon className={`h-3 w-3 ${k.iconClass}`} />
                {k.label}
              </div>
              <div className={`text-2xl leading-none font-bold tracking-tight ${TONE_VAL[k.tone]}`}>
                {k.value}
              </div>
            </>
          );
          const baseClass =
            "snap-card relative bg-bg-s1 border border-aura-border rounded-[14px] px-3.5 py-3 transition-all hover:bg-bg-s2 hover:border-aura-border2 hover:-translate-y-px";
          return k.to ? (
            <Link key={i} to={k.to} className={baseClass}>
              {Inner}
            </Link>
          ) : (
            <div key={i} className={baseClass}>
              {Inner}
            </div>
          );
        })}
      </div>
      {/* Mini orb sobreposta no centro do grid */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 86,
          height: 86,
          filter: "drop-shadow(0 0 14px rgba(79,126,255,0.55))",
        }}
        aria-hidden="true"
      >
        <AuraSphere variant="mini" state="idle" minimal />
      </div>
    </div>
  );
}

interface SectionCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColorClass: string;
  count?: string;
  empty?: string;
  children?: React.ReactNode;
}

function SectionCard({ title, icon: Icon, iconColorClass, count, empty, children }: SectionCardProps) {
  const items = Array.isArray(children) ? children : children ? [children] : [];
  const hasContent = items.some((c) => c);
  return (
    <section className="mx-4 mb-3.5 bg-bg-s1 border border-aura-border rounded-[18px] overflow-hidden">
      <header className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-aura-border">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-primary tracking-tight">
          <Icon className={`h-3.5 w-3.5 ${iconColorClass}`} />
          {title}
        </div>
        {count !== undefined ? (
          <span className="text-[11px] text-ink-faint">{count}</span>
        ) : null}
      </header>
      {hasContent ? (
        <div>{children}</div>
      ) : (
        <div className="px-4 py-7 text-center text-[12px] text-ink-faint">
          {empty}
        </div>
      )}
    </section>
  );
}

function PrioDot({ color }: { color: "red" | "amber" | "blue" }) {
  const cls =
    color === "red"
      ? "bg-aura-red"
      : color === "amber"
        ? "bg-aura-amber"
        : "bg-accent-blue-soft";
  const glow =
    color === "red"
      ? "rgba(255,91,114,0.55)"
      : color === "amber"
        ? "rgba(245,166,35,0.55)"
        : "rgba(125,164,255,0.55)";
  return (
    <span
      className={`h-[7px] w-[7px] rounded-full shrink-0 ${cls}`}
      style={{ boxShadow: `0 0 8px ${glow}` }}
    />
  );
}

interface FinRowProps {
  name: string;
  value: string;
  positive: boolean;
  meta?: string;
}

function FinRow({ name, value, positive, meta }: FinRowProps) {
  const color = positive ? "text-aura-green" : "text-aura-red";
  const dotGlow = positive ? "rgba(45,212,191,0.55)" : "rgba(255,91,114,0.55)";
  const Icon = positive ? ArrowUpRight : ArrowDownLeft;
  return (
    <div className="brief-fin-row flex items-center gap-3 px-4 py-3 border-t border-aura-border first:border-t-0">
      <span
        className={[
          "h-[7px] w-[7px] rounded-full shrink-0",
          positive ? "bg-aura-green" : "bg-aura-red",
        ].join(" ")}
        style={{ boxShadow: `0 0 8px ${dotGlow}` }}
      />
      <span className="flex-1 text-[13px] text-ink-primary truncate">{name}</span>
      {meta ? <span className="text-[10px] text-ink-faint">{meta}</span> : null}
      <span className={`inline-flex items-center gap-1 font-mono text-[12px] font-medium shrink-0 ${color}`}>
        <Icon className="h-3 w-3" />
        {value}
      </span>
    </div>
  );
}

function BriefAnalise() {
  return (
    <div className="relative mx-4 my-3 py-3 flex items-center justify-center gap-2">
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-0 right-[calc(50%+70px)] h-px bg-aura-border"
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-[calc(50%+70px)] right-0 h-px bg-aura-border"
      />
      <Activity className="h-3.5 w-3.5 text-accent-blue-soft" />
      <span className="text-[11px] font-bold tracking-[0.22em] uppercase text-ink-faint">
        Análise
      </span>
    </div>
  );
}

interface NarrationBottomProps {
  briefing: Briefing | null;
  loading: boolean;
  error: string | null;
  greetingName?: string;
}

function NarrationBottom({ briefing, loading, error, greetingName }: NarrationBottomProps) {
  const segments = briefing?.segments ?? [];
  const totalChars = useMemo(
    () => segments.reduce((acc, s) => acc + s.text.length, 0),
    [segments],
  );
  const [revealed, setRevealed] = useState(0);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    setRevealed(0);
  }, [briefing?.generated_at]);

  useEffect(() => {
    if (totalChars === 0 || revealed >= totalChars) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    if (intervalRef.current === null) {
      intervalRef.current = window.setInterval(() => {
        setRevealed((r) => {
          const next = r + 1;
          if (next >= totalChars && intervalRef.current !== null) {
            window.clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return next;
        });
      }, TYPE_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [totalChars, revealed]);

  const visibleSegments = useMemo(() => {
    const out: typeof segments = [];
    let consumed = 0;
    for (const seg of segments) {
      const remaining = revealed - consumed;
      if (remaining <= 0) break;
      if (seg.text.length <= remaining) {
        out.push(seg);
        consumed += seg.text.length;
      } else {
        out.push({ kind: seg.kind, text: seg.text.slice(0, remaining) });
        break;
      }
    }
    return out;
  }, [segments, revealed]);

  const isTyping = totalChars > 0 && revealed < totalChars;

  const skipTyping = () => {
    if (totalChars > 0 && revealed < totalChars) {
      setRevealed(totalChars);
    }
  };

  const greeting = greetingName ? `Olá, ${greetingName}.` : null;

  return (
    <div className="mx-4 mt-1 mb-7">
      <div
        className="font-sans text-[13px] leading-[1.75] text-ink-dim font-light min-h-[180px] cursor-pointer"
        onClick={skipTyping}
      >
        {greeting ? (
          <span className="text-accent-blue-soft font-medium">{greeting} </span>
        ) : null}
        {error ? (
          <span className="text-aura-red">{error}</span>
        ) : visibleSegments.length === 0 && !loading ? (
          <span className="text-ink-faint">Sem narração pra hoje.</span>
        ) : visibleSegments.length === 0 && loading ? (
          <span className="text-ink-faint">Preparando seu briefing…</span>
        ) : (
          <>
            {visibleSegments.map((seg, i) => (
              <span key={i} className={SEGMENT_CLASS[seg.kind] ?? "text-ink-dim"}>
                {seg.text}
              </span>
            ))}
            {isTyping ? (
              <span
                className="inline-block w-[2px] h-[15px] -mb-[2px] ml-[2px] bg-accent-blue-soft align-middle animate-pulse"
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
