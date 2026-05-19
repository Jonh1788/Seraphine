import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Clock,
  Flame,
  BarChart3,
  Loader2,
  Plus,
  TrendingUp,
  Users,
} from "lucide-react";
import * as tasksApi from "../api/tasks";
import type { Task, TaskStatus } from "../types/api";
import { Sheet } from "../components/Sheet";
import { TaskEditorModal } from "../components/TaskEditorModal";
import { RemindersPicker } from "../components/RemindersPicker";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useCountUp } from "../hooks/useCountUp";

const WEEKDAY_LABELS_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

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
  return `${pad2(d)}/${pad2(m)}`;
}

type GroupKey = "late" | "today" | "nodate" | "upcoming" | "done";

interface TaskGroup {
  key: GroupKey;
  label: string;
  items: Task[];
}

function groupTasks(tasks: Task[], todayIso: string): TaskGroup[] {
  const late: Task[] = [];
  const today: Task[] = [];
  const nodate: Task[] = [];
  const upcoming: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.status === "completed") {
      done.push(t);
    } else if (!t.due_date) {
      nodate.push(t);
    } else if (t.due_date < todayIso) {
      late.push(t);
    } else if (t.due_date === todayIso) {
      today.push(t);
    } else {
      upcoming.push(t);
    }
  }
  // Sort each
  const byDateTime = (a: Task, b: Task) => {
    const da = `${a.due_date ?? "9999"}T${a.due_time ?? "23:59"}`;
    const db = `${b.due_date ?? "9999"}T${b.due_time ?? "23:59"}`;
    return da.localeCompare(db);
  };
  late.sort(byDateTime);
  today.sort(byDateTime);
  upcoming.sort(byDateTime);
  return [
    { key: "late", label: "Atrasadas", items: late },
    { key: "today", label: "Hoje", items: today },
    { key: "nodate", label: "Sem Data", items: nodate },
    { key: "upcoming", label: "Próximas", items: upcoming },
    { key: "done", label: "Concluídas", items: done },
  ];
}

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "normal" | "recurring">("all");
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    late: false,
    today: false,
    nodate: false,
    upcoming: false,
    done: true,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ts = await tasksApi.listTasks({ limit: 300 });
      setTasks(ts);
    } catch {
      setError("Falha ao carregar tarefas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  const today = useMemo(() => new Date(), []);
  const todayIso = isoLocal(today);

  const filtered = useMemo(() => {
    if (filter === "all") return tasks;
    if (filter === "recurring") return tasks.filter((t) => t.type === "recurring");
    return tasks.filter((t) => t.type !== "recurring");
  }, [tasks, filter]);

  const groups = useMemo(
    () => groupTasks(filtered, todayIso),
    [filtered, todayIso],
  );

  const total = filtered.length;
  const lateCount = groups.find((g) => g.key === "late")?.items.length ?? 0;
  const todayCount = groups.find((g) => g.key === "today")?.items.length ?? 0;
  const pendingCount = filtered.filter((t) => t.status !== "completed").length;
  const doneCount = filtered.filter((t) => t.status === "completed").length;

  const completionPct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  // Health score: penalize lateness, reward completion
  const healthScore = useMemo(() => {
    if (total === 0) return 100;
    const overduePenalty = Math.min(60, lateCount * 12);
    const completionBoost = Math.round((doneCount / total) * 40);
    return Math.max(0, Math.min(100, 60 - overduePenalty + completionBoost + 40));
  }, [total, lateCount, doneCount]);

  const healthTone: "green" | "amber" | "red" =
    healthScore >= 70 ? "green" : healthScore >= 40 ? "amber" : "red";

  const compTone: "green" | "amber" | "red" =
    completionPct >= 70 ? "green" : completionPct >= 30 ? "amber" : "red";

  // Streak: consecutive past days with at least one completion (uses
  // updated_at heuristically). Cheap approximation; real streak should
  // come from a proper completion-log table later.
  const streak = useMemo(() => {
    const completed = tasks.filter((t) => t.status === "completed" && t.updated_at);
    const days = new Set(completed.map((t) => (t.updated_at ?? "").slice(0, 10)));
    let n = 0;
    const cur = new Date(today);
    while (days.has(isoLocal(cur))) {
      n += 1;
      cur.setDate(cur.getDate() - 1);
    }
    return n;
  }, [tasks, today]);

  // Last 7 days bar chart (count of completions per day)
  const last7 = useMemo(() => {
    const slots: Array<{ label: string; count: number; isToday: boolean }> = [];
    const completed = tasks.filter((t) => t.status === "completed" && t.updated_at);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const iso = isoLocal(d);
      const count = completed.filter((t) => (t.updated_at ?? "").slice(0, 10) === iso).length;
      const dayIdx = (d.getDay() + 6) % 7; // Mon=0
      slots.push({ label: WEEKDAY_LABELS_PT[dayIdx], count, isToday: i === 0 });
    }
    return slots;
  }, [tasks, today]);
  const max7 = Math.max(1, ...last7.map((s) => s.count));

  // Most productive weekday
  const productiveDay = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    const completed = tasks.filter((t) => t.status === "completed" && t.updated_at);
    for (const t of completed) {
      const d = new Date((t.updated_at ?? "").slice(0, 10));
      const idx = (d.getDay() + 6) % 7;
      counts[idx] += 1;
    }
    const maxIdx = counts.indexOf(Math.max(...counts));
    return Math.max(...counts) === 0 ? null : WEEKDAY_LABELS_PT[maxIdx];
  }, [tasks]);

  const toggleGroup = (k: GroupKey) =>
    setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  const onCheck = useCallback(
    async (task: Task) => {
      const next: TaskStatus = task.status === "completed" ? "pending" : "completed";
      // Optimistic
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: next } : t)),
      );
      try {
        await tasksApi.updateTaskStatus(task.id, next);
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(8);
      } catch {
        await load();
      }
    },
    [load],
  );

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Tarefas
        </h1>
        <span
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
          style={{ background: "rgba(255,91,114,0.12)", border: "1px solid rgba(255,91,114,0.2)" }}
        >
          <span className="h-[5px] w-[5px] rounded-full animate-pulse" style={{ background: "#FF5B72" }} />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase" style={{ color: "#FF5B72" }}>
            LIVE
          </span>
        </span>
      </div>

      {/* Health card */}
      <section
        className="mx-4 mb-3.5 p-5 rounded-[20px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] screen-item"
        style={animDelay(1)}
      >
        <div className="flex items-start gap-5 mb-4">
          <HealthRing score={healthScore} tone={healthTone} />
          <div className="flex-1 pt-1 min-w-0">
            <div className="text-[15px] font-semibold tracking-tight text-[#EEF2FF] mb-1.5 leading-tight">
              {healthLabel(healthScore, lateCount)}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip kind="neutral">{total} tarefa(s)</Chip>
              {lateCount > 0 ? <Chip kind="red">{lateCount} atrasada(s)</Chip> : null}
              {pendingCount > 0 ? <Chip kind="amber">{pendingCount} pendente(s)</Chip> : null}
              <Chip kind="blue">{todayCount} hoje</Chip>
            </div>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#4D5E8A" }}>
              Taxa de Conclusão
            </span>
            <span className={`text-[14px] font-bold ${compToneClass(compTone)}`}>
              {completionPct}%
            </span>
          </div>
          <div className="h-[5px] rounded-full mb-1.5 overflow-hidden" style={{ background: "#162040" }}>
            <CompletionBar pct={completionPct} tone={compTone} />
          </div>
          <div className={`text-[11px] italic ${compToneClass(compTone)}`}>
            {completionNote(compTone)}
          </div>
        </div>

        {(streak > 0 || productiveDay) ? (
          <div
            className="flex flex-wrap gap-4 mb-3.5 py-2.5"
            style={{
              borderTop: "1px solid rgba(99,130,255,0.10)",
              borderBottom: "1px solid rgba(99,130,255,0.10)",
            }}
          >
            {streak > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "#F5A623" }}>
                <Flame className="h-3 w-3" />
                {streak} dia{streak === 1 ? "" : "s"} seguido{streak === 1 ? "" : "s"}
              </span>
            ) : null}
            {productiveDay ? (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "#7DA4FF" }}>
                <TrendingUp className="h-3 w-3" />
                {productiveDay} mais produtivo
              </span>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[12px] font-medium"
          style={{ color: "#7DA4FF" }}
        >
          <BarChart3 className="h-3 w-3" strokeWidth={2.2} />
          Análise completa
          <ChevronRightIcon className="h-3 w-3" strokeWidth={2.2} />
        </button>
      </section>

      {/* Stats grid */}
      <section
        className="mx-4 mb-3.5 grid grid-cols-4 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] overflow-hidden screen-item"
        style={animDelay(2)}
      >
        <StatCell label="Total" value={total} color="#7DA4FF" />
        <StatCell label="Atrasadas" value={lateCount} color="#FF5B72" border />
        <StatCell label="Pendentes" value={pendingCount} color="#F5A623" border />
        <StatCell label="Feitas" value={doneCount} color="#2DD4BF" border />
      </section>

      {/* Week card */}
      <section
        className="mx-4 mb-3.5 p-3.5 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] screen-item"
        style={animDelay(3)}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#4D5E8A" }}>
            Últimos 7 dias
          </span>
          <span className="text-[11px]" style={{ color: "#4D5E8A" }}>
            {last7.reduce((a, b) => a + b.count, 0)} concluídas
          </span>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {last7.map((slot, i) => {
            const ratio = slot.count / max7;
            const h = Math.max(3, Math.round(ratio * 32));
            const bg = slot.isToday
              ? "#4F7EFF"
              : slot.count > 0
                ? "#4F7EFF"
                : "#162040";
            const glow = slot.isToday ? "0 0 8px rgba(79,126,255,0.5)" : undefined;
            return (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <div className="h-8 w-full flex items-end">
                  <div
                    className="w-full rounded-t-[3px]"
                    style={{ height: h, background: bg, boxShadow: glow, transition: "height 0.6s cubic-bezier(0.2,0.9,0.3,1)" }}
                  />
                </div>
                <span
                  className="text-[9px] uppercase tracking-[0.04em] font-medium"
                  style={{
                    color: slot.isToday ? "#7DA4FF" : "#4D5E8A",
                    fontWeight: slot.isToday ? 700 : 500,
                  }}
                >
                  {slot.label}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 mb-3.5 screen-item" style={animDelay(4)}>
        <div
          className="flex p-[3px] gap-[2px] rounded-[10px]"
          style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}
        >
          <FilterTab active={filter === "all"} onClick={() => setFilter("all")}>Todas</FilterTab>
          <FilterTab active={filter === "normal"} onClick={() => setFilter("normal")}>Normais</FilterTab>
          <FilterTab active={filter === "recurring"} onClick={() => setFilter("recurring")}>Recorrentes</FilterTab>
        </div>
        <div
          className="ml-auto flex items-center gap-1.5 px-2 py-1.5 rounded-[8px]"
          style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}
        >
          <ColorDot hex="#FF5B72" />
          <ColorDot hex="#F5A623" />
          <ColorDot hex="#2DD4BF" />
        </div>
      </div>

      {/* Task groups */}
      {error ? (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg text-[11px]" style={{
          background: "rgba(255,91,114,0.12)",
          border: "1px solid rgba(255,91,114,0.2)",
          color: "#FF5B72",
        }}>
          {error}
        </div>
      ) : null}

      {loading && tasks.length === 0 ? (
        <div className="grid place-items-center py-10" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="px-4 flex flex-col gap-3">
          {groups
            .filter((g) => g.items.length > 0 || g.key === "done")
            .map((g, i) => (
              <TaskGroupView
                key={g.key}
                group={g}
                collapsed={collapsed[g.key]}
                onToggle={() => toggleGroup(g.key)}
                onCheck={onCheck}
                onOpen={(id) => setEditing(id)}
                style={animDelay(5 + i)}
              />
            ))}
        </div>
      )}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setNewOpen(true)}
        aria-label="Nova tarefa"
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

      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="Nova tarefa" maxWidth="max-w-md">
        <NewTaskForm
          onCancel={() => setNewOpen(false)}
          onCreated={async () => {
            setNewOpen(false);
            await load();
          }}
        />
      </Sheet>

      {editing ? (
        <TaskEditorModal
          taskId={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onDeleted={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function healthLabel(score: number, late: number): React.ReactNode {
  if (late === 0 && score >= 70) return "Tudo sob controle.";
  if (late > 0) return (
    <>
      Quase limpo
      <br />— {late} atrasada{late === 1 ? "" : "s"}
    </>
  );
  return "Em construção.";
}

function completionNote(tone: "green" | "amber" | "red"): string {
  if (tone === "green") return "Excelente ritmo";
  if (tone === "amber") return "Espaço pra melhorar";
  return "Atenção necessária";
}

function compToneClass(tone: "green" | "amber" | "red"): string {
  return tone === "green"
    ? "text-[#2DD4BF]"
    : tone === "amber"
      ? "text-[#F5A623]"
      : "text-[#FF5B72]";
}

interface HealthRingProps {
  score: number;
  tone: "green" | "amber" | "red";
}

function HealthRing({ score, tone }: HealthRingProps) {
  const r = 35;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - score / 100);
  const color = tone === "green" ? "#2DD4BF" : tone === "amber" ? "#F5A623" : "#FF5B72";
  const glow =
    tone === "green"
      ? "rgba(45,212,191,0.5)"
      : tone === "amber"
        ? "rgba(245,166,35,0.5)"
        : "rgba(255,91,114,0.5)";
  const animatedScore = useCountUp(score, 850, score);
  return (
    <div className="relative shrink-0" style={{ width: 80, height: 80 }}>
      <svg
        width={80}
        height={80}
        viewBox="0 0 80 80"
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        <circle cx={40} cy={40} r={r} fill="none" stroke="#162040" strokeWidth={6} />
        <circle
          cx={40}
          cy={40}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="ring-fill-anim"
          style={{ filter: `drop-shadow(0 0 6px ${glow})` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="font-display text-[20px] font-bold leading-none tracking-tight text-[#EEF2FF]">
            {animatedScore}
          </div>
          <div className="text-[8px] mt-0.5 uppercase tracking-[0.1em]" style={{ color: "#4D5E8A" }}>
            Saúde
          </div>
        </div>
      </div>
    </div>
  );
}

interface CompletionBarProps {
  pct: number;
  tone: "green" | "amber" | "red";
}

function CompletionBar({ pct, tone }: CompletionBarProps) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setW(pct), 200);
    return () => window.clearTimeout(id);
  }, [pct]);
  const color = tone === "green" ? "#2DD4BF" : tone === "amber" ? "#F5A623" : "#FF5B72";
  const glow =
    tone === "green"
      ? "rgba(45,212,191,0.4)"
      : tone === "amber"
        ? "rgba(245,166,35,0.4)"
        : "rgba(255,91,114,0.4)";
  return (
    <div
      className="h-full rounded-full"
      style={{
        width: `${w}%`,
        background: color,
        boxShadow: `0 0 8px ${glow}`,
        transition: "width 1s cubic-bezier(0.2,0.9,0.3,1)",
      }}
    />
  );
}

function Chip({ kind, children }: { kind: "neutral" | "red" | "amber" | "blue" | "green"; children: React.ReactNode }) {
  const styles: Record<typeof kind, React.CSSProperties> = {
    neutral: { background: "#111B38", color: "#8B9CC8" },
    red: { background: "rgba(255,91,114,0.12)", color: "#FF5B72", border: "1px solid rgba(255,91,114,0.2)" },
    amber: { background: "rgba(245,166,35,0.15)", color: "#F5A623", border: "1px solid rgba(245,166,35,0.2)" },
    blue: { background: "rgba(79,126,255,0.15)", color: "#7DA4FF", border: "1px solid rgba(79,126,255,0.2)" },
    green: { background: "rgba(45,212,191,0.12)", color: "#2DD4BF", border: "1px solid rgba(45,212,191,0.2)" },
  };
  return (
    <span
      className="inline-flex items-center px-2 py-[3px] rounded-full text-[11px] font-medium"
      style={styles[kind]}
    >
      {children}
    </span>
  );
}

interface StatCellProps {
  label: string;
  value: number;
  color: string;
  border?: boolean;
}

function StatCell({ label, value, color, border }: StatCellProps) {
  const animated = useCountUp(value, 850, value);
  return (
    <div
      className="px-2.5 py-3.5 text-center"
      style={border ? { borderLeft: "1px solid rgba(99,130,255,0.10)" } : undefined}
    >
      <div
        className="text-[9px] font-semibold uppercase tracking-[0.08em] mb-1.5"
        style={{ color: "#4D5E8A" }}
      >
        {label}
      </div>
      <div
        className="font-display text-[22px] font-bold leading-none tracking-tight"
        style={{ color }}
      >
        {animated}
      </div>
    </div>
  );
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 rounded-[7px] text-[11px] font-medium tracking-[0.02em] whitespace-nowrap transition-colors"
      style={
        active
          ? { background: "#162040", color: "#EEF2FF" }
          : { background: "transparent", color: "#4D5E8A" }
      }
    >
      {children}
    </button>
  );
}

