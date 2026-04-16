import { useEffect, useRef, useState } from 'react';
import { TrashIcon, XIcon } from '../icons/Icons';
import { HABIT_COLOR_PALETTE, HABIT_ICON_KEYS, habitIcon } from './HabitIconMap';
import type { Habit, HabitFrequency } from './types';

const WEEKDAY_LABELS = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D']; // Mon..Sun
const WEEKDAY_FULL = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];
const WEEKDAYS_DEFAULT = [0, 1, 2, 3, 4]; // Mon..Fri

export interface HabitEditorValue {
  title: string;
  icon: string;
  color: string;
  frequency: HabitFrequency;
  target_days: number[] | null;
  description: string;
}

interface HabitEditorModalProps {
  // If provided, the modal is in "edit" mode. Otherwise it creates a new habit.
  habit?: Habit | null;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (value: HabitEditorValue) => void;
  onDelete?: () => void;
}

function initialValue(habit: Habit | null | undefined): HabitEditorValue {
  if (habit) {
    return {
      title: habit.title,
      icon: habit.icon || 'check',
      color: habit.color || HABIT_COLOR_PALETTE[0],
      frequency: habit.frequency,
      target_days:
        habit.frequency === 'custom'
          ? (habit.target_days ?? WEEKDAYS_DEFAULT)
          : habit.target_days ?? null,
      description: habit.description ?? '',
    };
  }
  return {
    title: '',
    icon: 'check',
    color: HABIT_COLOR_PALETTE[0],
    frequency: 'daily',
    target_days: null,
    description: '',
  };
}

export function HabitEditorModal({
  habit,
  busy,
  onClose,
  onSubmit,
  onDelete,
}: HabitEditorModalProps): JSX.Element {
  const [value, setValue] = useState<HabitEditorValue>(() => initialValue(habit));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const isEdit = !!habit;

  const setField = <K extends keyof HabitEditorValue>(
    key: K,
    v: HabitEditorValue[K],
  ): void => {
    setValue((prev) => ({ ...prev, [key]: v }));
  };

  const setFrequency = (freq: HabitFrequency): void => {
    setValue((prev) => ({
      ...prev,
      frequency: freq,
      target_days:
        freq === 'custom'
          ? (prev.target_days && prev.target_days.length > 0
              ? prev.target_days
              : WEEKDAYS_DEFAULT)
          : null,
    }));
  };

  const toggleWeekday = (day: number): void => {
    setValue((prev) => {
      const cur = prev.target_days ?? [];
      const next = cur.includes(day)
        ? cur.filter((d) => d !== day)
        : [...cur, day].sort((a, b) => a - b);
      return { ...prev, target_days: next };
    });
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const title = value.title.trim();
    if (!title || busy) return;
    const payload: HabitEditorValue = {
      ...value,
      title,
      description: value.description.trim(),
      target_days: value.frequency === 'custom' ? (value.target_days ?? []) : null,
    };
    onSubmit(payload);
  };

  const handleDelete = (): void => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete?.();
  };

  const canSubmit =
    value.title.trim().length > 0 &&
    (value.frequency !== 'custom' ||
      (value.target_days != null && value.target_days.length > 0));

  return (
    <div className="password-modal-backdrop" onClick={busy ? undefined : onClose}>
      <form
        className="task-editor-modal habit-editor-modal"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="te__header">
          <input
            ref={inputRef}
            type="text"
            className="te__title"
            value={value.title}
            onChange={(e) => setField('title', e.target.value)}
            disabled={busy}
            placeholder="Nome do habito..."
            required
          />
          <div className="te__actions">
            {isEdit && onDelete && (
              <>
                {confirmDelete ? (
                  <>
                    <button
                      type="button"
                      className="te__action te__action--danger"
                      disabled={busy}
                      onClick={handleDelete}
                    >
                      Sim
                    </button>
                    <button
                      type="button"
                      className="te__action"
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Nao
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="te__action te__action--danger"
                    disabled={busy}
                    onClick={handleDelete}
                    title="Excluir"
                  >
                    <TrashIcon size={16} />
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="te__action"
              disabled={busy}
              onClick={onClose}
              title="Fechar"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div className="te__fields">
          {/* Icon picker */}
          <div className="te__row habit-editor__row habit-editor__row--block">
            <span className="te__label">Icone</span>
            <div className="habit-editor__icons">
              {HABIT_ICON_KEYS.map((key) => {
                const selected = value.icon === key;
                return (
                  <button
                    type="button"
                    key={key}
                    className={`habit-editor__icon${selected ? ' habit-editor__icon--selected' : ''}`}
                    onClick={() => setField('icon', key)}
                    aria-pressed={selected}
                    aria-label={key}
                    style={
                      selected
                        ? { background: `${value.color}22`, color: value.color, borderColor: value.color }
                        : undefined
                    }
                  >
                    {habitIcon(key, 18)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Color picker */}
          <div className="te__row habit-editor__row habit-editor__row--block">
            <span className="te__label">Cor</span>
            <div className="habit-editor__colors">
              {HABIT_COLOR_PALETTE.map((c) => {
                const selected = value.color === c;
                return (
                  <button
                    type="button"
                    key={c}
                    className={`habit-editor__color${selected ? ' habit-editor__color--selected' : ''}`}
                    onClick={() => setField('color', c)}
                    aria-pressed={selected}
                    aria-label={c}
                    style={{ background: c }}
                  />
                );
              })}
            </div>
          </div>

          {/* Frequency */}
          <div className="te__row habit-editor__row habit-editor__row--block">
            <span className="te__label">Frequencia</span>
            <div className="habit-editor__freq">
              {(
                [
                  { value: 'daily', label: 'Diaria' },
                  { value: 'weekdays', label: 'Dias uteis' },
                  { value: 'custom', label: 'Personalizada' },
                ] as { value: HabitFrequency; label: string }[]
              ).map((opt) => {
                const selected = value.frequency === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    className={`habit-editor__freq-btn${selected ? ' habit-editor__freq-btn--selected' : ''}`}
                    onClick={() => setFrequency(opt.value)}
                    aria-pressed={selected}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom weekdays */}
          {value.frequency === 'custom' && (
            <div className="te__row habit-editor__row habit-editor__row--block">
              <span className="te__label">Dias</span>
              <div className="habit-editor__weekdays">
                {WEEKDAY_LABELS.map((lbl, idx) => {
                  const active = (value.target_days ?? []).includes(idx);
                  return (
                    <button
                      type="button"
                      key={idx}
                      className={`habit-editor__weekday${active ? ' habit-editor__weekday--active' : ''}`}
                      onClick={() => toggleWeekday(idx)}
                      aria-pressed={active}
                      aria-label={WEEKDAY_FULL[idx]}
                      title={WEEKDAY_FULL[idx]}
                      style={active ? { background: value.color, borderColor: value.color } : undefined}
                    >
                      {lbl}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <textarea
          className="te__description"
          value={value.description}
          onChange={(e) => setField('description', e.target.value)}
          disabled={busy}
          placeholder="Descricao (opcional)..."
        />

        <div className="te__footer">
          <span />
          <button
            type="submit"
            className="btn-confirm"
            disabled={busy || !canSubmit}
            style={{ padding: '6px 20px', borderRadius: '8px' }}
          >
            {busy ? 'Salvando...' : isEdit ? 'Salvar' : 'Criar habito'}
          </button>
        </div>
      </form>
    </div>
  );
}
