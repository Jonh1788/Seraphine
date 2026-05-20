import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Sheet } from "./Sheet";
import { RemindersPicker } from "./RemindersPicker";
import {
  listRecurring,
  updateRecurring,
  deleteRecurring,
  type InlineRecurring,
} from "../api/recurring";
import { useAuth } from "../auth/AuthContext";

const WEEKDAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

type UpdateBody = Parameters<typeof updateRecurring>[1];

interface Props {
  ruleId: string | null;
  onClose: () => void;
  onChanged?: () => Promise<void> | void;
  onDeleted?: () => Promise<void> | void;
}

const inputStyle: React.CSSProperties = {
  background: "rgba(17,27,56,0.6)",
  border: "1px solid rgba(99,130,255,0.10)",
  color: "#EEF2FF",
};

export function EditRecurringSheet({ ruleId, onClose, onChanged, onDeleted }: Props) {
  const { user } = useAuth();
  const defaults = user?.default_reminder_offsets ?? [];

  const [rule, setRule] = useState<InlineRecurring | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Tracks whether the user touched the reminder picker since opening.
  // Until they do, we show effective-current (per-rule override OR user
  // defaults) but DON'T send anything until they actually edit it.
  const [offsetsTouched, setOffsetsTouched] = useState(false);
  const [offsetsDraft, setOffsetsDraft] = useState<number[]>([]);

  const pendingRef = useRef<UpdateBody>({});
  const timerRef = useRef<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);
  const currentIdRef = useRef<string | null>(ruleId);
  currentIdRef.current = ruleId;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = useCallback(async () => {
    const id = currentIdRef.current;
    if (!id) return;
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingRef.current = {};
    clearTimer();
    setSaveState("saving");
    try {
      const res = await updateRecurring(id, patch);
      // If more edits piled up while flying, keep dirty and re-flush.
      if (Object.keys(pendingRef.current).length > 0) {
        void flush();
      } else {
        setRule(res.recurring);
        setSaveState("saved");
        if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1500);
        await onChanged?.();
      }
    } catch {
      setSaveState("error");
    }
  }, [onChanged]);

  const queuePatch = useCallback((patch: UpdateBody) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    setSaveState("dirty");
    clearTimer();
    timerRef.current = window.setTimeout(() => { void flush(); }, 400);
  }, [flush]);

  // Load rule on open.
  useEffect(() => {
    if (!ruleId) return;
    let cancelled = false;
    setRule(null);
    setLoadError(null);
    setSaveState("idle");
    setOffsetsTouched(false);
    pendingRef.current = {};
    clearTimer();
    void listRecurring()
      .then((rules) => {
        if (cancelled) return;
        const found = rules.find((r) => r.id === ruleId);
        if (!found) {
          setLoadError("Regra não encontrada");
          return;
        }
        setRule(found);
        // Seed picker: per-rule override if set, else user defaults.
        const seed = Array.isArray(found.reminder_offsets) ? found.reminder_offsets : defaults;
        setOffsetsDraft(seed);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Falha ao carregar regra");
      });
    return () => { cancelled = true; };
    // defaults is sourced from user context and won't change mid-edit
    // (and we only need to seed once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId]);

  // Flush pending on close.
  const handleClose = useCallback(() => {
    if (Object.keys(pendingRef.current).length > 0) {
      void flush();
    }
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    onClose();
  }, [flush, onClose]);

  useEffect(() => {
    return () => {
      clearTimer();
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  // --- field handlers ---------------------------------------------------
  const onTitleChange = (title: string) => {
    setRule((r) => (r ? { ...r, title } : r));
    queuePatch({ title });
  };
  const onDescChange = (description: string) => {
    setRule((r) => (r ? { ...r, description } : r));
    queuePatch({ description });
  };
  const onTimeChange = (t: string) => {
    setRule((r) => (r ? { ...r, time: t || null } : r));
    queuePatch({ time: t || null });
  };
  const onWeekdayChange = (w: number) => {
    setRule((r) => (r ? { ...r, weekday: w } : r));
    queuePatch({ weekday: w });
  };
  const onDayOfMonthChange = (raw: string) => {
    const n = parseInt(raw, 10);
    const v = Number.isFinite(n) && n >= 1 && n <= 31 ? n : null;
    setRule((r) => (r ? { ...r, day_of_month: v } : r));
    queuePatch({ day_of_month: v });
  };
  const onActiveToggle = () => {
    if (!rule) return;
    const next = !rule.active;
    setRule({ ...rule, active: next });
    queuePatch({ active: next });
  };
  const onPickerChange = (next: number[]) => {
    setOffsetsTouched(true);
    setOffsetsDraft(next);
    queuePatch({ reminder_offsets: next });
  };
  const onClearOverride = () => {
    setOffsetsTouched(true);
    setOffsetsDraft(defaults);
    queuePatch({ reminder_offsets: null });
  };

  const doDelete = async () => {
    if (!ruleId) return;
    if (!window.confirm("Excluir esta regra?")) return;
    try {
      await deleteRecurring(ruleId);
      await onDeleted?.();
      onClose();
    } catch {
      setSaveState("error");
    }
  };

  const open = ruleId !== null;
  const effectiveOffsets = offsetsTouched
    ? offsetsDraft
    : (Array.isArray(rule?.reminder_offsets) ? rule!.reminder_offsets! : defaults);
  const usingDefaults =
    !offsetsTouched && !(Array.isArray(rule?.reminder_offsets));

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      maxWidth="max-w-md"
      title={
        <span className="flex items-center gap-2">
          <span>Editar regra</span>
          <SaveIndicator state={saveState} />
        </span>
      }
    >
      {loadError ? (
        <div className="px-5 py-4 text-sm text-red-400">{loadError}</div>
      ) : !rule ? (
        <div className="grid place-items-center py-10" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-5 py-5">
          {/* Active toggle */}
          <div
            className="flex items-center justify-between rounded-lg px-3.5 py-3"
            style={inputStyle}
          >
            <div>
              <div className="text-[13px] font-medium text-[#EEF2FF]">Regra ativa</div>
              <div className="text-[11px]" style={{ color: "#4D5E8A" }}>
                {rule.active ? "Materializando ocorrências" : "Pausada"}
              </div>
            </div>
            <button
              type="button"
              onClick={onActiveToggle}
              aria-pressed={rule.active}
              className="relative h-6 w-11 rounded-full transition-colors"
              style={{
                background: rule.active ? "#4F7EFF" : "#162040",
                border: "1px solid rgba(99,130,255,0.20)",
              }}
            >
              <span
                className="absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white transition-transform"
                style={{ transform: rule.active ? "translateX(22px)" : "translateX(2px)" }}
              />
            </button>
          </div>

          {/* Title */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
              Título
            </span>
            <input
              value={rule.title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
              style={inputStyle}
            />
          </label>

          {/* Frequency-specific schedule controls */}
          {rule.frequency === "weekly" ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
                Dia da semana
              </span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((label, idx) => {
                  const isOn = rule.weekday === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => onWeekdayChange(idx)}
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

          {rule.frequency === "monthly" ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
                Dia do mês
              </span>
              <input
                type="number"
                min={1}
                max={31}
                value={rule.day_of_month ?? ""}
                onChange={(e) => onDayOfMonthChange(e.target.value)}
                placeholder="1-31"
                className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
                style={inputStyle}
              />
            </label>
          ) : null}

          {rule.frequency === "daily" ? (
            <div className="text-[11px] italic" style={{ color: "#4D5E8A" }}>
              Frequência diária. Mude o horário abaixo se necessário.
            </div>
          ) : null}

          {/* Time */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
              Horário
            </span>
            <input
              type="time"
              value={rule.time ?? ""}
              onChange={(e) => onTimeChange(e.target.value)}
              className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
              style={inputStyle}
            />
          </label>

          {/* Description */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
              Descrição
            </span>
            <textarea
              value={rule.description ?? ""}
              onChange={(e) => onDescChange(e.target.value)}
              placeholder="Opcional"
              rows={3}
              className="rounded-lg px-3.5 py-2.5 placeholder:text-[#4D5E8A] focus:outline-none resize-none"
              style={inputStyle}
            />
          </label>

          {/* Reminders */}
          {rule.time ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
                Lembretes extras
              </span>
              <RemindersPicker
                value={effectiveOffsets}
                onChange={onPickerChange}
              />
              {usingDefaults && defaults.length > 0 ? (
                <span className="text-[10px]" style={{ color: "#4D5E8A" }}>
                  Herdando do seu perfil — toque para sobrescrever.
                </span>
              ) : null}
              {!usingDefaults ? (
                <button
                  type="button"
                  onClick={onClearOverride}
                  className="self-start text-[11px] underline"
                  style={{ color: "#7DA4FF" }}
                >
                  Voltar a herdar do perfil
                </button>
              ) : null}
            </div>
          ) : (
            <div className="text-[11px] italic" style={{ color: "#4D5E8A" }}>
              Defina um horário para configurar lembretes.
            </div>
          )}

          {/* Delete */}
          <button
            type="button"
            onClick={() => void doDelete()}
            className="mt-2 inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-11 rounded-lg text-[13px] font-medium"
            style={{
              background: "rgba(255,91,114,0.10)",
              color: "#FF5B72",
              border: "1px solid rgba(255,91,114,0.25)",
            }}
          >
            <Trash2 className="h-4 w-4" />
            Excluir regra
          </button>
        </div>
      )}
    </Sheet>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-normal" style={{ color: "#4D5E8A" }}>
        <Loader2 className="h-3 w-3 animate-spin" />
        salvando
      </span>
    );
  }
  if (state === "saved") {
    return <span className="text-[11px] font-normal" style={{ color: "#2DD4BF" }}>Salvo</span>;
  }
  if (state === "error") {
    return <span className="text-[11px] font-normal" style={{ color: "#FF5B72" }}>Erro</span>;
  }
  if (state === "dirty") {
    return <span className="text-[11px] font-normal" style={{ color: "#F5A623" }}>•</span>;
  }
  return null;
}