function ColorDot({ hex }: { hex: string }) {
  return <div className="h-[7px] w-[7px] rounded-full" style={{ background: hex }} />;
}

interface TaskGroupViewProps {
  group: TaskGroup;
  collapsed: boolean;
  onToggle: () => void;
  onCheck: (t: Task) => void;
  onOpen: (id: string) => void;
  style?: React.CSSProperties;
}

const GROUP_LABEL_COLOR: Record<GroupKey, string> = {
  late: "#FF5B72",
  today: "#7DA4FF",
  nodate: "#4D5E8A",
  upcoming: "#4D5E8A",
  done: "#2DD4BF",
};
const GROUP_COUNT_BG: Record<GroupKey, React.CSSProperties> = {
  late: { background: "rgba(255,91,114,0.12)", color: "#FF5B72" },
  today: { background: "rgba(79,126,255,0.15)", color: "#7DA4FF" },
  nodate: { background: "#111B38", color: "#4D5E8A" },
  upcoming: { background: "#111B38", color: "#4D5E8A" },
  done: { background: "rgba(45,212,191,0.12)", color: "#2DD4BF" },
};
const GROUP_BORDER_LEFT: Record<GroupKey, string | undefined> = {
  late: "3px solid #FF5B72",
  today: "3px solid #7DA4FF",
  nodate: undefined,
  upcoming: undefined,
  done: "3px solid #2DD4BF",
};

