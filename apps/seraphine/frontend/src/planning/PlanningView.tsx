import './obsidian.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, SparkleIcon } from '../icons/Icons';
import { fetchPlan, acceptPlan, updateBlock } from './api';
import type { DailyPlan, PlanContext, TimeBlock } from './types';

interface PlanningViewProps {
  onBack: () => void;
  onNavigate?: (view: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/* Event chip colors aligned to the global category palette. */
const BLOCK_COLORS: Record<string, string> = {
  focus: '#9a93ff', // --accent
  meeting: '#42a5f5', // Educação
  break: '#26a69a', // Transporte
  exercise: '#ab47bc', // Lazer
  admin: '#78909c', // Outros
  free: '#5f5e6b', // --text-faint
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

/* PT labels for the energy estimate the backend already computes. */
const ENERGY_LABELS: Record<string, string> = {
  high: 'Energia alta',
  medium: 'Energia media',
  low: 'Energia baixa',
};

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function blockHour(block: TimeBlock): number {
  return Math.floor(hmToMin(block.start) / 60);
}

/** Color-tinted background for a category color at 0.14 alpha. */
function tintBg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

function formatToday(): string {
  const raw = dateFormatter.format(new Date());
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/* 6-dot drag-handle (inline, stroke 1.8 currentColor — no emoji). */
function GripIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function EventChip({
  block,
  onEdit,
  aiGenerated = false,
}: {
  block: TimeBlock;
  onEdit: (block: TimeBlock) => void;
  aiGenerated?: boolean;
}): JSX.Element {
  const color = BLOCK_COLORS[block.type] || BLOCK_COLORS.admin;
  const isFree = block.type === 'free';
  const isFocus = block.type === 'focus';

  if (isFocus) {
    return (
      <div
        className="planning__event planning__event--focus"
        onClick={() => onEdit(block)}
        title={`${block.start} - ${block.end} | ${BLOCK_LABELS[block.type] || block.type}`}
      >
        <div className="planning__event-title">{block.title}</div>
        <div className="planning__event-time">
          {block.start} – {block.end}
          {block.reason ? ` · ${block.reason}` : ''}
        </div>
        {/* Only claim AI authorship when the backend actually ran an LLM
            pass. Heuristic blocks get an honest, non-AI label. */}
        <div className="planning__suggested">
          {aiGenerated ? (
            <>
              <SparkleIcon size={11} />
              sugerido pela Seraphine
            </>
          ) : (
            'bloco de foco sugerido'
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`planning__event${isFree ? ' planning__event--free' : ''}`}
      style={
        isFree
          ? undefined
          : { borderLeftColor: color, background: tintBg(color) }
      }
      onClick={() => onEdit(block)}
      title={`${block.start} - ${block.end} | ${BLOCK_LABELS[block.type] || block.type}`}
    >
      <div className="planning__event-title">{block.title}</div>
      {!isFree && (
        <div className="planning__event-time">
          {block.start} – {block.end}
        </div>
      )}
    </div>
  );
}

function Timeline({
  blocks,
  onEdit,
  aiGenerated,
}: {
  blocks: TimeBlock[];
  onEdit: (block: TimeBlock) => void;
  aiGenerated: boolean;
}): JSX.Element {
  // Group every block by the hour in which it starts. Multiple blocks can
  // share an hour (e.g. a short break + free slot, or back-to-back meetings),
  // so we keep all of them rather than only the first.
  const byHour = useMemo(() => {
    const map = new Map<number, TimeBlock[]>();
    for (const block of [...blocks].sort((a, b) => a.start.localeCompare(b.start))) {
      const h = blockHour(block);
      const bucket = map.get(h);
      if (bucket) bucket.push(block);
      else map.set(h, [block]);
    }
    return map;
  }, [blocks]);

  const rows: JSX.Element[] = [];
  for (let h = HOUR_START; h <= HOUR_END; h++) {
    const hourBlocks = byHour.get(h) ?? [];
    const hasFocus = hourBlocks.some((b) => b.type === 'focus');
    rows.push(
      <div
        key={h}
        className={`planning__hour-row${hasFocus ? ' planning__hour-row--focus' : ''}`}
      >
        <span className="planning__hour">{String(h).padStart(2, '0')}:00</span>
        {hourBlocks.length > 0 ? (
          <div className="planning__hour-blocks">
            {hourBlocks.map((block) => (
              <EventChip
                key={block.id}
                block={block}
                onEdit={onEdit}
                aiGenerated={aiGenerated}
              />
            ))}
          </div>
        ) : (
          <div className="planning__hour-empty" />
        )}
      </div>,
    );
  }

  return <div className="planning__timeline-card">{rows}</div>;
}

function AEncaixarCard({
  priorities,
}: {
  priorities: DailyPlan['priorities'];
}): JSX.Element {
  return (
    <div className="planning__sidebar-card">
      <div className="planning__sidebar-title">A encaixar</div>
      <div className="planning__unscheduled">
        {priorities.length === 0 ? (
          <span className="planning__task-empty">Nada pendente para encaixar</span>
        ) : (
          priorities.map((p) => (
            <div key={p.id} className="planning__task" draggable>
              <span className="planning__task-grip">
                <GripIcon />
              </span>
              <span className="planning__task-label">{p.title}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EmRiscoCard({
  atRisk,
}: {
  atRisk: DailyPlan['at_risk'];
}): JSX.Element | null {
  const { habits, goals } = atRisk;
  if (habits.length === 0 && goals.length === 0) return null;

  return (
    <div className="planning__sidebar-card">
      <div className="planning__sidebar-title">Em risco hoje</div>
      <div className="planning__risk-list">
        {habits.map((h) => (
          <div key={`habit-${h.id}`} className="planning__risk-item">
            <span className="planning__risk-label">{h.title}</span>
            <span className="planning__risk-meta">
              {h.current_streak} dia{h.current_streak === 1 ? '' : 's'} de sequencia
            </span>
          </div>
        ))}
        {goals.map((g) => (
          <div key={`goal-${g.id}`} className="planning__risk-item">
            <span className="planning__risk-label">{g.title}</span>
            <span className="planning__risk-meta">
              {Math.round(g.progress)}% concluido
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContextStrip({ ctx }: { ctx: PlanContext }): JSX.Element | null {
  const chips: string[] = [];
  chips.push(ENERGY_LABELS[ctx.energy_estimate] || ctx.energy_estimate);
  if (ctx.sleep_hours != null) {
    chips.push(`Sono ${ctx.sleep_hours}h`);
  }
  if (ctx.meetings_count > 0) {
    chips.push(
      `${ctx.meetings_count} reuniao${ctx.meetings_count === 1 ? '' : 's'}`,
    );
  }

  return (
    <div className="planning__context">
      <div className="planning__context-chips">
        {chips.map((c) => (
          <span key={c} className="planning__context-chip">
            {c}
          </span>
        ))}
      </div>
      {ctx.mood_reason ? (
        <p className="planning__context-mood">{ctx.mood_reason}</p>
      ) : null}
    </div>
  );
}

function PlanoSugeridoCard({
  plan,
  accepting,
  accepted,
  onApply,
  onAdjust,
}: {
  plan: DailyPlan;
  accepting: boolean;
  accepted: boolean;
  onApply: () => void;
  onAdjust: () => void;
}): JSX.Element {
  const ctx = plan.context;
  const focusBlocks = plan.time_blocks.filter((b) => b.type === 'focus').length;
  const freeHours = Math.round(ctx.free_slots_min / 60);
  const aiGenerated = ctx.ai_generated === true;

  // Prefer the model-written pitch when a real LLM pass produced one;
  // otherwise fall back to an honest numeric summary derived client-side.
  const derived =
    focusBlocks > 0
      ? `Reservei ${focusBlocks > 1 ? `${focusBlocks} blocos` : '1 bloco'} de foco para quando você rende mais e deixei ${freeHours}h livres na agenda. Aplico?`
      : `Organizei sua agenda com ${freeHours}h livres para o que importa hoje. Aplico?`;
  const body = aiGenerated && ctx.summary ? ctx.summary : derived;
  const heading = aiGenerated ? 'Sugerido pela Seraphine' : 'Plano do dia';

  return (
    <div className="planning__suggestion-card">
      <div className="planning__suggestion-head">
        {aiGenerated ? <SparkleIcon size={16} /> : null}
        <span>{heading}</span>
      </div>
      <p className="planning__suggestion-body">{body}</p>
      {accepted ? (
        <button className="planning__apply planning__apply--accepted" disabled>
          Plano aplicado
        </button>
      ) : (
        <button
          className="planning__apply"
          onClick={onApply}
          disabled={accepting}
        >
          {accepting ? 'Aplicando...' : 'Aplicar plano'}
        </button>
      )}
      <button className="planning__adjust" onClick={onAdjust}>
        Ajustar via chat
      </button>
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

  const formattedDate = formatToday();

  return (
    <div className="planning">
      <header className="planning__header">
        <div className="planning__header-titles">
          <button
            type="button"
            className="planning__back"
            onClick={onBack}
            aria-label="Voltar"
          >
            <ArrowLeftIcon size={18} />
          </button>
          <div>
            <h2 className="planning__title">Planejamento</h2>
            <p className="planning__subtitle">{formattedDate}</p>
          </div>
        </div>
        <button
          type="button"
          className="planning__plan-cta"
          onClick={() => void loadPlan()}
          disabled={loading}
        >
          <SparkleIcon size={14} />
          Planejar com a Seraphine
        </button>
      </header>

      {loading && (
        <div className="planning__loading">Gerando plano...</div>
      )}

      {error && (
        <div className="planning__error">{error}</div>
      )}

      {plan && !loading && (
        <div className="planning__layout">
          <Timeline
            blocks={plan.time_blocks}
            onEdit={handleBlockEdit}
            aiGenerated={plan.context.ai_generated === true}
          />

          <aside className="planning__sidebar">
            <ContextStrip ctx={plan.context} />
            <AEncaixarCard priorities={plan.priorities} />
            <EmRiscoCard atRisk={plan.at_risk} />
            <PlanoSugeridoCard
              plan={plan}
              accepting={accepting}
              accepted={accepted}
              onApply={handleAccept}
              onAdjust={handleChatAdjust}
            />
          </aside>
        </div>
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
