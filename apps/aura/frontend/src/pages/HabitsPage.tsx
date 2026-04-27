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
  Flame,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import * as habitsApi from "../api/habits";
import type { Habit, HabitsToday } from "../api/habits";
import { ApiError } from "../api/client";
import { Sheet } from "../components/Sheet";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";

const COLOR_CHOICES: Array<{ key: string; hex: string; label: string }> = [
  { key: "emerald", hex: "#2DD4BF", label: "Verde" },
  { key: "blue", hex: "#7DA4FF", label: "Azul" },
  { key: "violet", hex: "#A78BFA", label: "Violeta" },
  { key: "amber", hex: "#F5A623", label: "Âmbar" },
  { key: "rose", hex: "#F472B6", label: "Rosa" },
  { key: "teal", hex: "#2DD4BF", label: "Teal" },
];

const DAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const HEATMAP_COLS = 26;
const HEATMAP_ROWS = 7;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function colorHex(color: string): string {
  return COLOR_CHOICES.find((c) => c.key === color)?.hex ?? "#2DD4BF";
}

/** Build heatmap window: 26 weeks back, anchored at today's column.
 *  Returns column-major flat array of {iso, count, future}. */
function buildHeatmapCells(
  values: Record<string, number>,
  today: Date,
): Array<{ iso: string; count: number; future: boolean }> {
  // Anchor: today is the bottom-right (Sunday column or current weekday).
  // Build last 26 weeks ending at the week of today (Mon-Sun).
  const todayIso = isoLocal(today);
  // Start of the leftmost week (26 weeks back, Monday)
  const dayOfWeek = (today.getDay() + 6) % 7; // Mon=0
  const start = new Date(today);
  start.setDate(today.getDate() - dayOfWeek - (HEATMAP_COLS - 1) * 7);

  const cells: Array<{ iso: string; count: number; future: boolean }> = [];
  for (let col = 0; col < HEATMAP_COLS; col++) {
    for (let row = 0; row < HEATMAP_ROWS; row++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + col * 7 + row);
      const iso = isoLocal(cur);
      cells.push({
        iso,
        count: values[iso] ?? 0,
        future: iso > todayIso,
      });
    }
  }
  return cells;
}

/** Map count → level 0..4 based on a max */
function intensityLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio >= 0.8) return 4;
  if (ratio >= 0.55) return 3;
  if (ratio >= 0.3) return 2;
  return 1;
}

const LEVEL_BG = [
  "rgba(79,126,255,0.06)",
  "rgba(79,126,255,0.18)",
  "rgba(79,126,255,0.36)",
  "rgba(79,126,255,0.6)",
  "#4F7EFF",
] as const;

