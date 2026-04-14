import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  FolderKanban,
  Sparkles,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { GlassCard } from "./GlassCard";
import { RadarDeVida } from "./RadarDeVida";

/**
 * Centro de Operações — composes 5 mini modules (Tarefas, Projetos, Radar,
 * Hábitos, Financeiro). Data is injected from the page so backend hookup
 * stays decoupled from layout.
 */

export interface CentroOperacoesProps {
  tarefas: { done: number; pending: number };
  projetos: { done: number; active: number };
  financeiro: { income: number; expenses: number; savedPct: number; perDay: number };
  habitosCount: number;
  radarValues: number[];
}

type AccentTone = "cyan" | "blue" | "emerald" | "green" | "purple";

const TONE: Record<AccentTone, { bg: string; ring: string; text: string; bar: string }> = {
  cyan: {
    bg: "bg-cyan-500/10",
    ring: "ring-cyan-400/30",
    text: "text-cyan-300",
    bar: "bg-cyan-400",
  },
  blue: {
    bg: "bg-mod-tasks/10",
    ring: "ring-mod-tasks/30",
    text: "text-mod-tasks",
    bar: "bg-mod-tasks",
  },
  emerald: {
    bg: "bg-mod-habits/10",
    ring: "ring-mod-habits/30",
    text: "text-mod-habits",
    bar: "bg-mod-habits",
  },
  green: {
    bg: "bg-mod-finance/10",
    ring: "ring-mod-finance/30",
    text: "text-mod-finance",
    bar: "bg-mod-finance",
  },
  purple: {
    bg: "bg-accent-purple/10",
    ring: "ring-accent-purple/30",
    text: "text-accent-purple",
    bar: "bg-accent-purple",
  },
};

interface MiniModuleProps {
  icon: LucideIcon;
  title: string;
  tone: AccentTone;
  children: ReactNode;
}

function MiniModule({ icon: Icon, title, tone, children }: MiniModuleProps) {
  const t = TONE[tone];
  return (
    <div
      className={[
        "rounded-xl border border-white/5 bg-white/[0.02] p-4",
        "flex flex-col gap-3 h-full",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <div className={`h-7 w-7 rounded-md ${t.bg} ring-1 ${t.ring} grid place-items-center`}>
          <Icon className={`h-3.5 w-3.5 ${t.text}`} />
        </div>
        <div className="text-sm font-semibold text-ink-primary">{title}</div>
      </div>
      {children}
    </div>
  );
}

function formatBRL(n: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(n);
}

function TarefasMini({ done, pending }: { done: number; pending: number }) {
  const total = done + pending;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const t = TONE.cyan;
  return (
    <MiniModule icon={CheckCircle2} title="Tarefas" tone="cyan">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <div className={`text-2xl font-bold ${t.text}`}>{done}</div>
          <div className="text-xs text-ink-dim">concluídas</div>
        </div>
        <div className="flex flex-col gap-1 text-right">
          <div className="text-2xl font-bold text-ink-primary">{pending}</div>
          <div className="text-xs text-ink-dim">pendentes</div>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-white/5 overflow-hidden">
          <div className={`h-full ${t.bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`text-xs font-semibold ${t.text} tabular-nums`}>{pct}%</div>
      </div>
    </MiniModule>
  );
}

function ProjetosMini({ done, active }: { done: number; active: number }) {
  const total = done + active;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const t = TONE.blue;
  return (
    <MiniModule icon={FolderKanban} title="Projetos" tone="blue">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <div className={`text-2xl font-bold ${t.text}`}>{done}</div>
          <div className="text-xs text-ink-dim">concluídos</div>
        </div>
        <div className="flex flex-col gap-1 text-right">
          <div className="text-2xl font-bold text-ink-primary">{active}</div>
          <div className="text-xs text-ink-dim">ativos</div>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-white/5 overflow-hidden">
          <div className={`h-full ${t.bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`text-xs font-semibold ${t.text} tabular-nums`}>{pct}%</div>
      </div>
    </MiniModule>
  );
}

function HabitosMini({ count }: { count: number }) {
  const t = TONE.emerald;
  return (
    <MiniModule icon={Target} title="Hábitos" tone="emerald">
      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-2 text-center">
          <div className="text-[11px] text-ink-faint">Nenhum hábito cadastrado</div>
        </div>
      ) : (
        <div className="flex items-end justify-between">
          <div className="flex flex-col gap-1">
            <div className={`text-2xl font-bold ${t.text}`}>{count}</div>
            <div className="text-xs text-ink-dim">hábitos ativos</div>
          </div>
        </div>
      )}
    </MiniModule>
  );
}

function FinanceiroMini({
  income,
  expenses,
  savedPct,
  perDay,
}: {
  income: number;
  expenses: number;
  savedPct: number;
  perDay: number;
}) {
  const t = TONE.green;
  return (
    <MiniModule icon={Wallet} title="Financeiro" tone="green">
      <div className="flex flex-col gap-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-dim">Receitas</span>
          <span className={`font-semibold ${t.text} tabular-nums`}>{formatBRL(income)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-dim">Despesas</span>
          <span className="font-semibold text-red-400 tabular-nums">{formatBRL(expenses)}</span>
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 text-[11px] text-ink-faint">
        <TrendingUp className="h-3 w-3" />
        <span className="tabular-nums">{savedPct}% guardado</span>
        <span className="text-ink-faint/50">•</span>
        <span className="tabular-nums">{formatBRL(perDay)}/dia</span>
      </div>
    </MiniModule>
  );
}

export function CentroOperacoes({
  tarefas,
  projetos,
  financeiro,
  habitosCount,
  radarValues,
}: CentroOperacoesProps) {
  return (
    <GlassCard>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-accent-purple/15 ring-1 ring-accent-purple/30 grid place-items-center">
            <Sparkles className="h-3.5 w-3.5 text-accent-purple" />
          </div>
          <div className="font-semibold text-ink-primary">Centro de Operações</div>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-ink-dim">
          Visão geral
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <TarefasMini done={tarefas.done} pending={tarefas.pending} />
        <ProjetosMini done={projetos.done} active={projetos.active} />

        {/* Radar: spans one column on all breakpoints, but stretches full
            height via row-span on lg so it visually aligns with 2 rows. */}
        <div className="md:col-span-2 lg:col-span-1 lg:row-span-2">
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 h-full flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-md bg-accent-purple/10 ring-1 ring-accent-purple/30 grid place-items-center">
                <Sparkles className="h-3.5 w-3.5 text-accent-purple" />
              </div>
              <div className="text-sm font-semibold text-ink-primary">Radar de Vida</div>
            </div>
            <div className="flex-1 grid place-items-center">
              <RadarDeVida values={radarValues} centerValue="49" centerLabel="índice" />
            </div>
          </div>
        </div>

        <HabitosMini count={habitosCount} />
        <FinanceiroMini
          income={financeiro.income}
          expenses={financeiro.expenses}
          savedPct={financeiro.savedPct}
          perDay={financeiro.perDay}
        />
      </div>
    </GlassCard>
  );
}
