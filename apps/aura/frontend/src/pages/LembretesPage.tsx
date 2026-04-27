import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Clock,
  Loader2,
  Plus,
  Repeat,
  Send,
} from "lucide-react";
import * as tasksApi from "../api/tasks";
import * as pushApi from "../api/push";
import type { Task, TaskStatus } from "../types/api";
import { Sheet } from "../components/Sheet";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useCountUp } from "../hooks/useCountUp";
import { usePushSubscription } from "../pwa/usePushSubscription";

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

type GroupKey = "expired" | "today" | "upcoming" | "recurring" | "done";

interface ReminderGroup {
  key: GroupKey;
  label: string;
  items: Task[];
}

function groupReminders(tasks: Task[], todayIso: string): ReminderGroup[] {
  const expired: Task[] = [];
  const today: Task[] = [];
  const upcoming: Task[] = [];
  const recurring: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.status === "completed") {
      done.push(t);
    } else if (t.type === "recurring") {
      recurring.push(t);
    } else if (!t.due_date) {
      upcoming.push(t);
    } else if (t.due_date < todayIso) {
      expired.push(t);
    } else if (t.due_date === todayIso) {
      today.push(t);
    } else {
      upcoming.push(t);
    }
  }
  const byTimeAsc = (a: Task, b: Task) => {
    const da = `${a.due_date ?? "9999"}T${a.due_time ?? "23:59"}`;
    const db = `${b.due_date ?? "9999"}T${b.due_time ?? "23:59"}`;
    return da.localeCompare(db);
  };
  expired.sort(byTimeAsc).reverse(); // mais recente primeiro
  today.sort(byTimeAsc);
  upcoming.sort(byTimeAsc);
  return [
    { key: "expired", label: "Expirados", items: expired },
    { key: "today", label: "Hoje", items: today },
    { key: "upcoming", label: "Próximos", items: upcoming },
    { key: "recurring", label: "Recorrentes", items: recurring },
    { key: "done", label: "Concluídos", items: done },
  ];
}

