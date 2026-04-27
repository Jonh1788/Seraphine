import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  CreditCard,
  DollarSign,
  Shield,
} from "lucide-react";
import * as tasksApi from "../api/tasks";
import * as financeApi from "../api/finance";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import type { FinanceSummary, Task, TaskPriority } from "../types/api";

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const WEEKDAYS_PT = [
  "Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado",
];

function pickGreeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "Boa madrugada";
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

function fmtBrl(v: number, withSign = false): string {
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
  if (!withSign) return formatted;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${formatted}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateAbbrSlash(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${pad2(d)}/${pad2(m)}`;
}

function dotByPriority(p: TaskPriority | null | undefined): "red" | "amber" | "blue" {
  if (p === "high") return "red";
  if (p === "med") return "amber";
  return "blue";
}

function useNow(updateMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), updateMs);
    return () => window.clearInterval(id);
  }, [updateMs]);
  return now;
}

export function VisaoPage() {
  const now = useNow(1000);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [_, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    try {
      const [openTasks, sum] = await Promise.all([
        tasksApi.listTasks({ status: "pending", limit: 200 }),
        financeApi.getSummary({ month, year }),
      ]);
      setTasks(openTasks);
      setSummary(sum);
    } catch {
      /* tolerate */
    } finally {
      setLoading(false);
    }
    // intentionally exclude `now` from deps — we don't want to refetch every second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  const todayIso = isoLocal(now);
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

  const totalAttention = overdue.length + dueToday.length;
  const dateLabel = `${WEEKDAYS_PT[now.getDay()]}, ${now.getDate()} de ${MONTHS_PT[now.getMonth()]} · ${now.getFullYear()}`;

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-6">
      <TitleRow />

      <HeroCard
        greeting={pickGreeting(now)}
        date={dateLabel}
        attentionCount={totalAttention}
        now={now}
      />

      <SnapGrid
        tasksCount={tasks.length}
        overdueCount={overdue.length}
        balance={summary?.balance ?? null}
      />

      <SectionCard
        title="Prioridades"
        icon={<ShieldIcon />}
        rightLabel={`${upcomingTasks.length} ${upcomingTasks.length === 1 ? "item" : "itens"}`}
      >
        {upcomingTasks.length === 0 ? (
          <EmptyRow message="Nenhuma tarefa pendente." />
        ) : (
          upcomingTasks.map((t) => {
            const isOverdue = t.due_date != null && t.due_date < todayIso;
            const dot = isOverdue ? "red" : dotByPriority(t.priority);
            return (
              <PrioItem
                key={t.id}
                dot={dot}
                title={t.title}
                meta={
                  isOverdue
                    ? `${dateAbbrSlash(t.due_date)}${t.due_time ? ` · ${t.due_time}` : ""}`
                    : t.due_date
                      ? `${dateAbbrSlash(t.due_date)}${t.due_time ? ` · ${t.due_time}` : ""}`
                      : "Sem prazo"
                }
                metaLate={isOverdue}
                chipKind={isOverdue ? "atrasada" : t.priority === "med" ? "proximo" : null}
              />
            );
          })
        )}
      </SectionCard>

      <SectionCard
        title="Finanças"
        icon={<DollarSign className="h-[18px] w-[18px]" strokeWidth={2.2} style={{ color: "#7DA4FF" }} />}
        rightLink={{ to: "/financas", label: "ver tudo →" }}
      >
        <FinRow
          tone="blue"
          icon={<CreditCard className="h-3.5 w-3.5" strokeWidth={2.2} />}
          label="Saldo do mês"
          sub={`${MONTHS_PT[now.getMonth()]} ${now.getFullYear()}`}
          value={summary ? fmtBrl(summary.balance, true) : "—"}
          valueTone={summary && summary.balance >= 0 ? "green" : "red"}
        />
        <FinRow
          tone="green"
          icon={<ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.2} />}
          label="Receitas"
          sub={summary ? `${fmtBrl(summary.income)}` : "—"}
          value={summary ? fmtBrl(summary.income, true) : "—"}
          valueTone="green"
        />
        <FinRow
          tone="red"
          icon={<ArrowDownLeft className="h-3.5 w-3.5" strokeWidth={2.2} />}
          label="Despesas"
          sub={summary ? `${fmtBrl(summary.expenses)}` : "—"}
          value={summary ? `−${fmtBrl(summary.expenses)}` : "—"}
          valueTone="red"
        />
      </SectionCard>

      <RadarCard tasksCount={tasks.length} balance={summary?.balance ?? 0} />

      <SectionCard
        title="Briefing do Dia"
        icon={
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" style={{ color: "#7DA4FF" }}>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        }
        rightLabel="abrir →"
      >
        <Link
          to="/hoje"
          className="flex items-center gap-3 px-4 py-4 hover:bg-[#111B38]/60 transition-colors"
        >
          <span
            className="h-8 w-8 rounded-[10px] grid place-items-center shrink-0"
            style={{
              background: "rgba(45,212,191,0.12)",
              border: "1px solid rgba(45,212,191,0.15)",
              color: "#2DD4BF",
            }}
          >
            <CheckCircle2 className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <span className="text-[13px] text-[#8B9CC8]">
            Toque pra abrir o briefing diário narrado.
          </span>
        </Link>
      </SectionCard>
    </div>
  );
}

function TitleRow() {
  return (
    <div className="flex items-center gap-2.5 pt-4 px-5 pb-3">
      <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
        Visão
      </h1>
      <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ background: "rgba(255,91,114,0.12)", border: "1px solid rgba(255,91,114,0.2)" }}>
        <span className="h-[5px] w-[5px] rounded-full animate-pulse" style={{ background: "#FF5B72" }} />
        <span className="text-[10px] font-bold tracking-[0.1em] uppercase" style={{ color: "#FF5B72" }}>LIVE</span>
      </span>
    </div>
  );
}

interface HeroCardProps {
  greeting: string;
  date: string;
  attentionCount: number;
  now: Date;
}

function HeroCard({ greeting, date, attentionCount, now }: HeroCardProps) {
  const h = pad2(now.getHours());
  const m = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  return (
    <div
      className="relative mx-4 mb-3.5 p-5 rounded-[20px] overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #0E1F4A 0%, #0A1530 60%, #060D22 100%)",
        border: "1px solid rgba(79,126,255,0.2)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}
    >
      {/* Halo no canto sup direito */}
      <div
        aria-hidden="true"
        className="absolute pointer-events-none rounded-full"
        style={{
          top: -40,
          right: -40,
          width: 160,
          height: 160,
          background: "radial-gradient(circle, rgba(79,126,255,0.12) 0%, transparent 70%)",
        }}
      />
      {/* Greeting + date + alert pill */}
      <div className="relative max-w-[60%]">
        <div
          className="text-[11px] uppercase tracking-[0.08em] font-medium mb-0.5"
          style={{ color: "#7DA4FF", opacity: 0.7 }}
        >
          Visão
        </div>
        <h2 className="font-display text-[26px] font-bold tracking-tight text-[#EEF2FF] mb-1">
          {greeting}
        </h2>
        <div className="text-[12px] font-light text-[#8B9CC8] mb-3">{date}</div>
        {attentionCount > 0 ? (
          <div
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium"
            style={{
              background: "rgba(245,166,35,0.15)",
              border: "1px solid rgba(245,166,35,0.25)",
              color: "#F5A623",
            }}
          >
            <span className="h-[5px] w-[5px] rounded-full" style={{ background: "#F5A623" }} />
            {attentionCount} {attentionCount === 1 ? "item precisa" : "itens precisam"} de atenção
          </div>
        ) : (
          <div
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium"
            style={{
              background: "rgba(45,212,191,0.12)",
              border: "1px solid rgba(45,212,191,0.25)",
              color: "#2DD4BF",
            }}
          >
            <span className="h-[5px] w-[5px] rounded-full" style={{ background: "#2DD4BF" }} />
            Tudo em dia
          </div>
        )}
      </div>
      {/* Clock à direita */}
      <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
        <div
          className="font-mono text-[32px] leading-none font-medium tracking-[-0.04em] text-[#EEF2FF]"
        >
          {h}:{m}
          <sup className="text-[14px] font-normal align-super ml-0.5" style={{ color: "#4D5E8A" }}>
            {s}
          </sup>
        </div>
        <div className="font-mono text-[10px] mt-0.5 text-[#4D5E8A] tracking-[0.1em]">
          {Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop() ?? "BRT"}
        </div>
      </div>
    </div>
  );
}

interface SnapGridProps {
  tasksCount: number;
  overdueCount: number;
  balance: number | null;
}

function SnapGrid({ tasksCount, overdueCount, balance }: SnapGridProps) {
  const items: Array<{
    label: string;
    value: string;
    valueColor: string;
    sub: string;
    to?: string;
    mono?: boolean;
  }> = [
    {
      label: "Tarefas",
      value: String(tasksCount),
      valueColor: "#7DA4FF",
      sub: "pendentes",
      to: "/tarefas",
    },
    {
      label: "Atrasadas",
      value: String(overdueCount),
      valueColor: "#FF5B72",
      sub: overdueCount > 0 ? "atenção" : "em dia",
      to: "/tarefas",
    },
    {
      label: "Projetos",
      value: "0",
      valueColor: "#A78BFA",
      sub: "ativos",
    },
    {
      label: "Saldo",
      value: balance != null ? fmtBrl(balance) : "—",
      valueColor: "#2DD4BF",
      sub: "do mês",
      to: "/financas",
      mono: true,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 mx-4 mb-3.5">
      {items.map((it, i) => {
        const Inner = (
          <>
            <div
              className="text-[9px] font-bold uppercase tracking-[0.14em] mb-1.5"
              style={{ color: "#4D5E8A" }}
            >
              {it.label}
            </div>
            <div
              className={[
                "text-[24px] leading-none font-bold tracking-tight",
                it.mono ? "font-mono" : "",
              ].join(" ")}
              style={{ color: it.valueColor }}
            >
              {it.value}
            </div>
            <div className="text-[10px] mt-1" style={{ color: "#4D5E8A" }}>
              {it.sub}
            </div>
          </>
        );
        const baseClass =
          "snap-card relative bg-[#0C1228] border border-[rgba(99,130,255,0.10)] rounded-[14px] px-3.5 py-3 transition-all hover:bg-[#111B38] hover:border-[rgba(99,130,255,0.18)] hover:-translate-y-px";
        return it.to ? (
          <Link key={i} to={it.to} className={baseClass}>
            {Inner}
          </Link>
        ) : (
          <div key={i} className={baseClass}>
            {Inner}
          </div>
        );
      })}
    </div>
  );
}

interface SectionCardProps {
  title: string;
  icon: React.ReactNode;
  rightLabel?: string;
  rightLink?: { to: string; label: string };
  children?: React.ReactNode;
}

function SectionCard({ title, icon, rightLabel, rightLink, children }: SectionCardProps) {
  return (
    <section className="mx-4 mb-3.5 bg-[#0C1228] border border-[rgba(99,130,255,0.10)] rounded-[18px] overflow-hidden">
      <header className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-[rgba(99,130,255,0.10)]">
        <div className="flex items-center gap-2 font-display text-[13px] font-semibold text-[#EEF2FF] tracking-tight">
          {icon}
          {title}
        </div>
        {rightLink ? (
          <Link
            to={rightLink.to}
            className="font-sans text-[11px] hover:opacity-100 opacity-90"
            style={{ color: "#7DA4FF" }}
          >
            {rightLink.label}
          </Link>
        ) : rightLabel ? (
          <span className="font-sans text-[11px]" style={{ color: "#4D5E8A" }}>
            {rightLabel}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function ShieldIcon() {
  return (
    <Shield
      className="h-[18px] w-[18px]"
      strokeWidth={2}
      style={{ color: "#7DA4FF" }}
    />
  );
}

interface PrioItemProps {
  dot: "red" | "amber" | "blue";
  title: string;
  meta: string;
  metaLate?: boolean;
  chipKind: "atrasada" | "proximo" | null;
}

function PrioItem({ dot, title, meta, metaLate, chipKind }: PrioItemProps) {
  const dotColor = dot === "red" ? "#FF5B72" : dot === "amber" ? "#F5A623" : "#7DA4FF";
  const dotGlow =
    dot === "red"
      ? "rgba(255,91,114,0.5)"
      : dot === "amber"
        ? "rgba(245,166,35,0.5)"
        : "rgba(125,164,255,0.5)";

  const chipStyle =
    chipKind === "atrasada"
      ? {
          background: "rgba(255,91,114,0.12)",
          border: "1px solid rgba(255,91,114,0.2)",
          color: "#FF5B72",
        }
      : chipKind === "proximo"
        ? {
            background: "rgba(245,166,35,0.15)",
            border: "1px solid rgba(245,166,35,0.2)",
            color: "#F5A623",
          }
        : undefined;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-t border-[rgba(99,130,255,0.10)] first:border-t-0">
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ background: dotColor, boxShadow: `0 0 8px ${dotGlow}` }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[#EEF2FF] truncate mb-0.5">{title}</div>
        <div
          className="text-[10px]"
          style={{ color: metaLate ? "rgba(255,91,114,0.85)" : "#4D5E8A" }}
        >
          {meta}
        </div>
      </div>
      {chipKind ? (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
          style={chipStyle}
        >
          {chipKind === "atrasada" ? "atrasada" : "próximo"}
        </span>
      ) : null}
    </div>
  );
}

interface FinRowProps {
  tone: "blue" | "green" | "red";
  icon: React.ReactNode;
  label: string;
  sub: string;
  value: string;
  valueTone: "green" | "red";
}

function FinRow({ tone, icon, label, sub, value, valueTone }: FinRowProps) {
  const iconBg =
    tone === "green"
      ? { background: "rgba(45,212,191,0.12)", color: "#2DD4BF" }
      : tone === "red"
        ? { background: "rgba(255,91,114,0.12)", color: "#FF5B72" }
        : { background: "rgba(79,126,255,0.15)", color: "#7DA4FF" };
  const valueColor = valueTone === "green" ? "#2DD4BF" : "#FF5B72";
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 border-t border-[rgba(99,130,255,0.10)] first:border-t-0">
      <span
        className="h-8 w-8 rounded-[10px] grid place-items-center shrink-0"
        style={iconBg}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-[#8B9CC8]">{label}</div>
        <div className="text-[10px] mt-0.5" style={{ color: "#4D5E8A" }}>
          {sub}
        </div>
      </div>
      <span
        className="font-mono text-[14px] font-medium tracking-[-0.01em] shrink-0"
        style={{ color: valueColor }}
      >
        {value}
      </span>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <span
        className="h-8 w-8 rounded-[10px] grid place-items-center shrink-0"
        style={{
          background: "rgba(45,212,191,0.12)",
          border: "1px solid rgba(45,212,191,0.15)",
          color: "#2DD4BF",
        }}
      >
        <CheckCircle2 className="h-4 w-4" strokeWidth={2.2} />
      </span>
      <span className="text-[13px] text-[#8B9CC8]">{message}</span>
    </div>
  );
}

interface RadarCardProps {
  tasksCount: number;
  balance: number;
}

function RadarCard({ tasksCount, balance }: RadarCardProps) {
  // Compute simple "life radar" scores from real data: 5 axes 0..1.
  // We treat tasksCount and balance as proxies until we have a richer
  // life-tracking model. Numbers are intentionally generous so the
  // pentagon doesn't collapse to a point on first launch.
  const productivity = Math.min(1, 0.2 + tasksCount * 0.04);
  const financial = Math.min(1, 0.3 + Math.max(0, balance) / 5000);
  const habits = 0.05;
  const planning = 0.18;
  const balanceLife = 0.38;

  const scores = [productivity, financial, habits, planning, balanceLife];
  const colors = ["#4F7EFF", "#2DD4BF", "#F472B6", "#A78BFA", "#F5A623"];
  const labels = ["Produtividade", "Financeiro", "Hábitos", "Planejamento", "Equilíbrio"];

  // Pentagon vertex base (radius 90, angle starts at top)
  const baseR = 90;
  const angles = [-90, -18, 54, 126, 198].map((d) => (d * Math.PI) / 180);
  const points = scores.map((s, i) => {
    const r = s * baseR;
    return [Math.cos(angles[i]) * r, Math.sin(angles[i]) * r] as const;
  });
  const polygonPoints = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Grid pentagons (5 rings)
  const gridPolys = [1, 0.8, 0.6, 0.4, 0.2].map((scale) =>
    angles
      .map((a) => `${(Math.cos(a) * baseR * scale).toFixed(1)},${(Math.sin(a) * baseR * scale).toFixed(1)}`)
      .join(" "),
  );

  const totalPts = Math.round(scores.reduce((a, b) => a + b, 0) * 20); // 0..100 range

  return (
    <div className="mx-4 mb-3.5 bg-[#0C1228] border border-[rgba(99,130,255,0.10)] rounded-[18px] p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-display text-[13px] font-semibold text-[#EEF2FF]">
          Radar de Vida
        </h3>
        <span
          className="font-mono text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
          style={{
            color: "#7DA4FF",
            background: "rgba(79,126,255,0.15)",
            border: "1px solid rgba(79,126,255,0.2)",
          }}
        >
          {totalPts} pts
        </span>
      </div>
      <div className="relative flex justify-center py-2 pb-3">
        <svg width="220" height="220" viewBox="-110 -110 220 220" fill="none" aria-hidden="true">
          <g stroke="rgba(99,130,255,0.15)" strokeWidth="1" fill="none">
            {gridPolys.map((p, i) => <polygon key={i} points={p} />)}
          </g>
          <g stroke="rgba(99,130,255,0.15)" strokeWidth="1">
            {angles.map((a, i) => (
              <line
                key={i}
                x1={0}
                y1={0}
                x2={Math.cos(a) * baseR}
                y2={Math.sin(a) * baseR}
              />
            ))}
          </g>
          <polygon
            points={polygonPoints}
            fill="rgba(79,126,255,0.3)"
            stroke="#4F7EFF"
            strokeWidth="2"
          />
          {points.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={3} fill="#4F7EFF" />
          ))}
          <g fontFamily="DM Sans" fontSize="9" fill="#8B9CC8" textAnchor="middle">
            {angles.map((a, i) => {
              const lr = baseR + 12;
              return (
                <text
                  key={i}
                  x={Math.cos(a) * lr}
                  y={Math.sin(a) * lr + 3}
                >
                  {labels[i]}
                </text>
              );
            })}
          </g>
        </svg>
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="text-center">
            <div className="font-display text-[28px] font-bold leading-none tracking-tight text-[#EEF2FF]">
              {totalPts}
            </div>
            <div className="text-[9px] mt-0.5 uppercase tracking-[0.1em]" style={{ color: "#4D5E8A" }}>
              pts
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 pt-2.5 border-t border-[rgba(99,130,255,0.10)]">
        {labels.map((name, i) => (
          <div key={name} className="flex items-center gap-2.5">
            <span className="text-[11px] w-[92px] shrink-0" style={{ color: "#8B9CC8" }}>
              {name}
            </span>
            <div
              className="flex-1 h-1 rounded-full overflow-hidden"
              style={{ background: "#162040" }}
            >
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.round(scores[i] * 100)}%`,
                  background: colors[i],
                }}
              />
            </div>
            <span
              className="font-mono text-[10px] w-[32px] text-right"
              style={{ color: "#4D5E8A" }}
            >
              {Math.round(scores[i] * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
