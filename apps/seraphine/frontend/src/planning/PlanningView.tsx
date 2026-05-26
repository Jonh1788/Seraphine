import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftIcon,
  CalendarIcon,
  ClockIcon,
  CheckIcon,
  AlertTriangleIcon,
  FlameIcon,
  BedIcon,
  TargetIcon,
} from '../icons/Icons';
import { fetchPlan, acceptPlan, updateBlock } from './api';
import type { DailyPlan, TimeBlock } from './types';

interface PlanningViewProps {
  onBack: () => void;
  onNavigate?: (view: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const BLOCK_COLORS: Record<string, string> = {
  focus: '#a78bfa',
  meeting: '#60a5fa',
  break: '#4ade80',
  exercise: '#fb923c',
  admin: '#9ca3af',
  free: 'transparent',
};

const BLOCK_LABELS: Record<string, string> = {
  focus: 'Foco',
  meeting: 'Reuniao',
  break: 'Pausa',
  exercise: 'Exercicio',
  admin: 'Admin',
  free: 'Livre',
};

const HOUR_START = 6;
const HOUR_END = 23;
const TOTAL_MINUTES = (HOUR_END - HOUR_START) * 60;
const PX_PER_MINUTE = 2.5;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function blockDuration(block: TimeBlock): number {
  return Math.max(0, hmToMin(block.end) - hmToMin(block.start));
}

function energyLabel(energy: string): string {
  switch (energy) {
    case 'high': return 'Alta';
    case 'medium': return 'Media';
    case 'low': return 'Baixa';
    default: return energy;
  }
}

function energyColor(energy: string): string {
  switch (energy) {
    case 'high': return '#4ade80';
    case 'medium': return '#fbbf24';
    case 'low': return '#f87171';
    default: return '#9ca3af';
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ContextCards({ plan }: { plan: DailyPlan }) {
  const ctx = plan.context;
  return (
    <div className="planning__context-row">
      {ctx.sleep_hours != null && (
        <div className="planning__context-card">
          <BedIcon size={16} />
          <span className="planning__context-value">{ctx.sleep_hours}h</span>
          <span className="planning__context-label">sono</span>
        </div>
      )}
      <div className="planning__context-card">
        <FlameIcon size={16} />
        <span
          className="planning__context-value"
          style={{ color: energyColor(ctx.energy_estimate) }}
        >
          {energyLabel(ctx.energy_estimate)}
        </span>
        <span className="planning__context-label">energia</span>
      </div>
      <div className="planning__context-card">
        <CalendarIcon size={16} />
        <span className="planning__context-value">{ctx.meetings_count}</span>
        <span className="planning__context-label">
          {ctx.meetings_count === 1 ? 'reuniao' : 'reunioes'}
        </span>
      </div>
      <div className="planning__context-card">
        <ClockIcon size={16} />
        <span className="planning__context-value">
          {Math.round(ctx.free_slots_min / 60)}h
        </span>
        <span className="planning__context-label">livre</span>
      </div>
    </div>
  );
}

function TimelineBlock({
  block,
  onEdit,
}: {
  block: TimeBlock;
  onEdit: (block: TimeBlock) => void;
}) {
  const topMin = hmToMin(block.start) - HOUR_START * 60;
  const heightMin = blockDuration(block);
  const top = topMin * PX_PER_MINUTE;
  const height = Math.max(heightMin * PX_PER_MINUTE, 24);
  const color = BLOCK_COLORS[block.type] || '#9ca3af';
  const isFree = block.type === 'free';

  return (
    <div
      className={`planning__block${isFree ? ' planning__block--free' : ''}`}
      style={{
        top: `${top}px`,
        height: `${height}px`,
        borderLeftColor: color,
        ...(isFree
          ? { border: `1px dashed rgba(255,255,255,0.15)`, borderLeft: `3px dashed ${color}` }
          : {}),
      }}
      onClick={() => onEdit(block)}
      title={`${block.start} - ${block.end} | ${BLOCK_LABELS[block.type] || block.type}`}
    >
      <div className="planning__block-header">
        <span
          className="planning__block-type"
          style={{ color }}
        >
          {BLOCK_LABELS[block.type] || block.type}
        </span>
        <span className="planning__block-time">
          {block.start} - {block.end}
        </span>
      </div>
      {heightMin >= 30 && (
        <div className="planning__block-title">{block.title}</div>
      )}
      {heightMin >= 50 && block.reason && (
        <div className="planning__block-reason">{block.reason}</div>
      )}
    </div>
  );
}

function HourLabels() {
  const labels: JSX.Element[] = [];
  for (let h = HOUR_START; h <= HOUR_END; h++) {
    const top = (h - HOUR_START) * 60 * PX_PER_MINUTE;
    labels.push(
      <div
        key={h}
        className="planning__hour-label"
        style={{ top: `${top}px` }}
      >
        {String(h).padStart(2, '0')}:00
      </div>,
    );
    // Grid line
    labels.push(
      <div
        key={`line-${h}`}
        className="planning__hour-line"
        style={{ top: `${top}px` }}
      />,
    );
  }
  return <>{labels}</>;
}

function PriorityList({ priorities }: { priorities: DailyPlan['priorities'] }) {
  if (priorities.length === 0) return null;
  return (
    <div className="planning__section">
      <h3 className="planning__section-title">
        <TargetIcon size={16} />
        Prioridades
      </h3>
      <ul className="planning__priority-list">
        {priorities.map((p) => (
          <li key={p.id} className="planning__priority-item">
            <span className="planning__priority-title">{p.title}</span>
            {p.priority && (
              <span
                className="planning__priority-badge"
                data-prio={p.priority}
              >
                {p.priority}
              </span>
            )}
            {p.due_date && (
              <span className="planning__priority-due">{p.due_date}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AtRiskSection({ atRisk }: { atRisk: DailyPlan['at_risk'] }) {
  const hasHabits = atRisk.habits.length > 0;
  const hasGoals = atRisk.goals.length > 0;
  if (!hasHabits && !hasGoals) return null;

  return (
    <div className="planning__section">
      <h3 className="planning__section-title">
        <AlertTriangleIcon size={16} />
        Em risco
      </h3>
      {hasHabits && (
        <ul className="planning__risk-list">
          {atRisk.habits.map((h) => (
            <li key={h.id} className="planning__risk-item">
              <FlameIcon size={14} />
              <span>{h.title}</span>
              <span className="planning__risk-streak">
                {h.current_streak} dias
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasGoals && (
        <ul className="planning__risk-list">
          {atRisk.goals.map((g) => (
            <li key={g.id} className="planning__risk-item">
              <TargetIcon size={14} />
              <span>{g.title}</span>
              <span className="planning__risk-streak">
                {g.progress}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Edit modal (inline)                                                */
/* ------------------------------------------------------------------ */

function BlockEditModal({
  block,
  onSave,
  onClose,
}: {
  block: TimeBlock;
  onSave: (id: string, patch: { start?: string; end?: string; title?: string }) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(block.start);
  const [end, setEnd] = useState(block.end);
  const [title, setTitle] = useState(block.title);

  return (
    <div className="planning__edit-overlay" onClick={onClose}>
      <div
        className="planning__edit-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="planning__edit-title">Ajustar bloco</h3>
        <label className="planning__edit-label">
          Titulo
          <input
            className="planning__edit-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="planning__edit-row">
          <label className="planning__edit-label">
            Inicio
            <input
              className="planning__edit-input"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="planning__edit-label">
            Fim
            <input
              className="planning__edit-input"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <div className="planning__edit-actions">
          <button
            className="planning__btn planning__btn--secondary"
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            className="planning__btn planning__btn--primary"
            onClick={() => onSave(block.id, { start, end, title })}
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function PlanningView({ onBack, onNavigate }: PlanningViewProps): JSX.Element {
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [editingBlock, setEditingBlock] = useState<TimeBlock | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPlan();
      setPlan(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar plano');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const handleAccept = useCallback(async () => {
    setAccepting(true);
    try {
      const result = await acceptPlan();
      if (result.ok) {
        setAccepted(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao aceitar plano');
    } finally {
      setAccepting(false);
    }
  }, []);

  const handleBlockEdit = useCallback((block: TimeBlock) => {
    if (block.type === 'meeting') return; // meetings are immutable
    setEditingBlock(block);
  }, []);

  const handleBlockSave = useCallback(
    async (id: string, patch: { start?: string; end?: string; title?: string }) => {
      try {
        await updateBlock(id, patch);
        setEditingBlock(null);
        void loadPlan();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro ao salvar bloco');
      }
    },
    [loadPlan],
  );

  const handleChatAdjust = useCallback(() => {
    if (onNavigate) {
      onNavigate('chat');
    }
  }, [onNavigate]);

  const timelineHeight = TOTAL_MINUTES * PX_PER_MINUTE;

  return (
    <div className="planning">
      <header className="planning__header">
        <button
          type="button"
          className="planning__back"
          onClick={onBack}
          aria-label="Voltar"
        >
          <ArrowLeftIcon size={20} />
        </button>
        <h2 className="planning__title">Plano do dia</h2>
      </header>

      {loading && (
        <div className="planning__loading">Gerando plano...</div>
      )}

      {error && (
        <div className="planning__error">{error}</div>
      )}

      {plan && !loading && (
        <>
          <ContextCards plan={plan} />

          <div className="planning__timeline-wrapper">
            <div
              className="planning__timeline"
              style={{ height: `${timelineHeight}px` }}
            >
              <HourLabels />
              <div className="planning__blocks">
                {plan.time_blocks.map((block) => (
                  <TimelineBlock
                    key={block.id}
                    block={block}
                    onEdit={handleBlockEdit}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="planning__bottom">
            <PriorityList priorities={plan.priorities} />
            <AtRiskSection atRisk={plan.at_risk} />

            <div className="planning__actions">
              {!accepted ? (
                <button
                  className="planning__btn planning__btn--primary planning__btn--wide"
                  onClick={handleAccept}
                  disabled={accepting}
                >
                  <CheckIcon size={16} />
                  {accepting ? 'Criando eventos...' : 'Aceitar plano'}
                </button>
              ) : (
                <div className="planning__accepted-msg">
                  <CheckIcon size={16} />
                  Plano aceito - eventos criados no Google Calendar
                </div>
              )}
              <button
                className="planning__btn planning__btn--secondary planning__btn--wide"
                onClick={handleChatAdjust}
              >
                Ajustar via chat
              </button>
            </div>
          </div>
        </>
      )}

      {editingBlock && (
        <BlockEditModal
          block={editingBlock}
          onSave={handleBlockSave}
          onClose={() => setEditingBlock(null)}
        />
      )}
    </div>
  );
}
