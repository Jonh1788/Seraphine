import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Briefcase,
  Calendar,
  Crosshair,
  HeartPulse,
  Loader2,
  Plus,
  Sparkles as SparklesIcon,
  Star,
  Target,
  Trash2,
  Wallet,
} from "lucide-react";
import * as goalsApi from "../api/goals";
import type { Goal, GoalKind, GoalsOverview } from "../api/goals";
import { ApiError } from "../api/client";
import { Sheet } from "../components/Sheet";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useCountUp } from "../hooks/useCountUp";

type Filter = "all" | GoalKind;

const KIND_LABEL: Record<GoalKind, string> = {
  general: "Geral",
  financial: "Financeira",
  habit: "Hábito",
  project: "Projeto",
};
const KIND_ICON: Record<GoalKind, React.ComponentType<{ className?: string; strokeWidth?: number | string }>> = {
  general: Star,
  financial: Wallet,
  habit: HeartPulse,
  project: Briefcase,
};
const KIND_COLOR: Record<GoalKind, string> = {
  general: "#7DA4FF",
  financial: "#2DD4BF",
  habit: "#A78BFA",
  project: "#F5A623",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dateAbbr(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${pad2(d)}/${pad2(m)}/${y}`;
}
function fmtNum(v: number, unit: string | null | undefined): string {
  const n = v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  return unit ? `${n} ${unit}` : n;
}

export function MetasPage() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [overview, setOverview] = useState<GoalsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, ov] = await Promise.all([
        goalsApi.listGoals(null, true),
        goalsApi.getOverview(),
      ]);
      setGoals(list.goals);
      setOverview(ov);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao carregar metas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  const filtered = useMemo(() => {
    const base = goals.filter((g) => g.status !== "archived");
    if (filter === "all") return base;
    return base.filter((g) => g.kind === filter);
  }, [goals, filter]);

  const today = useMemo(() => isoLocal(new Date()), []);
  const inProgress = filtered.filter(
    (g) => g.status === "active" && (g.target_value == null || g.current_value < g.target_value),
  ).length;

  const total = overview?.total ?? goals.length;
  const active = overview?.active ?? 0;
  const expired = overview?.expired ?? 0;

  const onUpdateProgress = useCallback(
    async (g: Goal, delta: number) => {
      if (g.target_value == null) return;
      const next = Math.max(0, Math.min(g.target_value, g.current_value + delta));
      const newStatus: Goal["status"] = next >= g.target_value ? "completed" : "active";
      setGoals((prev) =>
        prev.map((x) => (x.id === g.id ? { ...x, current_value: next, status: newStatus } : x)),
      );
      try {
        await goalsApi.updateGoal(g.id, { current_value: next, status: newStatus });
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(8);
      } catch {
        await load();
      }
    },
    [load],
  );

  const onArchive = useCallback(
    async (g: Goal) => {
      const next: Goal["status"] = g.status === "archived" ? "active" : "archived";
      setGoals((prev) => prev.map((x) => (x.id === g.id ? { ...x, status: next } : x)));
      try {
        await goalsApi.updateGoal(g.id, { status: next });
      } catch {
        await load();
      }
    },
    [load],
  );

  const onDelete = useCallback(
    async (g: Goal) => {
      if (!confirm(`Excluir "${g.title}"?`)) return;
      setGoals((prev) => prev.filter((x) => x.id !== g.id));
      try {
        await goalsApi.deleteGoal(g.id);
      } catch {
        await load();
      }
    },
    [load],
  );

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-24 relative">
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Metas
        </h1>
        <span className="ml-auto text-[11px] font-mono" style={{ color: "#4D5E8A" }}>
          {total} total
        </span>
      </div>

      <section className="grid grid-cols-4 gap-2 mx-4 mb-3.5 screen-item" style={animDelay(1)}>
        <SnapCell label="Total" value={total} color="#7DA4FF" />
        <SnapCell label="Ativas" value={active} color="#EEF2FF" />
        <SnapCell label="Progresso" value={inProgress} color="#F5A623" />
        <SnapCell label="Vencidas" value={expired} color="#FF5B72" />
      </section>

      <div className="flex gap-1.5 px-4 mb-3.5 overflow-x-auto screen-item" style={{ ...animDelay(2), scrollbarWidth: "none" }}>
        <PillBtn active={filter === "all"} onClick={() => setFilter("all")}>Todas</PillBtn>
        <PillBtn active={filter === "financial"} onClick={() => setFilter("financial")}>Financeiras</PillBtn>
        <PillBtn active={filter === "habit"} onClick={() => setFilter("habit")}>Hábitos</PillBtn>
        <PillBtn active={filter === "project"} onClick={() => setFilter("project")}>Projetos</PillBtn>
        <PillBtn active={filter === "general"} onClick={() => setFilter("general")}>Geral</PillBtn>
      </div>

      {error ? (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg text-[11px]" style={{
          background: "rgba(255,91,114,0.12)",
          border: "1px solid rgba(255,91,114,0.2)",
          color: "#FF5B72",
        }}>
          {error}
        </div>
      ) : null}

      {loading && goals.length === 0 ? (
        <div className="grid place-items-center py-12" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState onCreate={() => setNewOpen(true)} delayStyle={animDelay(3)} />
      ) : (
        <div className="px-4 flex flex-col gap-3">
          {filtered.map((g, i) => (
            <GoalCard
              key={g.id}
              goal={g}
              isExpired={g.deadline != null && g.deadline < today && g.status === "active"}
              onIncrement={() => onUpdateProgress(g, 1)}
              onIncrementBig={() => onUpdateProgress(g, 10)}
              onArchive={() => onArchive(g)}
              onDelete={() => onDelete(g)}
              style={animDelay(3 + i)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setNewOpen(true)}
        aria-label="Nova meta"
        className="fixed grid place-items-center transition-transform active:scale-95"
        style={{
          right: 20,
          bottom: "calc(var(--bottom-nav-h) + var(--safe-bottom) + 18px)",
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

      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="Nova meta" maxWidth="max-w-md">
        <NewGoalForm
          busy={busy}
          onCancel={() => setNewOpen(false)}
          onCreate={async (body) => {
            setBusy(true);
            try {
              await goalsApi.createGoal(body);
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

function SnapCell({ label, value, color }: { label: string; value: number; color: string }) {
  const animated = useCountUp(value, 850, value);
  return (
    <div className="text-center py-3 px-2 rounded-[12px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]">
      <div className="text-[9px] font-bold tracking-[0.1em] uppercase mb-1" style={{ color: "#4D5E8A" }}>
        {label}
      </div>
      <div className="font-display text-[18px] font-bold leading-none tracking-tight" style={{ color }}>
        {animated}
      </div>
    </div>
  );
}

function PillBtn({ active = false, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center px-3 py-1.5 rounded-[10px] text-[11px] font-medium tracking-[0.02em] whitespace-nowrap shrink-0 transition-colors"
      style={
        active
          ? { background: "rgba(79,126,255,0.15)", border: "1px solid rgba(79,126,255,0.3)", color: "#7DA4FF" }
          : { background: "transparent", border: "1px solid rgba(99,130,255,0.10)", color: "#4D5E8A" }
      }
    >
      {children}
    </button>
  );
}

function EmptyState({ onCreate, delayStyle }: { onCreate: () => void; delayStyle: React.CSSProperties }) {
  return (
    <div className="flex flex-col items-center text-center px-8 py-10 screen-item" style={delayStyle}>
      <div
        className="mb-5 grid place-items-center"
        style={{
          width: 76,
          height: 76,
          borderRadius: "50%",
          background: "rgba(79,126,255,0.15)",
          border: "1px solid rgba(79,126,255,0.25)",
          boxShadow: "0 0 30px rgba(79,126,255,0.2)",
          color: "#7DA4FF",
        }}
      >
        <Crosshair className="h-8 w-8" strokeWidth={2} />
      </div>
      <h3 className="font-display text-[19px] font-semibold tracking-tight text-[#EEF2FF] mb-1.5">
        Nenhuma meta criada
      </h3>
      <p className="text-[13px] leading-snug font-light max-w-[280px] mb-5" style={{ color: "#8B9CC8" }}>
        Use o botão + para criar sua primeira meta e definir um objetivo claro.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full text-[13px] font-semibold text-white tracking-[0.02em]"
        style={{ background: "#4F7EFF", boxShadow: "0 4px 14px rgba(79,126,255,0.4)" }}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        Criar meta
      </button>
    </div>
  );
}

interface GoalCardProps {
  goal: Goal;
  isExpired: boolean;
  onIncrement: () => void;
  onIncrementBig: () => void;
  onArchive: () => void;
  onDelete: () => void;
  style?: React.CSSProperties;
}

function GoalCard({ goal, isExpired, onIncrement, onIncrementBig, onArchive, onDelete, style }: GoalCardProps) {
  const Icon = KIND_ICON[goal.kind];
  const color = KIND_COLOR[goal.kind];
  const isCompleted = goal.status === "completed";
  const isArchived = goal.status === "archived";
  const ratio =
    goal.target_value != null && goal.target_value > 0
      ? Math.min(1, goal.current_value / goal.target_value)
      : isCompleted
        ? 1
        : 0;

  const [w, setW] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setW(Math.round(ratio * 100)), 200);
    return () => window.clearTimeout(id);
  }, [ratio]);

  return (
    <article
      className="screen-item relative rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] p-4 flex flex-col gap-3 overflow-hidden"
      style={style}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 bottom-0"
        style={{ width: 3, background: color, opacity: isArchived ? 0.3 : 1 }}
      />
      <div className="flex items-start gap-3 pl-1">
        <span
          className="h-9 w-9 rounded-[10px] grid place-items-center shrink-0"
          style={{ background: `${color}24`, color }}
        >
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="font-display text-[15px] font-semibold text-[#EEF2FF] leading-tight"
            style={isCompleted || isArchived ? { textDecoration: isArchived ? "line-through" : undefined, color: "#8B9CC8" } : undefined}
          >
            {goal.title}
          </div>
          {goal.description ? (
            <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: "#8B9CC8" }}>
              {goal.description}
            </div>
          ) : null}
          <div className="flex items-center gap-2 mt-2 flex-wrap text-[10px]" style={{ color: "#4D5E8A" }}>
            <span
              className="inline-flex items-center px-2 py-[3px] rounded-full text-[10px] font-medium"
              style={{ background: `${color}1f`, color, border: `1px solid ${color}33` }}
            >
              {KIND_LABEL[goal.kind]}
            </span>
            {goal.deadline ? (
              <span
                className="inline-flex items-center gap-1"
                style={isExpired ? { color: "#FF5B72" } : undefined}
              >
                <Calendar className="h-2.5 w-2.5" strokeWidth={2.2} />
                {dateAbbr(goal.deadline)}
              </span>
            ) : null}
            {isCompleted ? <span style={{ color: "#2DD4BF" }}>✓ Concluída</span> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onArchive}
            className="px-2 py-1 rounded-md text-[10px] tracking-[0.04em] uppercase font-semibold"
            style={{
              color: isArchived ? "#7DA4FF" : "#4D5E8A",
              background: isArchived ? "rgba(79,126,255,0.10)" : "transparent",
            }}
          >
            {isArchived ? "Restaurar" : "Arquivar"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Excluir"
            className="grid place-items-center h-7 w-7 rounded-md"
            style={{ color: "#4D5E8A" }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {goal.target_value != null ? (
        <div className="flex items-center gap-2 pl-1">
          <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: "#162040" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${w}%`,
                background: color,
                boxShadow: `0 0 8px ${color}40`,
                transition: "width 1s cubic-bezier(0.2,0.9,0.3,1)",
              }}
            />
          </div>
          <span className="font-mono text-[10px] shrink-0" style={{ color: "#4D5E8A" }}>
            {fmtNum(goal.current_value, goal.unit)} / {fmtNum(goal.target_value, goal.unit)}
          </span>
          {!isArchived && !isCompleted ? (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={onIncrement}
                className="px-2 py-1 rounded-md text-[10px] font-bold"
                style={{ background: `${color}22`, color }}
                aria-label="+1"
              >
                +1
              </button>
              <button
                type="button"
                onClick={onIncrementBig}
                className="px-2 py-1 rounded-md text-[10px] font-bold"
                style={{ background: `${color}22`, color }}
                aria-label="+10"
              >
                +10
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-[10px] pl-1" style={{ color: "#4D5E8A" }}>
          Sem alvo numérico — toque arquivar quando concluir.
        </div>
      )}
    </article>
  );
}