export function LembretesPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    expired: false,
    today: false,
    upcoming: false,
    recurring: false,
    done: true,
  });
  const [newOpen, setNewOpen] = useState(false);
  const push = usePushSubscription();
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // listTasks accepts a `type` query param; reminders use type="reminder".
      // Recurring rules surface here when their generated tasks fire.
      const all = await tasksApi.listTasks({ type: "reminder", limit: 300 });
      setTasks(all);
    } catch {
      setError("Falha ao carregar lembretes");
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

  const groups = useMemo(() => groupReminders(tasks, todayIso), [tasks, todayIso]);

  const total = tasks.length;
  const todayCount = groups.find((g) => g.key === "today")?.items.length ?? 0;
  const expiredCount = groups.find((g) => g.key === "expired")?.items.length ?? 0;
  const dispCount = todayCount + (groups.find((g) => g.key === "upcoming")?.items.length ?? 0);
  const recurringCount = groups.find((g) => g.key === "recurring")?.items.length ?? 0;

  // Health: 100 if zero expired; cai 12 por expirado, com floor 0
  const healthScore = Math.max(0, 100 - expiredCount * 12);
  const healthTone: "green" | "amber" | "red" =
    healthScore >= 70 ? "green" : healthScore >= 40 ? "amber" : "red";

  const onCheck = useCallback(
    async (task: Task) => {
      const next: TaskStatus = task.status === "completed" ? "pending" : "completed";
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

  const sendTest = async () => {
    setTesting(true);
    try {
      await pushApi.sendTestPush();
    } finally {
      setTesting(false);
    }
  };

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  const toggleGroup = (k: GroupKey) =>
    setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Lembretes
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

      {/* Snap row 4 cells */}
      <section className="grid grid-cols-4 gap-2 mx-4 mb-3.5 screen-item" style={animDelay(1)}>
        <SnapCell label="Total" value={total} color="#7DA4FF" />
        <SnapCell label="Hoje" value={todayCount} color="#EEF2FF" />
        <SnapCell label="Expir." value={expiredCount} color="#FF5B72" />
        <SnapCell label="Disp." value={dispCount} color="#EEF2FF" />
      </section>

      {/* Health card */}
      <section
        className="mx-4 mb-3.5 p-5 rounded-[20px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] screen-item"
        style={animDelay(2)}
      >
        <div className="flex items-start gap-5">
          <HealthRing score={healthScore} tone={healthTone} />
          <div className="flex-1 pt-1 min-w-0">
            <div className="text-[15px] font-semibold tracking-tight text-[#EEF2FF] mb-1.5 leading-tight">
              {expiredCount > 0 ? (
                <>
                  {expiredCount} expirado{expiredCount === 1 ? "" : "s"}
                  <br />
                  precisa{expiredCount === 1 ? "" : "m"} atenção
                </>
              ) : todayCount > 0 ? (
                <>{todayCount} hoje, em dia.</>
              ) : (
                "Tudo em dia."
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {expiredCount > 0 ? <Chip kind="red">{expiredCount} expirado(s)</Chip> : null}
              {recurringCount > 0 ? <Chip kind="blue">{recurringCount} recorrente(s)</Chip> : null}
              {expiredCount === 0 && recurringCount === 0 ? (
                <Chip kind="green">Sem pendências</Chip>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* Push notification toggle */}
      <PushBanner
        push={push}
        onTest={sendTest}
        testing={testing}
        style={animDelay(3)}
      />



      {/* Alert pill */}
      {expiredCount > 0 && todayCount === 0 ? (
        <div
          className="mx-4 mb-3 px-3.5 py-2.5 rounded-[12px] flex items-center gap-2 text-[12px] font-medium screen-item"
          style={{
            ...animDelay(4),
            background: "rgba(245,166,35,0.15)",
            border: "1px solid rgba(245,166,35,0.25)",
            color: "#F5A623",
          }}
        >
          <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.2} />
          Nenhum lembrete próximo — exibindo {expiredCount} expirado{expiredCount === 1 ? "" : "s"}
        </div>
      ) : null}

      {/* Groups */}
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
      ) : tasks.length === 0 ? (
        <div className="mx-4 mt-2 rounded-[18px] p-8 text-center text-[13px]" style={{
          color: "#4D5E8A",
          border: "1px dashed rgba(99,130,255,0.10)",
        }}>
          Nenhum lembrete ainda. Toque em <span style={{ color: "#8B9CC8" }}>+</span> pra criar o primeiro.
        </div>
      ) : (
        <div className="px-4 flex flex-col gap-3">
          {groups
            .filter((g) => g.items.length > 0)
            .map((g, i) => (
              <ReminderGroupView
                key={g.key}
                group={g}
                collapsed={collapsed[g.key]}
                onToggle={() => toggleGroup(g.key)}
                onCheck={onCheck}
                style={animDelay(5 + i)}
              />
            ))}
        </div>
      )}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setNewOpen(true)}
        aria-label="Novo lembrete"
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

      <Sheet
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Novo lembrete"
        maxWidth="max-w-md"
      >
        <NewReminderForm
          onCancel={() => setNewOpen(false)}
          onCreated={async () => {
            setNewOpen(false);
            await load();
          }}
        />
      </Sheet>
    </div>
  );
}

interface PushBannerProps {
  push: ReturnType<typeof usePushSubscription>;
  onTest: () => void;
  testing: boolean;
  style?: React.CSSProperties;
}

