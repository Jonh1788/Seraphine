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
import { getTodayBriefing, refreshBriefing, type Briefing } from "../api/briefing";
import * as tasksApi from "../api/tasks";
import * as financeApi from "../api/finance";
import { ApiError } from "../api/client";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useBriefSequence } from "../hooks/useBriefSequence";
import type {
  FinanceSummary,
  FinancialEntry,
  Task,
  TaskPriority,
} from "../types/api";

const TYPE_INTERVAL_MS = 18;

const SEGMENT_CLASS: Record<string, string> = {
  text: "text-[#8B9CC8]",
  urgent: "text-[#FF5B72] font-medium",
  good: "text-[#2DD4BF] font-medium",
  blue: "text-[#7DA4FF] font-medium",
};

const TONE_VAL: Record<"blue" | "red" | "amber" | "green" | "purple", string> = {
  blue: "text-[#7DA4FF]",
  red: "text-[#FF5B72]",
  amber: "text-[#F5A623]",
  green: "text-[#2DD4BF] font-mono",
  purple: "text-[#A78BFA]",
};

interface SnapKpi {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
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
      iconClass: "text-[#7DA4FF]",
      value: String(dueToday.length || tasks.length),
      tone: "blue",
      to: "/tarefas",
    },
    {
      label: "Atrasadas",
      icon: AlertTriangle,
      iconClass: "text-[#FF5B72]",
      value: String(overdue.length),
      tone: "red",
      to: "/tarefas",
    },
    {
      label: "Projetos",
      icon: Folder,
      iconClass: "text-[#A78BFA]",
      value: "0",
      tone: "purple",
    },
    {
      label: "Saldo",
      icon: CreditCard,
      iconClass: "text-[#2DD4BF]",
      value: summary ? fmtBrl(summary.balance) : "—",
      tone: "green",
      to: "/financas",
    },
  ];

  // Build the sequence: orb (0), 4 cards (1-4), prio header (5),
  // up to 4 prio rows (6-9), fin header (10), 3 fin rows (11-13),
  // analise (14), narration (15). Trim to actual rendered count.
  const finRowsCount = summary ? 3 : 0;
  const sequenceCount =
    1 /* orb */ +
    kpis.length +
    1 + upcomingTasks.length +
    1 + finRowsCount +
    1 /* analise */ +
    1 /* narration */;
  const seq = useBriefSequence({
    count: sequenceCount,
    stepMs: 175,
    leadMs: 60,
    resetKey: briefing?.generated_at,
  });

  // Compute index offsets so each section knows where it starts.
  let cursor = 0;
  const orbIdx = cursor++;
  const cardsStart = cursor; cursor += kpis.length;
  const prioHeaderIdx = cursor++;
  const prioStart = cursor; cursor += upcomingTasks.length;
  const finHeaderIdx = cursor++;
  const finStart = cursor; cursor += finRowsCount;
  const analiseIdx = cursor++;
  const narrationIdx = cursor++;

  return (
    <div
      className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-bg-base"
      onClick={() => seq.completed || seq.finish()}
    >
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void handleRefresh(); }}
          disabled={briefingLoading}
          aria-label="Atualizar briefing"
          className="grid place-items-center h-9 w-9 rounded-xl bg-accent-blue-dim/40 border border-[rgba(99,130,255,0.10)] text-ink-dim hover:text-accent-blue-soft hover:border-accent-blue/30 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${briefingLoading ? "animate-spin" : ""}`} />
        </button>
        <Link
          to="/"
          aria-label="Fechar"
          title="Voltar pra Aura"
          onClick={(e) => e.stopPropagation()}
          className="grid place-items-center h-9 w-9 rounded-xl bg-accent-blue-dim/40 border border-[rgba(99,130,255,0.10)] text-ink-dim hover:text-accent-blue-soft hover:border-accent-blue/30 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </Link>
      </div>

      <SnapGridWithOrb
        kpis={kpis}
        orbClass={seq.classOf(orbIdx)}
        cardClassFor={(i) => seq.classOf(cardsStart + i)}
        pulseTick={seq.pulseTick}
      />

      <SectionCard
        title="Prioridades"
        icon={CheckCircle2}
        iconColorClass="text-[#2DD4BF]"
        count={String(upcomingTasks.length)}
        empty="Nenhuma tarefa pendente."
        headerClass={seq.classOf(prioHeaderIdx)}
      >
        {upcomingTasks.map((t, i) => {
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
              onClick={(e) => e.stopPropagation()}
              className={`${seq.classOf(prioStart + i)} flex items-center gap-3 px-4 py-3.5 hover:bg-bg-s2/60 transition-colors border-t border-[rgba(99,130,255,0.10)] first:border-t-0`}
            >
              <PrioDot color={dot} />
              <span className="flex-1 text-[13px] text-ink-primary truncate">{t.title}</span>
              <span
                className={[
                  "flex items-center gap-1 text-[10px] tracking-wider shrink-0",
                  isOverdue
                    ? "text-[#FF5B72]"
                    : t.priority === "high"
                      ? "text-[#FF5B72] font-bold uppercase tracking-[0.1em]"
                      : t.priority === "med"
                        ? "text-[#F5A623] font-bold uppercase tracking-[0.1em]"
                        : "text-ink-faint",
                ].join(" ")}
              >
                {isOverdue ? <Clock className="h-3 w-3" strokeWidth={2.2} /> : null}
                {meta}
              </span>
            </Link>
          );
        })}
      </SectionCard>

      <SectionCard
        title="Finanças"
        icon={Wallet}
        iconColorClass="text-[#2DD4BF]"
        count={summary ? "3" : "—"}
        empty="Nenhuma transação no mês."
        headerClass={seq.classOf(finHeaderIdx)}
      >
        {summary ? (
          <>
            <FinRow
              className={seq.classOf(finStart + 0)}
              name="Saldo do mês"
              value={fmtBrl(summary.balance)}
              positive={summary.balance >= 0}
            />
            <FinRow
              className={seq.classOf(finStart + 1)}
              name="Receitas do mês"
              value={fmtBrl(summary.income)}
              positive
            />
            <FinRow
              className={seq.classOf(finStart + 2)}
              name="Despesas do mês"
              value={fmtBrl(summary.expenses)}
              positive={false}
            />
          </>
        ) : null}
      </SectionCard>

      <BriefAnalise className={seq.classOf(analiseIdx)} />

      <NarrationBottom
        className={seq.classOf(narrationIdx)}
        active={seq.isRevealed(narrationIdx)}
        briefing={briefing}
        loading={briefingLoading}
        error={briefingError}
        greetingName={shortName(user?.email)}
      />

      {recentEntries.length > 0 ? (
        <div className="opacity-70">
          {/* "Últimas transações" agora vive no Tab Finanças; mantido oculto aqui pra não competir com o briefing */}
        </div>
      ) : null}
    </div>
  );
}