interface NewGoalFormProps {
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: goalsApi.CreateGoalBody) => Promise<void> | void;
}

function NewGoalForm({ busy, onCancel, onCreate }: NewGoalFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<GoalKind>("general");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [deadline, setDeadline] = useState("");
  const canSubmit = title.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    const targetNum = target ? Number(target.replace(",", ".")) : null;
    void onCreate({
      title: title.trim(),
      description: description.trim() || null,
      kind,
      target_value: targetNum && Number.isFinite(targetNum) ? targetNum : null,
      unit: unit.trim() || null,
      deadline: deadline || null,
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
        <div className="flex p-[3px] gap-[2px] rounded-[10px]" style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}>
          {(["general", "financial", "habit", "project"] as GoalKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className="flex-1 px-2 py-1.5 rounded-[7px] text-[11px] font-medium transition-colors"
              style={tabStyle(kind === k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Título
        </span>
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === "financial" ? "Ex.: Economizar R$ 5000" : "Ex.: Ler 12 livros"}
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={inputStyle}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Descrição (opcional)
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Pra que serve, como vai medir o sucesso…"
          rows={2}
          className="rounded-lg px-3.5 py-2.5 placeholder:text-[#4D5E8A] focus:outline-none resize-y"
          style={inputStyle}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Alvo (opcional)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="0"
            className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none font-mono"
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Unidade
          </span>
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="R$, livros, km…"
            className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
            style={inputStyle}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Prazo (opcional)
        </span>
        <input
          type="date"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
          style={inputStyle}
        />
      </label>

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
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}

// expose unused refs for tree-shaking quietness
void Target;
void SparklesIcon;
