/**
 * Standalone chat block renderer for a Health snapshot.
 *
 * The LLM tools in seraphine/tools/health.py already emit server-rendered
 * `html_card` strings, and ChatView renders those directly. This block
 * is here for non-tool-driven flows (e.g. dashboard "ask Seraphine"
 * shortcuts) that want to embed a structured view from an in-memory
 * snapshot without going through the HTML string.
 */

import { ActivityIcon, BedIcon, FlameIcon, FootprintsIcon, HeartPulseIcon } from '../icons/Icons';
import type { HealthSnapshot } from './types';

interface Props {
  snapshot: HealthSnapshot;
}

const STEPS_GOAL = 10_000;

function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return '—';
  const total = Math.round(value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

export function HealthChatBlock({ snapshot }: Props): JSX.Element {
  const steps = snapshot.steps ?? 0;
  const pct = Math.min(100, Math.round((steps / STEPS_GOAL) * 100));
  const workouts = snapshot.workouts ?? [];

  return (
    <div className="chat-block chat-block--health">
      <div className="chat-block__header">
        <HeartPulseIcon size={16} />
        <div>
          <div className="chat-block__title">Saude hoje</div>
          <div className="chat-block__subtitle">{snapshot.date}</div>
        </div>
      </div>
      <div className="chat-block__rows">
        <div className="chat-block__row">
          <FootprintsIcon size={14} />
          <span>
            {steps.toLocaleString('pt-BR')} / {STEPS_GOAL.toLocaleString('pt-BR')} passos
            <span className="chat-block__muted"> ({pct}%)</span>
          </span>
        </div>
        <div className="chat-block__row">
          <FlameIcon size={14} />
          <span>{Math.round(snapshot.active_calories)} kcal ativas</span>
        </div>
        <div className="chat-block__row">
          <BedIcon size={14} />
          <span>
            {formatMinutes(snapshot.sleep_minutes)}
            {snapshot.sleep_quality ? ` (${snapshot.sleep_quality})` : ''}
          </span>
        </div>
        <div className="chat-block__row">
          <ActivityIcon size={14} />
          <span>
            {workouts.length === 0
              ? 'Nenhum treino'
              : workouts
                  .map((w) => `${w.type} ${Math.round(w.duration_min || 0)}min`)
                  .join(' · ')}
          </span>
        </div>
        {snapshot.resting_heart_rate != null && (
          <div className="chat-block__row">
            <HeartPulseIcon size={14} />
            <span>FC repouso: {Math.round(snapshot.resting_heart_rate)} bpm</span>
          </div>
        )}
      </div>
    </div>
  );
}