interface SnapGridWithOrbProps {
  kpis: SnapKpi[];
  orbClass: string;
  cardClassFor: (i: number) => string;
  pulseTick: number;
}

function SnapGridWithOrb({ kpis, orbClass, cardClassFor, pulseTick }: SnapGridWithOrbProps) {
  return (
    <div className="relative px-4 pt-3 pb-4">
      <div className="grid grid-cols-2 gap-2.5">
        {kpis.map((k, i) => {
          const Inner = (
            <>
              <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.16em] uppercase text-ink-faint mb-2">
                <k.icon className={`h-[13px] w-[13px] ${k.iconClass}`} strokeWidth={2.2} />
                {k.label}
              </div>
              <div className={`text-[28px] leading-none font-bold tracking-tight ${TONE_VAL[k.tone]}`}>
                {k.value}
              </div>
            </>
          );
          const baseClass = `${cardClassFor(i)} snap-card relative bg-bg-s1 border border-[rgba(99,130,255,0.10)] rounded-[14px] px-4 py-3.5 transition-colors hover:bg-bg-s2 hover:border-[rgba(99,130,255,0.18)]`;
          return k.to ? (
            <Link key={i} to={k.to} onClick={(e) => e.stopPropagation()} className={baseClass}>
              {Inner}
            </Link>
          ) : (
            <div key={i} className={baseClass}>
              {Inner}
            </div>
          );
        })}
      </div>
      {/* Mini orb sobreposta entre os cards (top:25% left:36% como mockup) */}
      <BriefMiniOrb className={orbClass} pulseTick={pulseTick} />
    </div>
  );
}

interface BriefMiniOrbProps {
  className?: string;
  pulseTick: number;
}

function BriefMiniOrb({ className = "", pulseTick }: BriefMiniOrbProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pulseTick === 0) return;
    const el = ref.current;
    if (!el) return;
    el.classList.remove("brief-orb-pulse");
    // Force reflow so the animation restarts
    void el.offsetWidth;
    el.classList.add("brief-orb-pulse");
  }, [pulseTick]);

  return (
    <div
      ref={ref}
      className={`${className} brief-orb-anchor pointer-events-none absolute`}
      style={{
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: 80,
        height: 80,
        zIndex: 5,
        filter: "drop-shadow(0 0 14px rgba(79,126,255,0.55))",
      }}
      aria-hidden="true"
    >
      <AuraSphere variant="mini" state="idle" minimal />
    </div>
  );
}

interface SectionCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
  iconColorClass: string;
  count?: string;
  empty?: string;
  children?: React.ReactNode;
  headerClass?: string;
}