function TaskGroupView({ group, collapsed, onToggle, onCheck, onOpen, style }: TaskGroupViewProps) {
  return (
    <div className="screen-item" style={style}>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 mb-2 py-1 w-full text-left"
      >
        {collapsed ? (
          <ChevronRightIcon className="h-2.5 w-2.5" style={{ color: "#4D5E8A" }} strokeWidth={2.4} />
        ) : (
          <ChevronDown className="h-2.5 w-2.5" style={{ color: "#4D5E8A" }} strokeWidth={2.4} />
        )}
        <span
          className="text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ color: GROUP_LABEL_COLOR[group.key] }}
        >
          {group.label}
        </span>
        <span
          className="grid place-items-center text-[10px] font-bold rounded-[5px]"
          style={{ width: 18, height: 18, ...GROUP_COUNT_BG[group.key] }}
        >
          {group.items.length}
        </span>
      </button>
      {!collapsed && group.items.length > 0 ? (
        <div
          className="rounded-[16px] overflow-hidden bg-[#0C1228] border border-[rgba(99,130,255,0.10)]"
          style={{ borderLeft: GROUP_BORDER_LEFT[group.key] }}
        >
          {group.items.map((t, i) => (
            <TaskItem
              key={t.id}
              task={t}
              groupKey={group.key}
              isLast={i === group.items.length - 1}
              onCheck={() => onCheck(t)}
              onOpen={() => onOpen(t.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface TaskItemProps {
  task: Task;
  groupKey: GroupKey;
  isLast: boolean;
  onCheck: () => void;
  onOpen: () => void;
}

function TaskItem({ task, groupKey, isLast, onCheck, onOpen }: TaskItemProps) {
  const isDone = task.status === "completed";
  const isLate = groupKey === "late";
  const checkBorder = isDone ? "#2DD4BF" : isLate ? "#FF5B72" : "#F5A623";
  const checkBg = isDone ? "#2DD4BF" : "transparent";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="flex items-center gap-3 px-3.5 py-3 cursor-pointer transition-colors hover:bg-[#111B38]"
      style={!isLast ? { borderBottom: "1px solid rgba(99,130,255,0.10)" } : undefined}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCheck(); }}
        aria-pressed={isDone}
        className="grid place-items-center shrink-0 transition-all"
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          border: `1.5px solid ${checkBorder}`,
          background: checkBg,
        }}
      >
        {isDone ? <Check className="h-[10px] w-[10px] text-white" strokeWidth={3} /> : null}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <div
            className="text-[13px] font-medium truncate"
            style={{
              color: isDone ? "#4D5E8A" : "#EEF2FF",
              textDecoration: isDone ? "line-through" : undefined,
            }}
          >
            {task.title}
          </div>
          {(task.participants?.length ?? 0) > 1 ? (
            <span
              aria-label="Tarefa compartilhada"
              title={(task.participants ?? []).join(", ")}
            >
              <Users
                className="h-3 w-3 shrink-0"
                style={{ color: isDone ? "#4D5E8A" : "#7B8FFF" }}
              />
            </span>
          ) : null}
        </div>
        <div
          className="flex items-center gap-1.5 text-[10px]"
          style={{ color: isLate ? "rgba(255,91,114,0.85)" : "#4D5E8A" }}
        >
          {task.due_date ? (
            <>
              {isLate ? <Clock className="h-2.5 w-2.5" strokeWidth={2.2} /> : <Calendar className="h-2.5 w-2.5" strokeWidth={2.2} />}
              {dateAbbr(task.due_date)}
              {task.due_time ? ` · ${task.due_time}` : ""}
            </>
          ) : (
            "Sem data definida"
          )}
        </div>
        {isDone && task.completed_by_email ? (
          <div className="text-[10px] mt-0.5" style={{ color: "#4D5E8A" }}>
            concluído por {task.completed_by_email}
          </div>
        ) : null}
      </div>
      {task.priority === "high" ? (
        <TagBadge kind="amber">Alta</TagBadge>
      ) : task.priority === "med" ? (
        <TagBadge>Média</TagBadge>
      ) : null}
    </div>
  );
}

function TagBadge({ kind, children }: { kind?: "amber" | "blue"; children: React.ReactNode }) {
  const styles: React.CSSProperties =
    kind === "amber"
      ? { background: "rgba(245,166,35,0.15)", color: "#F5A623", border: "1px solid rgba(245,166,35,0.2)" }
      : kind === "blue"
        ? { background: "rgba(79,126,255,0.15)", color: "#7DA4FF", border: "1px solid rgba(79,126,255,0.2)" }
        : { background: "#111B38", color: "#4D5E8A", border: "1px solid rgba(99,130,255,0.10)" };
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-[0.04em] px-1.5 py-[2px] rounded-full shrink-0"
      style={styles}
    >
      {children}
    </span>
  );
}

interface NewTaskFormProps {
  onCancel: () => void;
  onCreated: () => Promise<void> | void;
}

function NewTaskForm({ onCancel, onCreated }: NewTaskFormProps) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [priority, setPriority] = useState<"low" | "med" | "high">("low");
  const [reminderOffsets, setReminderOffsets] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await tasksApi.createTask({
        type: "generic",
        title: title.trim(),
        source: "web",
        payload: {},
        due_date: dueDate || null,
        due_time: dueTime || null,
        priority,
        reminder_offsets:
          dueTime && reminderOffsets.length > 0 ? reminderOffsets : undefined,
      });
      await onCreated();
    } catch {
      setErr("Falha ao criar tarefa");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: "rgba(17,27,56,0.6)",
    border: "1px solid rgba(99,130,255,0.10)",
    color: "#EEF2FF",
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Título
        </span>
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex.: Revisar deploy"
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
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Hora
          </span>
          <input
            type="time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
            style={inputStyle}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Prioridade
        </span>
        <div className="flex p-[3px] gap-[2px] rounded-[10px]" style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}>
          {(["low", "med", "high"] as const).map((p) => (
            <FilterTab key={p} active={priority === p} onClick={() => setPriority(p)}>
              {p === "low" ? "Baixa" : p === "med" ? "Média" : "Alta"}
            </FilterTab>
          ))}
        </div>
      </div>

      {dueTime ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Lembretes extras
          </span>
          <RemindersPicker
            value={reminderOffsets}
            onChange={setReminderOffsets}
          />
        </div>
      ) : null}

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
          disabled={!title.trim() || busy}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-white font-medium disabled:opacity-50"
          style={{ background: "#4F7EFF", boxShadow: "0 4px 20px rgba(79,126,255,0.5)" }}
        >
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}
