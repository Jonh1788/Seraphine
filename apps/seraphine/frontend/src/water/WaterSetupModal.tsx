import { useEffect, useMemo, useRef, useState } from 'react';
import { XIcon, BellIcon } from '../icons/Icons';
import type { WaterActivityLevel, WaterProfile, WaterProfileInput } from './types';

export interface WaterSetupModalProps {
  profile?: WaterProfile | null;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (value: WaterProfileInput) => void;
}

const ACTIVITY_OPTIONS: { value: WaterActivityLevel; label: string; hint: string }[] = [
  { value: 'sedentary', label: 'Sedentario', hint: 'pouco exercicio' },
  { value: 'moderate', label: 'Moderado', hint: '3-4x por semana' },
  { value: 'active', label: 'Ativo', hint: 'diario ou intenso' },
];

const MULTIPLIER: Record<WaterActivityLevel, number> = {
  sedentary: 30,
  moderate: 35,
  active: 40,
};

/** Mirrors `seraphine.water.service.compute_goal`. */
function computeGoal(weightKg: number, activity: WaterActivityLevel): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return 2000;
  const raw = Math.round(weightKg * MULTIPLIER[activity]);
  return Math.max(1500, Math.min(5000, raw));
}

function formatGoal(ml: number): string {
  return `${(ml / 1000).toFixed(2).replace('.', ',')}L`;
}

export function WaterSetupModal({
  profile,
  busy,
  onClose,
  onSubmit,
}: WaterSetupModalProps): JSX.Element {
  const isEdit = !!profile;

  const [weight, setWeight] = useState<number>(profile?.weight_kg ?? 70);
  const [height, setHeight] = useState<string>(
    profile?.height_cm != null ? String(profile.height_cm) : '',
  );
  const [activity, setActivity] = useState<WaterActivityLevel>(
    profile?.activity_level ?? 'moderate',
  );
  const [remindersEnabled, setRemindersEnabled] = useState<boolean>(
    profile?.reminder_enabled ?? true,
  );
  const [reminderStart, setReminderStart] = useState<string>(
    profile?.reminder_start ?? '08:00',
  );
  const [reminderEnd, setReminderEnd] = useState<string>(
    profile?.reminder_end ?? '22:00',
  );
  const [reminderInterval, setReminderInterval] = useState<number>(
    profile?.reminder_interval_hours ?? 2,
  );

  const weightInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    weightInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const computedGoal = useMemo(() => computeGoal(weight, activity), [weight, activity]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    const heightNum = height.trim() === '' ? null : Number(height);
    const payload: WaterProfileInput = {
      weight_kg: weight,
      height_cm:
        heightNum != null && Number.isFinite(heightNum) && heightNum > 0
          ? heightNum
          : null,
      activity_level: activity,
      reminder_enabled: remindersEnabled,
      reminder_start: reminderStart,
      reminder_end: reminderEnd,
      reminder_interval_hours: reminderInterval,
    };
    onSubmit(payload);
  };

  return (
    <div className="password-modal-backdrop" onClick={busy ? undefined : onClose}>
      <form
        className="task-editor-modal water-setup-modal"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="te__header">
          <span className="te__title" style={{ cursor: 'default' }}>
            {isEdit ? 'Editar perfil de hidratacao' : 'Configurar hidratacao'}
          </span>
          <div className="te__actions">
            <button
              type="button"
              className="te__action"
              onClick={onClose}
              disabled={busy}
              title="Fechar"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div className="te__fields">
          {/* Weight */}
          <div className="te__row water-setup__row water-setup__row--block">
            <span className="te__label">Peso</span>
            <div className="water-setup__slider-row">
              <input
                ref={weightInputRef}
                type="range"
                min={30}
                max={150}
                step={0.5}
                value={weight}
                onChange={(e) => setWeight(Number(e.target.value))}
                disabled={busy}
                className="water-setup__slider"
                aria-label="Peso em kg"
              />
              <div className="water-setup__slider-value">
                <input
                  type="number"
                  min={30}
                  max={200}
                  step={0.5}
                  value={weight}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setWeight(n);
                  }}
                  disabled={busy}
                  className="water-setup__number-input"
                  aria-label="Peso (numero)"
                />
                <span className="water-setup__unit">kg</span>
              </div>
            </div>
          </div>

          {/* Height (optional) */}
          <div className="te__row water-setup__row water-setup__row--block">
            <span className="te__label">Altura (opcional)</span>
            <div className="water-setup__slider-value">
              <input
                type="number"
                min={140}
                max={220}
                step={1}
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                disabled={busy}
                className="water-setup__number-input"
                placeholder="--"
                aria-label="Altura em cm"
              />
              <span className="water-setup__unit">cm</span>
            </div>
          </div>

          {/* Activity level */}
          <div className="te__row water-setup__row water-setup__row--block">
            <span className="te__label">Nivel de atividade</span>
            <div className="water-setup__activity">
              {ACTIVITY_OPTIONS.map((opt) => {
                const selected = activity === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    className={`water-setup__activity-btn${selected ? ' water-setup__activity-btn--selected' : ''}`}
                    onClick={() => setActivity(opt.value)}
                    disabled={busy}
                    aria-pressed={selected}
                  >
                    <span className="water-setup__activity-label">{opt.label}</span>
                    <span className="water-setup__activity-hint">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Computed goal preview */}
          <div className="water-setup__goal">
            <span className="water-setup__goal-label">Meta diaria</span>
            <span className="water-setup__goal-value">{formatGoal(computedGoal)}</span>
            <span className="water-setup__goal-sub">({computedGoal}ml)</span>
          </div>

          {/* Reminders */}
          <div className="te__row water-setup__row water-setup__row--block">
            <label className="water-setup__toggle">
              <span className="water-setup__toggle-label">
                <BellIcon size={14} />
                Lembretes
              </span>
              <input
                type="checkbox"
                checked={remindersEnabled}
                onChange={(e) => setRemindersEnabled(e.target.checked)}
                disabled={busy}
              />
              <span className="water-setup__toggle-track" aria-hidden>
                <span className="water-setup__toggle-thumb" />
              </span>
            </label>
          </div>

          {remindersEnabled && (
            <div className="te__row water-setup__row water-setup__row--block">
              <span className="te__label">Janela</span>
              <div className="water-setup__reminders">
                <input
                  type="time"
                  value={reminderStart}
                  onChange={(e) => setReminderStart(e.target.value)}
                  disabled={busy}
                  className="water-setup__time"
                  aria-label="Inicio"
                />
                <span className="water-setup__reminders-sep">ate</span>
                <input
                  type="time"
                  value={reminderEnd}
                  onChange={(e) => setReminderEnd(e.target.value)}
                  disabled={busy}
                  className="water-setup__time"
                  aria-label="Fim"
                />
                <span className="water-setup__reminders-sep">a cada</span>
                <select
                  value={reminderInterval}
                  onChange={(e) => setReminderInterval(Number(e.target.value))}
                  disabled={busy}
                  className="water-setup__select"
                  aria-label="Intervalo"
                >
                  {[1, 2, 3, 4].map((h) => (
                    <option key={h} value={h}>
                      {h}h
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="te__footer">
          <span />
          <button
            type="submit"
            className="btn-confirm"
            disabled={busy || weight <= 0}
            style={{ padding: '6px 20px', borderRadius: '8px' }}
          >
            {busy ? 'Salvando...' : isEdit ? 'Salvar' : 'Comecar'}
          </button>
        </div>
      </form>
    </div>
  );
}
