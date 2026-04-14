import { CheckCircle2, Circle, ListChecks, Clock } from "lucide-react";
import type { InlineTask } from "../api/chat";

interface Props {
  tasks: InlineTask[];
  onOpen?: (taskId: string) => void;
}

function isoToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDateLabel(iso: string | null | undefined): string {
  if (!iso) return "Sem data";
  const today = isoToday();
  if (iso === today) return "HOJE";
  // YYYY-MM-DD → "DD/MM"
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}`;
}

function groupByDate(tasks: InlineTask[]): [string, InlineTask[]][] {
  const groups = new Map<string, InlineTask[]>();
  for (const t of tasks) {
    const key = (t.due_date ?? "").slice(0, 10) || "no-date";
    const arr = groups.get(key);
    if (arr) {
      arr.push(t);
    } else {
      groups.set(key, [t]);
    }
  }
  // Preserve insertion order (tasks arrive in chronological tool-call order).
  return Array.from(groups.entries());
}

export function TasksBlock({ tasks, onOpen }: Props) {
  if (tasks.length === 0) return null;
  const groups = groupByDate(tasks);

  return (
    <div className="my-3 border-l-2 border-cyan-500/50 pl-4">
      {/* Header summary */}
      <div className="flex items-center gap-3 mb-3">
        <div className="h-9 w-9 rounded-lg bg-cyan-500/15 grid place-items-center">
          <ListChecks className="h-4 w-4 text-cyan-300" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink-primary">Tarefas</div>
          <div className="text-xs text-ink-faint">
            {tasks.length} {tasks.length === 1 ? "tarefa" : "tarefas"}
          </div>
        </div>
      </div>

      {/* Grouped cards */}
      <div className="flex flex-col gap-3">
        {groups.map(([key, items]) => {
          const label =
            key === "no-date" ? "SEM DATA" : fmtDateLabel(key);
          return (
            <div key={key} className="flex flex-col gap-2">
              <div className="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
                {label}
              </div>
              {items.map((t) => (
                <Card key={t.id} t={t} onOpen={onOpen} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ t, onOpen }: { t: InlineTask; onOpen?: (id: string) => void }) {
  const isDone = t.status === "completed";
  // Static class names so Tailwind's JIT can include them in the build.
  const Icon = isDone ? CheckCircle2 : Circle;
  const iconFg = isDone ? "text-emerald-400" : "text-cyan-300";
  const titleCls = isDone
    ? "text-[15px] font-medium text-ink-dim line-through"
    : "text-[15px] font-medium text-ink-primary";

  const inner = (
    <>
      <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${iconFg}`} />
      <div className="flex-1 min-w-0">
        <div className={titleCls}>{t.title}</div>
        {t.due_time ? (
          <div className="flex items-center gap-1 mt-1 text-xs text-ink-faint">
            <Clock className="h-3 w-3" />
            {t.due_time}
          </div>
        ) : null}
      </div>
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen(String(t.id))}
        className="flex items-start gap-3 rounded-lg bg-white/[0.03] border border-white/5 p-3 text-left hover:border-white/10 hover:bg-white/[0.06] transition-colors w-full"
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-lg bg-white/[0.03] border border-white/5 p-3">
      {inner}
    </div>
  );
}
