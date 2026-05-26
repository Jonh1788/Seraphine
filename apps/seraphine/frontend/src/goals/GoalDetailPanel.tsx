import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftIcon, PlusIcon, TrashIcon } from '../icons/Icons';
import { GoalProgressBar } from './GoalProgressBar';
import { GoalEditorModal, type GoalEditorValue } from './GoalEditorModal';
import {
  getGoalDetail,
  updateGoal,
  deleteGoal,
  createKeyResult,
  updateKeyResult,
} from './api';
import type {
  Goal,
  KeyResult,
  GoalLink,
  KRMetricType,
} from './types';
import {
  AREA_LABELS,
  AREA_COLORS,
  TIMEFRAME_LABELS,
  STATUS_LABELS,
} from './types';

interface GoalDetailPanelProps {
  goalId: string;
  onBack: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
}

interface KRFormState {
  title: string;
  metric_type: KRMetricType;
  target_value: string;
  unit: string;
}

const EMPTY_KR_FORM: KRFormState = {
  title: '',
  metric_type: 'numeric',
  target_value: '',
  unit: '',
};

function daysRemaining(endDate: string | null): number | null {
  if (!endDate) return null;
  const diff = Math.ceil(
    (new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  return diff;
}

export function GoalDetailPanel({
  goalId,
  onBack,
  onDeleted,
  onUpdated,
}: GoalDetailPanelProps): JSX.Element {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [keyResults, setKeyResults] = useState<KeyResult[]>([]);
  const [links, setLinks] = useState<GoalLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [showKRForm, setShowKRForm] = useState(false);
  const [krForm, setKRForm] = useState<KRFormState>(EMPTY_KR_FORM);
  const [krBusy, setKRBusy] = useState(false);
  const [editingKR, setEditingKR] = useState<string | null>(null);
  const [editingKRValue, setEditingKRValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGoalDetail(goalId);
      setGoal(data.goal);
      setKeyResults(data.key_results);
      setLinks(data.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleEdit = useCallback(
    async (value: GoalEditorValue) => {
      setEditBusy(true);
      try {
        await updateGoal(goalId, {
          title: value.title,
          description: value.description || null,
          area: value.area,
          timeframe: value.timeframe,
          start_date: value.start_date || null,
          end_date: value.end_date || null,
        });
        setEditOpen(false);
        await refresh();
        onUpdated();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setEditBusy(false);
      }
    },
    [goalId, refresh, onUpdated],
  );

  const handleDelete = useCallback(async () => {
    setDeleteBusy(true);
    try {
      await deleteGoal(goalId);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }, [goalId, onDeleted]);

  const handleAddKR = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const title = krForm.title.trim();
      const target = parseFloat(krForm.target_value);
      if (!title || isNaN(target) || target <= 0) return;
      setKRBusy(true);
      try {
        await createKeyResult(goalId, {
          title,
          metric_type: krForm.metric_type,
          target_value: target,
          unit: krForm.unit.trim() || null,
        });
        setKRForm(EMPTY_KR_FORM);
        setShowKRForm(false);
        await refresh();
        onUpdated();
      } catch (e_) {
        setError(e_ instanceof Error ? e_.message : String(e_));
      } finally {
        setKRBusy(false);
      }
    },
    [goalId, krForm, refresh, onUpdated],
  );

  const handleKRValueSave = useCallback(
    async (kr: KeyResult) => {
      const val = parseFloat(editingKRValue);
      if (isNaN(val)) {
        setEditingKR(null);
        return;
      }
      try {
        await updateKeyResult(goalId, kr.id, { current_value: val });
        setEditingKR(null);
        await refresh();
        onUpdated();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [goalId, editingKRValue, refresh, onUpdated],
  );

  if (loading && !goal) {
    return (
      <div className="goal-detail">
        <div className="goal-detail__header">
          <button type="button" className="memory-view__back" onClick={onBack}>
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
        </div>
        <p className="goal-detail__loading">Carregando...</p>
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="goal-detail">
        <div className="goal-detail__header">
          <button type="button" className="memory-view__back" onClick={onBack}>
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
        </div>
        {error && <p className="tasks-view__error">{error}</p>}
      </div>
    );
  }

  const days = daysRemaining(goal.end_date);

  return (
    <div className="goal-detail">
      <div className="goal-detail__header">
        <button type="button" className="memory-view__back" onClick={onBack}>
          <ArrowLeftIcon size={18} />
          <span>Voltar</span>
        </button>
        <div className="goal-detail__header-actions">
          <button
            type="button"
            className="goal-detail__edit-btn"
            onClick={() => setEditOpen(true)}
          >
            Editar
          </button>
        </div>
      </div>

      {error && <p className="tasks-view__error">{error}</p>}

      <div className="goal-detail__body">
        <div className="goal-detail__info">
          <h2 className="goal-detail__title">{goal.title}</h2>
          <div className="goal-detail__meta">
            <span
              className="goal-card__area-badge"
              style={{
                background: `${AREA_COLORS[goal.area]}22`,
                color: AREA_COLORS[goal.area],
                borderColor: `${AREA_COLORS[goal.area]}44`,
              }}
            >
              {AREA_LABELS[goal.area]}
            </span>
            <span className="goal-card__timeframe-badge">
              {TIMEFRAME_LABELS[goal.timeframe]}
            </span>
            <span className="goal-card__status-badge">
              {STATUS_LABELS[goal.status]}
            </span>
            {days !== null && days > 0 && (
              <span className="goal-card__days">
                {days} {days === 1 ? 'dia restante' : 'dias restantes'}
              </span>
            )}
            {days !== null && days <= 0 && (
              <span className="goal-card__days goal-card__days--overdue">
                Prazo encerrado
              </span>
            )}
          </div>
          {goal.description && (
            <p className="goal-detail__description">{goal.description}</p>
          )}
          <GoalProgressBar progress={goal.progress} endDate={goal.end_date} />
        </div>

        {/* Key Results */}
        <div className="goal-detail__section">
          <div className="goal-detail__section-header">
            <h3 className="goal-detail__section-title">Resultados-chave</h3>
            <button
              type="button"
              className="goal-detail__add-btn"
              onClick={() => setShowKRForm((v) => !v)}
            >
              <PlusIcon size={14} />
              <span>Adicionar</span>
            </button>
          </div>

          {showKRForm && (
            <form className="goal-detail__kr-form" onSubmit={handleAddKR}>
              <input
                type="text"
                className="goal-detail__kr-input"
                placeholder="Titulo do resultado-chave..."
                value={krForm.title}
                onChange={(e) => setKRForm((p) => ({ ...p, title: e.target.value }))}
                autoFocus
                disabled={krBusy}
              />
              <div className="goal-detail__kr-row">
                <select
                  className="goal-detail__kr-select"
                  value={krForm.metric_type}
                  onChange={(e) =>
                    setKRForm((p) => ({
                      ...p,
                      metric_type: e.target.value as KRMetricType,
                    }))
                  }
                  disabled={krBusy}
                >
                  <option value="numeric">Numerico</option>
                  <option value="boolean">Sim/Nao</option>
                  <option value="percentage">Percentual</option>
                </select>
                <input
                  type="number"
                  className="goal-detail__kr-input goal-detail__kr-input--sm"
                  placeholder="Meta"
                  value={krForm.target_value}
                  onChange={(e) =>
                    setKRForm((p) => ({ ...p, target_value: e.target.value }))
                  }
                  disabled={krBusy}
                  min={0}
                  step="any"
                />
                <input
                  type="text"
                  className="goal-detail__kr-input goal-detail__kr-input--sm"
                  placeholder="Unidade"
                  value={krForm.unit}
                  onChange={(e) =>
                    setKRForm((p) => ({ ...p, unit: e.target.value }))
                  }
                  disabled={krBusy}
                />
              </div>
              <div className="goal-detail__kr-actions">
                <button
                  type="button"
                  className="te__action"
                  onClick={() => {
                    setShowKRForm(false);
                    setKRForm(EMPTY_KR_FORM);
                  }}
                  disabled={krBusy}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn-confirm"
                  disabled={
                    krBusy ||
                    !krForm.title.trim() ||
                    !krForm.target_value ||
                    parseFloat(krForm.target_value) <= 0
                  }
                  style={{ padding: '4px 14px', borderRadius: '6px', fontSize: '12px' }}
                >
                  {krBusy ? 'Salvando...' : 'Adicionar'}
                </button>
              </div>
            </form>
          )}

          {keyResults.length === 0 && !showKRForm && (
            <p className="goal-detail__empty-kr">
              Nenhum resultado-chave. Adicione para acompanhar progresso.
            </p>
          )}

          <div className="goal-detail__kr-list">
            {keyResults.map((kr) => (
              <div key={kr.id} className="goal-detail__kr">
                <div className="goal-detail__kr-info">
                  <span className="goal-detail__kr-title">{kr.title}</span>
                  <span className="goal-detail__kr-values">
                    {editingKR === kr.id ? (
                      <input
                        type="number"
                        className="goal-detail__kr-inline-input"
                        value={editingKRValue}
                        onChange={(e) => setEditingKRValue(e.target.value)}
                        onBlur={() => void handleKRValueSave(kr)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleKRValueSave(kr);
                          if (e.key === 'Escape') setEditingKR(null);
                        }}
                        autoFocus
                        min={0}
                        step="any"
                      />
                    ) : (
                      <button
                        type="button"
                        className="goal-detail__kr-value-btn"
                        onClick={() => {
                          setEditingKR(kr.id);
                          setEditingKRValue(String(kr.current_value));
                        }}
                        title="Clique para editar"
                      >
                        {kr.current_value}
                      </button>
                    )}
                    <span className="goal-detail__kr-separator">/</span>
                    <span>{kr.target_value}</span>
                    {kr.unit && (
                      <span className="goal-detail__kr-unit">{kr.unit}</span>
                    )}
                  </span>
                </div>
                <GoalProgressBar
                  progress={kr.progress}
                  size="sm"
                  showLabel={false}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Linked items (future) */}
        <div className="goal-detail__section">
          <div className="goal-detail__section-header">
            <h3 className="goal-detail__section-title">Itens vinculados</h3>
          </div>
          <p className="goal-detail__empty-kr">
            {links.length === 0
              ? 'Nenhum item vinculado.'
              : `${links.length} ${links.length === 1 ? 'item vinculado' : 'itens vinculados'}`}
          </p>
        </div>

        {/* Delete */}
        <div className="goal-detail__danger-zone">
          {confirmDelete ? (
            <div className="goal-detail__confirm-row">
              <span>Tem certeza? O objetivo sera marcado como abandonado.</span>
              <button
                type="button"
                className="te__action te__action--danger"
                disabled={deleteBusy}
                onClick={() => void handleDelete()}
              >
                {deleteBusy ? 'Excluindo...' : 'Confirmar'}
              </button>
              <button
                type="button"
                className="te__action"
                onClick={() => setConfirmDelete(false)}
                disabled={deleteBusy}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="goal-detail__delete-btn"
              onClick={() => setConfirmDelete(true)}
            >
              <TrashIcon size={14} />
              <span>Excluir objetivo</span>
            </button>
          )}
        </div>
      </div>

      {editOpen && (
        <GoalEditorModal
          goal={goal}
          busy={editBusy}
          onClose={() => setEditOpen(false)}
          onSubmit={(v) => void handleEdit(v)}
          onDelete={() => void handleDelete()}
        />
      )}
    </div>
  );
}