function SectionCard({
  title,
  icon: Icon,
  iconColorClass,
  count,
  empty,
  children,
  headerClass = "",
}: SectionCardProps) {
  const items = Array.isArray(children) ? children : children ? [children] : [];
  const hasContent = items.some((c) => c);
  return (
    <section className={`${headerClass} mx-4 mb-3.5 bg-bg-s1 border border-[rgba(99,130,255,0.10)] rounded-[18px] overflow-hidden`}>
      <header className="flex items-center justify-between px-4 pt-3.5 pb-3 border-b border-[rgba(99,130,255,0.10)]">
        <div className="flex items-center gap-2.5 font-display text-[15px] font-bold text-ink-primary tracking-tight">
          <Icon className={`h-[18px] w-[18px] ${iconColorClass}`} strokeWidth={2.2} />
          {title}
        </div>
        {count !== undefined ? (
          <span className="font-sans text-[12px] text-ink-faint">{count}</span>
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
  const bg =
    color === "red"
      ? "#FF5B72"
      : color === "amber"
        ? "#F5A623"
        : "#7DA4FF";
  const glow =
    color === "red"
      ? "rgba(255,91,114,0.55)"
      : color === "amber"
        ? "rgba(245,166,35,0.55)"
        : "rgba(125,164,255,0.55)";
  return (
    <span
      className="h-[8px] w-[8px] rounded-full shrink-0"
      style={{ backgroundColor: bg, boxShadow: `0 0 8px ${glow}` }}
    />
  );
}

interface FinRowProps {
  className?: string;
  name: string;
  value: string;
  positive: boolean;
  meta?: string;
}

function FinRow({ className = "", name, value, positive, meta }: FinRowProps) {
  const color = positive ? "#2DD4BF" : "#FF5B72";
  const dotGlow = positive ? "rgba(45,212,191,0.55)" : "rgba(255,91,114,0.55)";
  const Icon = positive ? ArrowUpRight : ArrowDownLeft;
  return (
    <div className={`${className} flex items-center gap-3 px-4 py-3.5 border-t border-[rgba(99,130,255,0.10)] first:border-t-0`}>
      <span
        className="h-[8px] w-[8px] rounded-full shrink-0"
        style={{ backgroundColor: color, boxShadow: `0 0 8px ${dotGlow}` }}
      />
      <span className="flex-1 text-[13px] text-ink-primary truncate">{name}</span>
      {meta ? <span className="text-[10px] text-ink-faint">{meta}</span> : null}
      <span
        className="inline-flex items-center gap-1 font-mono text-[13px] font-medium shrink-0"
        style={{ color }}
      >
        <Icon className="h-3 w-3" strokeWidth={2.4} />
        {value}
      </span>
    </div>
  );
}

function BriefAnalise({ className = "" }: { className?: string }) {
  return (
    <div className={`${className} relative mx-4 my-3 py-3 flex items-center justify-center gap-2`}>
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-0 right-[calc(50%+70px)] h-px bg-[rgba(99,130,255,0.10)]"
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-[calc(50%+70px)] right-0 h-px bg-[rgba(99,130,255,0.10)]"
      />
      <Activity className="h-3.5 w-3.5 text-[#7DA4FF]" strokeWidth={2.2} />
      <span className="text-[11px] font-bold tracking-[0.22em] uppercase text-ink-faint">
        Análise
      </span>
    </div>
  );
}

interface NarrationBottomProps {
  className?: string;
  active: boolean;
  briefing: Briefing | null;
  loading: boolean;
  error: string | null;
  greetingName?: string;
}

function NarrationBottom({
  className = "",
  active,
  briefing,
  loading,
  error,
  greetingName,
}: NarrationBottomProps) {
  const segments = briefing?.segments ?? [];
  const totalChars = useMemo(
    () => segments.reduce((acc, s) => acc + s.text.length, 0),
    [segments],
  );
  const [revealed, setRevealed] = useState(0);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    setRevealed(0);
  }, [briefing?.generated_at, active]);

  useEffect(() => {
    if (!active) return;
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
  }, [active, totalChars, revealed]);

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

  const isTyping = active && totalChars > 0 && revealed < totalChars;
  const greeting = greetingName ? `Olá, ${greetingName}.` : null;

  return (
    <div className={`${className} mx-4 mt-1 mb-7`}>
      <div className="font-sans text-[13px] leading-[1.75] font-light min-h-[180px]" style={{ color: "#8B9CC8" }}>
        {greeting ? (
          <span className="font-medium" style={{ color: "#7DA4FF" }}>{greeting} </span>
        ) : null}
        {error ? (
          <span style={{ color: "#FF5B72" }}>{error}</span>
        ) : !active ? null : visibleSegments.length === 0 && !loading ? (
          <span className="text-ink-faint">Sem narração pra hoje.</span>
        ) : visibleSegments.length === 0 && loading ? (
          <span className="text-ink-faint">Preparando seu briefing…</span>
        ) : (
          <>
            {visibleSegments.map((seg, i) => (
              <span key={i} className={SEGMENT_CLASS[seg.kind] ?? "text-[#8B9CC8]"}>
                {seg.text}
              </span>
            ))}
            {isTyping ? <span className="brief-tw-cursor" /> : null}
          </>
        )}
      </div>
    </div>
  );
}
