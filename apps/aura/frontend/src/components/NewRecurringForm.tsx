import { useState, type FormEvent } from "react";
import { RemindersPicker } from "./RemindersPicker";
import { createRecurring, type CreateRecurringBody } from "../api/recurring";
import { useAuth } from "../auth/AuthContext";

const WEEKDAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

type Frequency = "daily" | "weekly" | "monthly";

interface Props {
  onCancel: () => void;
  onCreated: () => Promise<void> | void;
}

const inputStyle: React.CSSProperties = {
  background: "rgba(17,27,56,0.6)",
  border: "1px solid rgba(99,130,255,0.10)",
  color: "#EEF2FF",
};

export function NewRecurringForm({ onCancel, onCreated }: Props) {
  const { user } = useAuth();
  const defaults = user?.default_reminder_offsets ?? [];

  const [title, setTitle] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [weekday, setWeekday] = useState<number | null>(null);
  const [dayOfMonth, setDayOfMonth] = useState<string>("");
  const [time, setTime] = useState("");
  const [description, setDescription] = useState("");

  const [touched, setTouched] = useState(false);
  const [reminderOffsets, setReminderOffsets] = useState<number[]>(defaults);
  const effectiveOffsets = touched ? reminderOffsets : defaults;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handlePickerChange = (next: number[]) => {
    setTouched(true);
    setReminderOffsets(next);
  };

  const validate = (): string | null => {
    if (!title.trim()) return "Informe um título";
    if (frequency === "weekly" && weekday === null) return "Selecione o dia da semana";
    if (frequency === "monthly") {
      const n = parseInt(dayOfMonth, 10);
      if (!Number.isFinite(n) || n < 1 || n > 31) return "Dia do mês deve ser entre 1 e 31";
    }
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: CreateRecurringBody = {
        title: title.trim(),
        frequency,
        weekday: frequency === "weekly" ? weekday : null,
        day_of_month: frequency === "monthly" ? parseInt(dayOfMonth, 10) : null,
        time: time || null,
        description: description.trim() || null,
        // Only send offsets if user touched the picker AND time is set
        // (offsets are pointless without a time-of-day anchor).
        reminder_offsets: time && touched ? reminderOffsets : undefined,
      };
      await createRecurring(body);
      await onCreated();
    } catch {
      setErr("Falha ao criar regra");
    } finally {
      setBusy(false);
    }
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
          placeholder="Ex.: Tomar remédio"
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={inputStyle}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Frequência
        </span>
        <div
          className="flex p-[3px] gap-[2px] rounded-[10px]"
          style={{ background: "#0C1228", border: "1px solid rgba(99,130,255,0.10)" }}
        >
          <FreqTab active={frequency === "daily"} onClick={() => setFrequency("daily")}>Diário</FreqTab>
          <FreqTab active={frequency === "weekly"} onClick={() => setFrequency("weekly")}>Semanal</FreqTab>
          <FreqTab active={frequency === "monthly"} onClick={() => setFrequency("monthly")}>Mensal</FreqTab>
        </div>
      </div>

      {frequency === "weekly" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Dia da semana
          </span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_LABELS.map((label, idx) => {
              const isOn = weekday === idx;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setWeekday(idx)}
                  className={[
                    "px-2.5 py-1 rounded-full text-xs ring-1 transition-colors",
                    isOn
                      ? "bg-accent-purple/20 text-accent-purple ring-accent-purple/40"
                      : "bg-white/5 text-ink-dim ring-white/10 hover:bg-white/10",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {frequency === "monthly" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Dia do mês
          </span>
          <input
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(e.target.value)}
            placeholder="1-31"
            className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
            style={inputStyle}
          />
        </label>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Horário
        </span>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
          style={inputStyle}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Descrição
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Opcional"
          rows={3}
          className="rounded-lg px-3.5 py-2.5 placeholder:text-[#4D5E8A] focus:outline-none resize-none"
          style={inputStyle}
        />
      </label>

      {time ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
            Lembretes extras
          </span>
          <RemindersPicker
            value={effectiveOffsets}
            onChange={handlePickerChange}
          />
          {!touched && defaults.length > 0 ? (
            <span className="text-[10px]" style={{ color: "#4D5E8A" }}>
              Pré-selecionados do seu perfil — toque para alterar.
            </span>
          ) : null}
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

function FreqTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 px-3 py-1.5 rounded-[7px] text-[11px] font-medium tracking-[0.02em] whitespace-nowrap transition-colors"
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