function PushBanner({ push, onTest, testing, style }: PushBannerProps) {
  const isOn = push.status === "on";
  const isUnsupported = push.status === "unsupported";
  const isDenied = push.status === "denied";

  const tone: "on" | "off" | "blocked" = isOn ? "on" : isDenied ? "blocked" : "off";

  const toneStyle: Record<"on" | "off" | "blocked", React.CSSProperties> = {
    on: {
      background: "rgba(45,212,191,0.10)",
      border: "1px solid rgba(45,212,191,0.25)",
    },
    off: {
      background: "rgba(79,126,255,0.08)",
      border: "1px solid rgba(79,126,255,0.18)",
    },
    blocked: {
      background: "rgba(245,166,35,0.12)",
      border: "1px solid rgba(245,166,35,0.25)",
    },
  };

  const iconStyle =
    tone === "on"
      ? { background: "rgba(45,212,191,0.15)", color: "#2DD4BF" }
      : tone === "blocked"
        ? { background: "rgba(245,166,35,0.15)", color: "#F5A623" }
        : { background: "rgba(79,126,255,0.15)", color: "#7DA4FF" };

  const title =
    isOn ? "Notificações ativas"
    : isDenied ? "Permissão bloqueada"
    : isUnsupported ? "Push não suportado"
    : "Ativar notificações";

  const sub =
    isOn ? "Você receberá um push quando o lembrete vencer."
    : isDenied ? "Habilite nas configurações do navegador pra continuar."
    : isUnsupported ? "Use Chrome, Firefox ou Safari (iOS 16.4+) instalado como PWA."
    : "Permita pra ser avisado quando o lembrete vencer.";

  return (
    <section
      className="mx-4 mb-3.5 px-4 py-3 rounded-[12px] flex items-center gap-3 screen-item"
      style={{ ...style, ...toneStyle[tone] }}
    >
      <span
        className="h-9 w-9 rounded-[10px] grid place-items-center shrink-0"
        style={iconStyle}
      >
        {isOn ? <Bell className="h-4 w-4" strokeWidth={2.2} /> : <BellOff className="h-4 w-4" strokeWidth={2.2} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-semibold text-[#EEF2FF]">{title}</div>
        <div className="text-[10px] mt-0.5" style={{ color: "#8B9CC8" }}>
          {push.error ? push.error : sub}
        </div>
      </div>
      {isOn ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onTest}
            disabled={testing}
            aria-label="Enviar push de teste"
            className="grid place-items-center h-9 w-9 rounded-lg text-[#2DD4BF] disabled:opacity-50"
            style={{ background: "rgba(45,212,191,0.15)" }}
            title="Enviar push de teste"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" strokeWidth={2.2} />}
          </button>
          <button
            type="button"
            onClick={() => void push.disable()}
            className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[#8B9CC8]"
            style={{ background: "rgba(255,255,255,0.05)" }}
          >
            Desativar
          </button>
        </div>
      ) : isUnsupported || isDenied ? null : (
        <button
          type="button"
          onClick={() => void push.enable()}
          disabled={push.status === "checking"}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50"
          style={{ background: "#4F7EFF", boxShadow: "0 0 12px rgba(79,126,255,0.4)" }}
        >
          {push.status === "checking" ? "…" : "Ativar"}
        </button>
      )}
    </section>
  );
}

function SnapCell({ label, value, color }: { label: string; value: number; color: string }) {
  const animated = useCountUp(value, 850, value);
  return (
    <div
      className="text-center py-3 px-2 rounded-[12px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]"
    >
      <div
        className="text-[9px] font-bold tracking-[0.1em] uppercase mb-1"
        style={{ color: "#4D5E8A" }}
      >
        {label}
      </div>
      <div
        className="font-display text-[18px] font-bold leading-none tracking-tight"
        style={{ color }}
      >
        {animated}
      </div>
    </div>
  );
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
      <svg width={80} height={80} viewBox="0 0 80 80" style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
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

function Chip({ kind, children }: { kind: "red" | "blue" | "green" | "amber"; children: React.ReactNode }) {
  const styles: Record<typeof kind, React.CSSProperties> = {
    red: { background: "rgba(255,91,114,0.12)", color: "#FF5B72", border: "1px solid rgba(255,91,114,0.2)" },
    blue: { background: "rgba(79,126,255,0.15)", color: "#7DA4FF", border: "1px solid rgba(79,126,255,0.2)" },
    green: { background: "rgba(45,212,191,0.12)", color: "#2DD4BF", border: "1px solid rgba(45,212,191,0.2)" },
    amber: { background: "rgba(245,166,35,0.15)", color: "#F5A623", border: "1px solid rgba(245,166,35,0.2)" },
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

const GROUP_LABEL_COLOR: Record<GroupKey, string> = {
  expired: "#FF5B72",
  today: "#7DA4FF",
  upcoming: "#4D5E8A",
  recurring: "#7DA4FF",
  done: "#2DD4BF",
};
const GROUP_COUNT_BG: Record<GroupKey, React.CSSProperties> = {
  expired: { background: "rgba(255,91,114,0.12)", color: "#FF5B72" },
  today: { background: "rgba(79,126,255,0.15)", color: "#7DA4FF" },
  upcoming: { background: "#111B38", color: "#4D5E8A" },
  recurring: { background: "rgba(79,126,255,0.15)", color: "#7DA4FF" },
  done: { background: "rgba(45,212,191,0.12)", color: "#2DD4BF" },
};
const GROUP_BORDER_LEFT: Record<GroupKey, string | undefined> = {
  expired: "3px solid #FF5B72",
  today: "3px solid #7DA4FF",
  upcoming: undefined,
  recurring: "3px solid #4F7EFF",
  done: "3px solid #2DD4BF",
};

function ReminderGroupView({
  group,
  collapsed,
  onToggle,
  onCheck,
  style,
}: {
  group: ReminderGroup;
  collapsed: boolean;
  onToggle: () => void;
  onCheck: (t: Task) => void;
  style?: React.CSSProperties;
}) {
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
      {!collapsed ? (
        <div
          className="rounded-[16px] overflow-hidden bg-[#0C1228] border border-[rgba(99,130,255,0.10)]"
          style={{ borderLeft: GROUP_BORDER_LEFT[group.key] }}
        >
          {group.items.map((t, i) => (
            <ReminderItem
              key={t.id}
              task={t}
              groupKey={group.key}
              isLast={i === group.items.length - 1}
              onCheck={() => onCheck(t)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReminderItem({
  task,
  groupKey,
  isLast,
  onCheck,
}: {
  task: Task;
  groupKey: GroupKey;
  isLast: boolean;
  onCheck: () => void;
}) {
  const isDone = task.status === "completed";
  const isExpired = groupKey === "expired";
  const isRecurring = groupKey === "recurring";
  const checkBorder = isDone ? "#2DD4BF" : isExpired ? "#FF5B72" : "#F5A623";
  const checkBg = isDone ? "#2DD4BF" : "transparent";

  const tags = task.tags ?? [];
  const firstTag = tags[0] ?? null;

  return (
    <div
      className="flex items-center gap-3 px-3.5 py-3 cursor-pointer transition-colors hover:bg-[#111B38]"
      style={!isLast ? { borderBottom: "1px solid rgba(99,130,255,0.10)" } : undefined}
    >
      <button
        type="button"
        onClick={onCheck}
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
        <div
          className="text-[13px] font-medium truncate mb-0.5"
          style={{
            color: isDone ? "#4D5E8A" : "#EEF2FF",
            textDecoration: isDone ? "line-through" : undefined,
          }}
        >
          {task.title}
        </div>
        <div
          className="flex items-center gap-1.5 text-[10px]"
          style={{ color: isExpired ? "rgba(255,91,114,0.85)" : "#4D5E8A" }}
        >
          {isRecurring ? (
            <>
              <Repeat className="h-2.5 w-2.5" strokeWidth={2.2} />
              {task.due_time ? `Recorrente · ${task.due_time}` : "Recorrente"}
            </>
          ) : task.due_date ? (
            <>
              {isExpired ? <Clock className="h-2.5 w-2.5" strokeWidth={2.2} /> : <Calendar className="h-2.5 w-2.5" strokeWidth={2.2} />}
              {task.due_time ? `${task.due_time} · ` : ""}{dateAbbr(task.due_date)}
            </>
          ) : (
            "Sem data definida"
          )}
        </div>
      </div>
      {firstTag ? (
        <TagBadge kind={isRecurring ? "blue" : "amber"}>{firstTag}</TagBadge>
      ) : isRecurring ? (
        <TagBadge kind="blue">Recorrente</TagBadge>
      ) : null}
    </div>
  );
}

function TagBadge({ kind, children }: { kind: "amber" | "blue"; children: React.ReactNode }) {
  const styles: React.CSSProperties =
    kind === "amber"
      ? { background: "rgba(245,166,35,0.15)", color: "#F5A623", border: "1px solid rgba(245,166,35,0.2)" }
      : { background: "rgba(79,126,255,0.15)", color: "#7DA4FF", border: "1px solid rgba(79,126,255,0.2)" };
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-[0.04em] px-1.5 py-[2px] rounded-full shrink-0"
      style={styles}
    >
      {children}
    </span>
  );
}

interface NewReminderFormProps {
  onCancel: () => void;
  onCreated: () => Promise<void> | void;
}

function NewReminderForm({ onCancel, onCreated }: NewReminderFormProps) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState(() => isoLocal(new Date()));
  const [dueTime, setDueTime] = useState("09:00");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await tasksApi.createTask({
        type: "reminder",
        title: title.trim(),
        source: "web",
        payload: {},
        due_date: dueDate || null,
        due_time: dueTime || null,
        tags: tag.trim() ? [tag.trim()] : undefined,
      });
      await onCreated();
    } catch {
      setErr("Falha ao criar lembrete");
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
          O quê
        </span>
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex.: Tomar remédio"
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

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Tag (opcional)
        </span>
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Ex.: Saúde"
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={inputStyle}
        />
      </label>

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
