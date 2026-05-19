/**
 * Multi-offset reminder picker. Toggleable preset chips + free
 * minute-integer input. Selected offsets are rendered as removable
 * badges. Always reports the user-chosen set (without auto-inserting
 * 0); the backend materializes `sorted(set([0] + offsets))` on submit.
 *
 * The "Na hora" chip maps to 0, which the user can include explicitly
 * if they want the badge to show. When they don't include it, the
 * backend still fires at due time anyway — same UX, less ceremony.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { Bell, X, Plus } from "lucide-react";

interface Preset {
  minutes: number;
  label: string;
}

const PRESETS: Preset[] = [
  { minutes: 0, label: "Na hora" },
  { minutes: 5, label: "5 min antes" },
  { minutes: 15, label: "15 min antes" },
  { minutes: 30, label: "30 min antes" },
  { minutes: 60, label: "1 h antes" },
  { minutes: 1440, label: "1 dia antes" },
];

const MAX_OFFSET_MINUTES = 60 * 24 * 30;

function fmt(offset: number): string {
  if (offset <= 0) return "Na hora";
  if (offset % 1440 === 0) {
    const d = offset / 1440;
    return d === 1 ? "1 dia antes" : `${d} dias antes`;
  }
  if (offset % 60 === 0) {
    const h = offset / 60;
    return h === 1 ? "1 h antes" : `${h} h antes`;
  }
  return `${offset} min antes`;
}

export interface Props {
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}

export function RemindersPicker({ value, onChange, disabled }: Props) {
  const [draft, setDraft] = useState("");
  const selected = useMemo(() => new Set(value), [value]);

  const toggle = (mins: number) => {
    if (disabled) return;
    const next = selected.has(mins)
      ? value.filter((v) => v !== mins)
      : [...value, mins].sort((a, b) => a - b);
    onChange(next);
  };

  const addDraft = () => {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n) || n < 0 || n > MAX_OFFSET_MINUTES) {
      setDraft("");
      return;
    }
    if (!selected.has(n)) {
      onChange([...value, n].sort((a, b) => a - b));
    }
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDraft();
    }
  };

  const remove = (mins: number) => {
    if (disabled) return;
    onChange(value.filter((v) => v !== mins));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const isOn = selected.has(p.minutes);
          return (
            <button
              key={p.minutes}
              type="button"
              disabled={disabled}
              onClick={() => toggle(p.minutes)}
              className={[
                "px-2.5 py-1 rounded-full text-xs ring-1 transition-colors",
                isOn
                  ? "bg-accent-purple/20 text-accent-purple ring-accent-purple/40"
                  : "bg-white/5 text-ink-dim ring-white/10 hover:bg-white/10",
                disabled ? "opacity-50 cursor-not-allowed" : "",
              ].join(" ")}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_OFFSET_MINUTES}
          step={1}
          placeholder="outros (min)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
          className="w-32 px-2 py-1 text-sm rounded-md bg-bg-elevated border border-white/10 text-ink-primary placeholder:text-ink-faint focus:outline-none focus:border-accent-purple/40"
        />
        <button
          type="button"
          onClick={addDraft}
          disabled={disabled || !draft}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-white/5 text-ink-primary hover:bg-white/10 disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          Adicionar
        </button>
      </div>

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((mins) => (
            <span
              key={mins}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 text-xs ring-1 ring-cyan-500/30"
            >
              <Bell className="h-3 w-3" />
              {fmt(mins)}
              <button
                type="button"
                onClick={() => remove(mins)}
                disabled={disabled}
                aria-label={`Remover ${fmt(mins)}`}
                className="hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-ink-faint">
          Nenhum lembrete extra. O sistema dispara na hora exata por padrão.
        </div>
      )}
    </div>
  );
}
