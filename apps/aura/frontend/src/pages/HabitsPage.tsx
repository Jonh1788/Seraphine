import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check,
  ChevronLeft,
  Flame,
  HeartPulse,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import * as habitsApi from "../api/habits";
import type { Habit, HabitsToday } from "../api/habits";
import { ApiError } from "../api/client";
import { HealthRing } from "../components/HealthRing";
import { Heatmap } from "../components/Heatmap";
import { Sheet } from "../components/Sheet";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";

const COLOR_CHOICES: Array<{ key: string; class: string; label: string }> = [
  { key: "emerald", class: "bg-emerald-400", label: "Verde" },
  { key: "blue", class: "bg-accent-blue-soft", label: "Azul" },
  { key: "violet", class: "bg-violet-400", label: "Violeta" },
  { key: "amber", class: "bg-amber-300", label: "Âmbar" },
  { key: "rose", class: "bg-rose-300", label: "Rosa" },
  { key: "teal", class: "bg-teal-300", label: "Teal" },
];

function colorClass(color: string): string {
  const found = COLOR_CHOICES.find((c) => c.key === color);
  return found?.class ?? "bg-emerald-400";
}

export function HabitsPage() {
  const [data, setData] = useState<HabitsToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
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
      // Optimistic flip + adjust ring count.
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
        if (typeof navigator !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate(10);
        }
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

  return (
    <div className="flex flex-col gap-5 max-w-3xl mx-auto">
      <header className="flex items-center gap-3">
        <Link
          to="/mais"
          className="grid place-items-center h-10 w-10 -ml-2 rounded-lg text-ink-dim hover:text-ink-primary hover:bg-white/5"
          aria-label="Voltar"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="h-10 w-10 rounded-xl2 bg-mod-habits/15 text-mod-habits grid place-items-center">
          <HeartPulse className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="font-display text-2xl font-bold text-ink-primary leading-tight">
            Hábitos
          </h1>
          <p className="text-sm text-ink-dim">Pequenas vitórias diárias.</p>
        </div>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 min-h-10 rounded-lg bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base text-sm font-medium shadow-glow-blue"
        >
          <Plus className="h-4 w-4" />
          Novo
        </button>
      </header>

      <HeroRing data={data} loading={loading} error={error} />

      <section className="rounded-xl3 border border-white/8 bg-bg-s1/70 p-5 shadow-glass">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-sm font-semibold text-ink-primary">
            Atividade — últimos 6 meses
          </h2>
          <span className="text-xs text-ink-faint">
            {Object.values(data?.heatmap ?? {}).reduce((a, b) => a + b, 0)} marcações
          </span>
        </div>
        {data ? (
          <Heatmap
            values={data.heatmap}
            fromIso={data.heatmap_from}
            toIso={data.heatmap_to}
            maxPerDay={Math.max(2, data.habits.length)}
          />
        ) : (
          <div className="h-20 grid place-items-center text-ink-faint text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
      </section>

      <section className="rounded-xl3 border border-white/8 bg-bg-s1/70 shadow-glass overflow-hidden">
        <header className="px-5 py-3 border-b border-white/5">
          <h2 className="font-display text-sm font-semibold text-ink-primary">
            Hoje
          </h2>
        </header>
        {data && data.habits.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-faint">
            Nenhum hábito ainda. Toque em <span className="text-ink-dim">Novo</span> pra começar.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {(data?.habits ?? []).map((h) => (
              <HabitRow
                key={h.id}
                habit={h}
                onToggle={() => onToggle(h)}
                onDelete={() => onDelete(h)}
              />
            ))}
          </ul>
        )}
      </section>

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Novo hábito"
        maxWidth="max-w-md"
      >
        <NewHabitForm
          busy={busy}
          onCancel={() => setSheetOpen(false)}
          onCreate={async (body) => {
            setBusy(true);
            try {
              await habitsApi.createHabit(body);
              setSheetOpen(false);
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

function HeroRing({
  data,
  loading,
  error,
}: {
  data: HabitsToday | null;
  loading: boolean;
  error: string | null;
}) {
  const ratio = data?.ring.ratio ?? 0;
  const done = data?.ring.done ?? 0;
  const target = data?.ring.target ?? 0;
  return (
    <section className="rounded-xl3 border border-white/8 bg-bg-s1/70 p-5 shadow-glass flex items-center gap-5">
      <HealthRing
        ratio={ratio}
        size={120}
        stroke={12}
        colorClass="text-mod-habits"
      >
        <div className="text-center">
          <div className="font-mono text-xl font-semibold tabular-nums text-ink-primary">
            {done}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-ink-faint">
            de {target}
          </div>
        </div>
      </HealthRing>
      <div className="flex-1 min-w-0">
        <div className="text-xs uppercase tracking-wider text-ink-faint mb-1">
          Esta semana
        </div>
        <div className="font-display text-xl text-ink-primary font-semibold">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
          ) : error ? (
            <span className="text-red-300 text-sm">{error}</span>
          ) : ratio >= 1 ? (
            "Meta batida — manda ver na próxima."
          ) : ratio >= 0.6 ? (
            "Tá indo bem, segura o ritmo."
          ) : ratio > 0 ? (
            "Cada marcação conta."
          ) : (
            "Bora começar?"
          )}
        </div>
      </div>
    </section>
  );
}

interface HabitRowProps {
  habit: Habit;
  onToggle: () => void;
  onDelete: () => void;
}

function HabitRow({ habit, onToggle, onDelete }: HabitRowProps) {
  return (
    <li className="flex items-center gap-3 px-5 py-3.5">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={habit.done_today}
        className={[
          "h-9 w-9 rounded-full grid place-items-center transition-all shrink-0",
          habit.done_today
            ? `${colorClass(habit.color)} text-bg-base shadow-glow-blue`
            : "border border-white/15 text-transparent hover:border-white/35",
        ].join(" ")}
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ink-primary truncate">{habit.name}</div>
        <div className="text-xs text-ink-faint flex items-center gap-2 mt-0.5">
          <span>
            {habit.week_done_count}/{habit.target_per_week} esta semana
          </span>
          {habit.streak > 0 ? (
            <span className="inline-flex items-center gap-1 text-amber-300">
              <Flame className="h-3 w-3" />
              {habit.streak}
            </span>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Excluir"
        className="grid place-items-center h-9 w-9 rounded-lg text-ink-faint hover:text-red-300 hover:bg-white/5"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
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
  const canSubmit = useMemo(() => name.trim().length > 0, [name]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    void onCreate({ name: name.trim(), color, target_per_week: target });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Nome
        </span>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Caminhar 20 min"
          className="rounded-lg border border-white/10 bg-bg-s2/60 px-3.5 py-2.5 min-h-11 text-ink-primary placeholder:text-ink-faint focus:border-accent-blue focus:outline-none"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Cor
        </span>
        <div className="flex flex-wrap gap-2">
          {COLOR_CHOICES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setColor(c.key)}
              aria-label={c.label}
              className={[
                "h-9 w-9 rounded-full grid place-items-center transition-all",
                c.class,
                color === c.key
                  ? "ring-2 ring-offset-2 ring-offset-bg-s2 ring-accent-blue scale-110"
                  : "opacity-70 hover:opacity-100",
              ].join(" ")}
            />
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Meta semanal — {target}× por semana
        </span>
        <input
          type="range"
          min={1}
          max={7}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          className="accent-accent-blue"
        />
      </label>

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg bg-white/5 text-ink-primary hover:bg-white/10"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canSubmit || busy}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base font-medium shadow-glow-blue disabled:opacity-50"
        >
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}