export function HabitsPage() {
  const [data, setData] = useState<HabitsToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetMode, setSheetMode] = useState<"closed" | "list" | "new">("closed");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await habitsApi.getToday();
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao carregar hábitos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  const onToggle = useCallback(
    async (habit: Habit) => {
      setData((prev) => {
        if (!prev) return prev;
        const newDone = !habit.done_today;
        const ringDelta = newDone ? 1 : -1;
        return {
          ...prev,
          ring: { ...prev.ring, done: prev.ring.done + ringDelta },
          habits: prev.habits.map((h) =>
            h.id === habit.id
              ? { ...h, done_today: newDone, week_done_count: h.week_done_count + ringDelta }
              : h,
          ),
        };
      });
      try {
        await habitsApi.toggleHabit(habit.id);
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(10);
      } catch {
        await load();
      }
    },
    [load],
  );

  const onDelete = useCallback(
    async (habit: Habit) => {
      if (!confirm(`Excluir "${habit.name}"?`)) return;
      setData((prev) =>
        prev ? { ...prev, habits: prev.habits.filter((h) => h.id !== habit.id) } : prev,
      );
      try {
        await habitsApi.deleteHabit(habit.id);
      } catch {
        await load();
      }
    },
    [load],
  );

  const today = useMemo(() => new Date(), []);
  const totalHabits = data?.habits.length ?? 0;
  const doneToday = data?.habits.filter((h) => h.done_today).length ?? 0;
  const weekDone = data?.ring.done ?? 0;
  const weekTarget = data?.ring.target ?? 0;
  const monthlyRatePct = weekTarget > 0 ? Math.round((weekDone / weekTarget) * 100) : 0;
  const totalMarks = useMemo(
    () => Object.values(data?.heatmap ?? {}).reduce((a, b) => a + b, 0),
    [data?.heatmap],
  );

  const heatmapCells = useMemo(
    () => buildHeatmapCells(data?.heatmap ?? {}, today),
    [data?.heatmap, today],
  );
  const heatmapMax = Math.max(2, totalHabits);

  // Trend pill: this week vs target
  const trendPct = weekTarget > 0 ? Math.round((weekDone / weekTarget) * 100) - 100 : 0;
  const trendKind: "amber" | "green" | "red" =
    trendPct >= 0 ? "green" : trendPct >= -25 ? "amber" : "red";

  // Heading text by progress
  const heroTitle =
    weekTarget === 0
      ? "Início"
      : weekDone >= weekTarget
        ? "Meta semanal batida"
        : weekDone === 0
          ? "Comece hoje"
          : "Em construção";
  const heroDesc =
    weekTarget === 0
      ? "Crie seu primeiro hábito para começar a contagem."
      : weekDone >= weekTarget
        ? "Você bateu a meta — ritmo perfeito pra próxima semana."
        : `${weekTarget - weekDone} marcação(ões) restante(s) na semana.`;

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5">
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Hábitos
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

      {/* Hero — ring + info */}
      <section
        className="mx-4 mb-3.5 p-4 rounded-[20px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] flex items-center gap-4"
      >
        <RingSm value={weekDone} max={weekTarget || 1} color="pink" centerLabel={String(weekDone)} centerSub="PTS" />
        <div className="flex-1 min-w-0">
          <div className="font-display text-[14px] font-semibold tracking-tight text-[#EEF2FF] mb-1">
            {heroTitle}
          </div>
          <div className="text-[11px] leading-snug text-[#8B9CC8] mb-2">
            {heroDesc}
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-[11px]" style={{ color: "#4D5E8A" }}>
              {doneToday} de {totalHabits} hoje
            </span>
            <TrendPill kind={trendKind} pct={trendPct} />
          </div>
        </div>
      </section>

      {/* Chart card */}
      <section
        className="mx-4 mb-3.5 px-4 py-3.5 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]"
      >
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[11px] font-semibold tracking-[0.04em] uppercase" style={{ color: "#8B9CC8" }}>
            Consistência — {MONTHS_PT[today.getMonth()]}
          </span>
          <span className="text-[10px]" style={{ color: "#4D5E8A" }}>
            {weekDone} de {weekTarget || "—"}
          </span>
        </div>
        <ConsistencyChart values={data?.heatmap ?? {}} today={today} />
        <div className="flex justify-between pt-1.5 font-mono text-[9px]" style={{ color: "#4D5E8A" }}>
          <span>01</span>
          <span>08</span>
          <span>15</span>
          <span>22</span>
          <span>29</span>
        </div>
      </section>

      {/* Pills row */}
      <div className="flex gap-1.5 px-4 mb-3.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <PillBtn>Hoje {doneToday}/{totalHabits}</PillBtn>
        <PillBtn active>Taxa mensal {monthlyRatePct}%</PillBtn>
        <PillBtn>
          <Calendar className="h-3 w-3" strokeWidth={2.2} />
          Calendário
        </PillBtn>
      </div>

      {/* Heatmap */}
      <section
        className="mx-4 mb-3.5 p-4 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-[13px] font-semibold tracking-tight text-[#EEF2FF]">
            Mapa de Consistência
          </h3>
          <span className="text-[10px]" style={{ color: "#4D5E8A" }}>
            26 sem · {totalMarks} marcas
          </span>
        </div>
        <div className="flex gap-2.5">
          <div className="flex flex-col gap-[2px]">
            {DAY_LABELS.map((d, i) => (
              <span
                key={i}
                className="text-[8px] tracking-[0.05em]"
                style={{
                  color: "#4D5E8A",
                  height: 10,
                  lineHeight: "10px",
                  visibility: i % 2 === 0 ? "visible" : "hidden",
                }}
              >
                {d}
              </span>
            ))}
          </div>
          <div
            className="grid gap-[2px] flex-1 overflow-x-auto"
            style={{
              gridTemplateRows: `repeat(${HEATMAP_ROWS}, 10px)`,
              gridAutoFlow: "column",
              gridAutoColumns: "10px",
              minWidth: 0,
            }}
          >
            {heatmapCells.map((cell, i) => {
              const lvl = cell.future ? 0 : intensityLevel(cell.count, heatmapMax);
              const bg = cell.future ? "rgba(79,126,255,0.03)" : LEVEL_BG[lvl];
              const glow = lvl === 4 ? "0 0 4px rgba(79,126,255,0.5)" : undefined;
              return (
                <div
                  key={i}
                  title={`${cell.iso} — ${cell.count}`}
                  className="rounded-[2px]"
                  style={{
                    width: 10,
                    height: 10,
                    background: bg,
                    boxShadow: glow,
                  }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-2.5 text-[9px]" style={{ color: "#4D5E8A" }}>
          <span>0%</span>
          <div className="flex gap-[2px]">
            {LEVEL_BG.map((bg, i) => (
              <div
                key={i}
                className="rounded-[2px]"
                style={{
                  width: 8,
                  height: 8,
                  background: bg,
                  boxShadow: i === 4 ? "0 0 4px rgba(79,126,255,0.5)" : undefined,
                }}
              />
            ))}
          </div>
          <span>100%</span>
        </div>
      </section>

      {error ? (
        <div className="mx-4 px-3 py-2 rounded-lg text-[11px]" style={{
          background: "rgba(255,91,114,0.12)",
          border: "1px solid rgba(255,91,114,0.2)",
          color: "#FF5B72",
        }}>
          {error}
        </div>
      ) : null}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setSheetMode("list")}
        aria-label="Gerenciar hábitos"
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
        open={sheetMode !== "closed"}
        onClose={() => setSheetMode("closed")}
        title={sheetMode === "new" ? "Novo hábito" : "Hábitos"}
        maxWidth="max-w-md"
      >
        {sheetMode === "list" ? (
          <HabitsList
            habits={data?.habits ?? []}
            loading={loading && !data}
            onToggle={onToggle}
            onDelete={onDelete}
            onAdd={() => setSheetMode("new")}
          />
        ) : sheetMode === "new" ? (
          <NewHabitForm
            busy={busy}
            onCancel={() => setSheetMode("list")}
            onCreate={async (body) => {
              setBusy(true);
              try {
                await habitsApi.createHabit(body);
                await load();
                setSheetMode("list");
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

interface RingSmProps {
  value: number;
  max: number;
  color: "pink" | "blue" | "green" | "amber" | "red";
  centerLabel: string;
  centerSub: string;
}

function RingSm({ value, max, color, centerLabel, centerSub }: RingSmProps) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const offset = c * (1 - ratio);
  const colorHex =
    color === "pink"
      ? "#F472B6"
      : color === "blue"
        ? "#4F7EFF"
        : color === "green"
          ? "#2DD4BF"
          : color === "amber"
            ? "#F5A623"
            : "#FF5B72";
  const glow =
    color === "pink"
      ? "rgba(244,114,182,0.5)"
      : color === "blue"
        ? "rgba(79,126,255,0.5)"
        : color === "green"
          ? "rgba(45,212,191,0.5)"
          : color === "amber"
            ? "rgba(245,166,35,0.5)"
            : "rgba(255,91,114,0.5)";
  return (
    <div className="relative shrink-0" style={{ width: 70, height: 70 }}>
      <svg
        width={70}
        height={70}
        viewBox="0 0 70 70"
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        <circle cx={35} cy={35} r={r} fill="none" stroke="#162040" strokeWidth={6} />
        <circle
          cx={35}
          cy={35}
          r={r}
          fill="none"
          stroke={colorHex}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{
            transition: "stroke-dashoffset 0.6s cubic-bezier(0.2,0.9,0.3,1)",
            filter: `drop-shadow(0 0 6px ${glow})`,
          }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="font-display text-[16px] font-bold leading-none tracking-tight text-[#EEF2FF]">
            {centerLabel}
          </div>
          <div
            className="text-[8px] mt-0.5 uppercase tracking-[0.1em]"
            style={{ color: "#4D5E8A" }}
          >
            {centerSub}
          </div>
        </div>
      </div>
    </div>
  );
}

interface TrendPillProps {
  kind: "amber" | "green" | "red";
  pct: number;
}

function TrendPill({ kind, pct }: TrendPillProps) {
  const style =
    kind === "amber"
      ? { background: "rgba(245,166,35,0.15)", color: "#F5A623" }
      : kind === "green"
        ? { background: "rgba(45,212,191,0.12)", color: "#2DD4BF" }
        : { background: "rgba(255,91,114,0.12)", color: "#FF5B72" };
  const arrow = pct >= 0 ? "↑" : "↓";
  return (
    <span
      className="text-[10px] font-bold px-2 py-0.5 rounded-full"
      style={style}
    >
      {arrow} {Math.abs(pct)}% vs semana anterior
    </span>
  );
}

function PillBtn({
  children,
  active = false,
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[11px] font-medium tracking-[0.02em] whitespace-nowrap shrink-0 transition-colors"
      style={
        active
          ? {
              background: "rgba(79,126,255,0.15)",
              border: "1px solid rgba(79,126,255,0.3)",
              color: "#7DA4FF",
            }
          : {
              background: "transparent",
              border: "1px solid rgba(99,130,255,0.10)",
              color: "#4D5E8A",
            }
      }
    >
      {children}
    </button>
  );
}

interface ConsistencyChartProps {
  values: Record<string, number>;
  today: Date;
}

function ConsistencyChart({ values, today }: ConsistencyChartProps) {
  // Build the last 30 days as data points; X scaled across viewBox 0..320
  const points = useMemo(() => {
    const days = 30;
    const pts: Array<{ x: number; y: number; count: number }> = [];
    let max = 1;
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - (days - 1 - i));
      const iso = isoLocal(d);
      const c = values[iso] ?? 0;
      if (c > max) max = c;
      pts.push({ x: (i / (days - 1)) * 320, y: 0, count: c });
    }
    // Y: invert (chart Y grows downwards in SVG; 0 = top, 100 = bottom)
    // Usable range: 18 (top) → 90 (bottom)
    for (const p of pts) {
      const ratio = max > 0 ? p.count / max : 0;
      p.y = 90 - ratio * 72;
    }
    return pts;
  }, [values, today]);

  if (points.length < 2) return <div style={{ height: 100 }} />;

  const linePath =
    "M" +
    points
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" L");

  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},100 L${points[0].x.toFixed(1)},100 Z`;
  const last = points[points.length - 1];

  return (
    <div style={{ width: "100%", height: 100, position: "relative" }}>
      <svg viewBox="0 0 320 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
        <defs>
          <linearGradient id="habArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4F7EFF" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#4F7EFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#habArea)" />
        <path
          d={linePath}
          stroke="#4F7EFF"
          strokeWidth={2}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={last.x} cy={last.y} r={3} fill="#7DA4FF" />
      </svg>
    </div>
  );
}

interface HabitsListProps {
  habits: Habit[];
  loading: boolean;
  onToggle: (h: Habit) => void;
  onDelete: (h: Habit) => void;
  onAdd: () => void;
}

function HabitsList({ habits, loading, onToggle, onDelete, onAdd }: HabitsListProps) {
  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 min-h-11 rounded-lg text-[13px] font-medium text-white transition-colors"
        style={{
          background: "#4F7EFF",
          boxShadow: "0 4px 20px rgba(79,126,255,0.5), 0 0 0 1px rgba(79,126,255,0.3)",
        }}
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
        Novo hábito
      </button>

      {loading ? (
        <div className="grid place-items-center py-10" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : habits.length === 0 ? (
        <div
          className="rounded-[14px] p-8 text-center text-[13px]"
          style={{ color: "#4D5E8A", border: "1px dashed rgba(99,130,255,0.10)" }}
        >
          Nenhum hábito ainda. Toque em <span style={{ color: "#8B9CC8" }}>Novo hábito</span> pra começar.
        </div>
      ) : (
        <ul className="flex flex-col">
          {habits.map((h) => (
            <li
              key={h.id}
              className="flex items-center gap-3 py-3 border-t border-[rgba(99,130,255,0.10)] first:border-t-0"
            >
              <button
                type="button"
                onClick={() => onToggle(h)}
                aria-pressed={h.done_today}
                className="h-9 w-9 rounded-full grid place-items-center transition-all shrink-0"
                style={
                  h.done_today
                    ? {
                        background: colorHex(h.color),
                        color: "#06091A",
                        boxShadow: `0 0 12px ${colorHex(h.color)}55`,
                      }
                    : {
                        border: "1px solid rgba(255,255,255,0.15)",
                        color: "transparent",
                      }
                }
              >
                <Check className="h-4 w-4" strokeWidth={3} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[#EEF2FF] truncate">{h.name}</div>
                <div className="text-[10px] mt-0.5 flex items-center gap-2" style={{ color: "#4D5E8A" }}>
                  <span>
                    {h.week_done_count}/{h.target_per_week} esta semana
                  </span>
                  {h.streak > 0 ? (
                    <span className="inline-flex items-center gap-1" style={{ color: "#F5A623" }}>
                      <Flame className="h-3 w-3" />
                      {h.streak}
                    </span>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDelete(h)}
                aria-label="Excluir"
                className="grid place-items-center h-9 w-9 rounded-lg transition-colors"
                style={{ color: "#4D5E8A" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "#FF5B72")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "#4D5E8A")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface NewHabitFormProps {
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: habitsApi.CreateHabitBody) => Promise<void> | void;
}

function NewHabitForm({ busy, onCancel, onCreate }: NewHabitFormProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("emerald");
  const [target, setTarget] = useState(7);
  const canSubmit = name.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    void onCreate({ name: name.trim(), color, target_per_week: target });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Nome
        </span>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Caminhar 20 min"
          className="rounded-lg px-3.5 py-2.5 min-h-11 text-[#EEF2FF] placeholder:text-[#4D5E8A] focus:outline-none"
          style={{
            background: "rgba(17,27,56,0.6)",
            border: "1px solid rgba(99,130,255,0.10)",
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = "#4F7EFF")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(99,130,255,0.10)")}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Cor
        </span>
        <div className="flex flex-wrap gap-2">
          {COLOR_CHOICES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setColor(c.key)}
              aria-label={c.label}
              className="h-9 w-9 rounded-full transition-all"
              style={{
                background: c.hex,
                opacity: color === c.key ? 1 : 0.65,
                transform: color === c.key ? "scale(1.1)" : undefined,
                boxShadow: color === c.key ? `0 0 0 2px #06091A, 0 0 0 4px ${c.hex}` : undefined,
              }}
            />
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Meta semanal — {target}× por semana
        </span>
        <input
          type="range"
          min={1}
          max={7}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          style={{ accentColor: "#4F7EFF" }}
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
          style={{
            background: "#4F7EFF",
            boxShadow: "0 4px 20px rgba(79,126,255,0.5)",
          }}
        >
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}
