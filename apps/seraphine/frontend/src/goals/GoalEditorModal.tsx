import { useEffect, useRef, useState } from 'react';
import { TrashIcon, XIcon } from '../icons/Icons';
import type {
  Goal,
  GoalArea,
  GoalTimeframe,
} from './types';
import { AREA_LABELS, AREA_COLORS, ALL_AREAS, TIMEFRAME_LABELS } from './types';

export interface GoalEditorValue {
  title: string;
  description: string;
  area: GoalArea;
  timeframe: GoalTimeframe;
  start_date: string;
  end_date: string;
}

interface GoalEditorModalProps {
  goal?: Goal | null;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (value: GoalEditorValue) => void;
  onDelete?: () => void;
}

const TIMEFRAMES: { value: GoalTimeframe; label: string }[] = [
  { value: 'quarterly', label: TIMEFRAME_LABELS.quarterly },
  { value: 'yearly', label: TIMEFRAME_LABELS.yearly },
  { value: 'open_ended', label: TIMEFRAME_LABELS.open_ended },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function initialValue(goal: Goal | null | undefined): GoalEditorValue {
  if (goal) {
    return {
      title: goal.title,
      description: goal.description ?? '',
      area: goal.area,
      timeframe: goal.timeframe,
      start_date: goal.start_date ?? '',
      end_date: goal.end_date ?? '',
    };
  }
  return {
    title: '',
    description: '',
    area: 'pessoal',
    timeframe: 'quarterly',
    start_date: today(),
    end_date: '',
  };
}

export function GoalEditorModal({
  goal,
  busy,
  onClose,
  onSubmit,
  onDelete,
}: GoalEditorModalProps): JSX.Element {
  const [value, setValue] = useState<GoalEditorValue>(() => initialValue(goal));
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

  const isEdit = !!goal;

  const setField = <K extends keyof GoalEditorValue>(
    key: K,
    v: GoalEditorValue[K],
  ): void => {
    setValue((prev) => ({ ...prev, [key]: v }));
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const title = value.title.trim();
    if (!title || busy) return;
    onSubmit({ ...value, title, description: value.description.trim() });
  };

  const handleDelete = (): void => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete?.();
  };

  const canSubmit = value.title.trim().length > 0;

  return (
    <div className="password-modal-backdrop" onClick={busy ? undefined : onClose}>
      <form
        className="task-editor-modal goal-editor-modal"
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
            placeholder="Nome do objetivo..."
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
          {/* Area */}
          <div className="te__row goal-editor__row goal-editor__row--block">
            <span className="te__label">Area</span>
            <div className="goal-editor__chips">
              {ALL_AREAS.map((a) => {
                const selected = value.area === a;
                return (
                  <button
                    key={a}
                    type="button"
                    className={`goal-editor__chip${selected ? ' goal-editor__chip--selected' : ''}`}
                    onClick={() => setField('area', a)}
                    aria-pressed={selected}
                    style={
                      selected
                        ? { background: `${AREA_COLORS[a]}22`, color: AREA_COLORS[a], borderColor: AREA_COLORS[a] }
                        : undefined
                    }
                  >
                    {AREA_LABELS[a]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Timeframe */}
          <div className="te__row goal-editor__row goal-editor__row--block">
            <span className="te__label">Prazo</span>
            <div className="goal-editor__chips">
              {TIMEFRAMES.map((tf) => {
                const selected = value.timeframe === tf.value;
                return (
                  <button
                    key={tf.value}
                    type="button"
                    className={`goal-editor__chip${selected ? ' goal-editor__chip--selected' : ''}`}
                    onClick={() => setField('timeframe', tf.value)}
                    aria-pressed={selected}
                  >
                    {tf.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Start date */}
          <div className="te__row">
            <span className="te__label">Inicio</span>
            <input
              type="date"
              className="goal-editor__date"
              value={value.start_date}
              onChange={(e) => setField('start_date', e.target.value)}
              disabled={busy}
            />
          </div>

          {/* End date (hidden for open_ended) */}
          {value.timeframe !== 'open_ended' && (
            <div className="te__row">
              <span className="te__label">Fim</span>
              <input
                type="date"
                className="goal-editor__date"
                value={value.end_date}
                onChange={(e) => setField('end_date', e.target.value)}
                disabled={busy}
              />
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
            {busy ? 'Salvando...' : isEdit ? 'Salvar' : 'Criar objetivo'}
          </button>
        </div>
      </form>
    </div>
  );
}
