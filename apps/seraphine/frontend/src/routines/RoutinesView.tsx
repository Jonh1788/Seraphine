import './obsidian.css';
import { useCallback, useEffect, useState } from 'react';
import { ClockIcon, PlayIcon, PlusIcon } from '../icons/Icons';
import { API_BASE } from '../api';
import { iconFor, iconStyleFor, type Routine } from './catalog';

interface RoutinesViewProps {
  onBack: () => void;
  onRun: (prompt: string) => void;
}

// Real proactive scheduler job, as returned by GET /proactive/jobs
// (proactive/scheduler.py:list_jobs). Used to refine the trigger label of the
// scheduled cards that map to a real job (Routine.job_name).
interface ProactiveJob {
  id: string;
  name: string;
  next_run_time?: string | null;
  trigger?: string;
  paused?: boolean;
}

const WEEKDAY_LABELS: Record<string, string> = {
  mon: 'Seg',
  tue: 'Ter',
  wed: 'Qua',
  thu: 'Qui',
  fri: 'Sex',
  sat: 'Sab',
  sun: 'Dom',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// Derive a human PT-BR schedule label from a real proactive job, using its
// APScheduler cron trigger string (e.g. "cron[day_of_week='sun', hour='18',
// minute='0']") and falling back to next_run_time when the trigger cannot be
// parsed. Returns null when no real schedule can be derived.
function deriveTriggerLabel(job: ProactiveJob): string | null {
  const trigger = job.trigger ?? '';
  const fields: Record<string, string> = {};
  const fieldRe = /(\w+)='([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(trigger)) !== null) {
    fields[match[1]] = match[2];
  }
  const hour = fields.hour;
  const minute = fields.minute;
  if (hour !== undefined && /^\d+$/.test(hour)) {
    const time = `${pad2(Number(hour))}:${pad2(Number(minute ?? '0'))}`;
    const dow = fields.day_of_week;
    if (dow && WEEKDAY_LABELS[dow]) {
      return `${WEEKDAY_LABELS[dow]} · ${time}`;
    }
    if (dow && dow.includes(',')) {
      return `${dow.split(',').length} dias · ${time}`;
    }
    return `${time} · todo dia`;
  }
  if (job.next_run_time) {
    const d = new Date(job.next_run_time);
    if (!Number.isNaN(d.getTime())) {
      return `proxima: ${d.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return null;
}

export function RoutinesView({ onRun }: RoutinesViewProps): JSX.Element {
  // Real, DB-backed routines (seeded catalog + user-created). Source of truth.
  const [routines, setRoutines] = useState<Routine[]>([]);
  // Live proactive-job state keyed by job name; only refines the trigger label
  // for scheduled routines that map to a real job (routine.job_name).
  const [jobs, setJobs] = useState<Record<string, ProactiveJob>>({});
  const [creating, setCreating] = useState(false);

  const refreshRoutines = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/recurring/routines`);
      if (!res.ok) return;
      const body = (await res.json()) as { routines?: Routine[] };
      setRoutines(body.routines ?? []);
    } catch {
      // backend may be offline; keep whatever we have
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/proactive/jobs`);
      if (!res.ok) return;
      const body = (await res.json()) as { jobs?: ProactiveJob[] };
      const byName: Record<string, ProactiveJob> = {};
      for (const job of body.jobs ?? []) {
        if (job.name) byName[job.name] = job;
        if (job.id) byName[job.id] = job;
      }
      setJobs(byName);
    } catch {
      // scheduler may be offline; trigger labels fall back to stored value
    }
  }, []);

  useEffect(() => {
    void refreshRoutines();
    void refreshJobs();
  }, [refreshRoutines, refreshJobs]);

  const triggerLabel = (routine: Routine): string | undefined => {
    if (routine.job_name) {
      const job = jobs[routine.job_name];
      if (job) return deriveTriggerLabel(job) ?? routine.trigger ?? undefined;
    }
    return routine.trigger ?? undefined;
  };

  // Persist the enabled toggle. Optimistic local update, then PATCH; revert on
  // failure. For routines backed by a proactive job we also pause/resume that
  // job so the real scheduler state stays in sync.
  const toggle = async (routine: Routine, next: boolean): Promise<void> => {
    setRoutines((prev) =>
      prev.map((r) => (r.id === routine.id ? { ...r, enabled: next } : r)),
    );
    try {
      const res = await fetch(`${API_BASE}/recurring/routines/${encodeURIComponent(routine.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error('patch failed');
      if (routine.job_name) {
        await fetch(
          `${API_BASE}/proactive/jobs/${encodeURIComponent(routine.job_name)}/${next ? 'resume' : 'pause'}`,
          { method: 'POST' },
        ).catch(() => {});
        void refreshJobs();
      }
    } catch {
      // revert optimistic change
      setRoutines((prev) =>
        prev.map((r) => (r.id === routine.id ? { ...r, enabled: !next } : r)),
      );
    }
  };

  // Run a routine: resolve the latest prompt from the backend (source of
  // truth) and launch it into the chat composer, preserving onRun behavior.
  const run = async (routine: Routine): Promise<void> => {
    let prompt = routine.prompt;
    try {
      const res = await fetch(`${API_BASE}/recurring/routines/${encodeURIComponent(routine.id)}/run`, {
        method: 'POST',
      });
      if (res.ok) {
        const body = (await res.json()) as { prompt?: string };
        if (body.prompt) prompt = body.prompt;
      }
    } catch {
      // offline: fall back to the prompt we already have
    }
    onRun(prompt);
  };

  // Create a custom routine via the '+ Nova rotina' button.
  const createRoutine = async (): Promise<void> => {
    const name = window.prompt('Nome da rotina:')?.trim();
    if (!name) return;
    const promptText = window.prompt('O que a Seraphine deve fazer? (prompt)')?.trim();
    if (!promptText) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_BASE}/recurring/routines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt: promptText, kind: 'manual', enabled: true }),
      });
      if (res.ok) {
        const body = (await res.json()) as { routine?: Routine };
        if (body.routine) {
          setRoutines((prev) => [...prev, body.routine as Routine]);
        } else {
          void refreshRoutines();
        }
      }
    } catch {
      // ignore; nothing was created
    } finally {
      setCreating(false);
    }
  };

  const scheduled = routines.filter((r) => r.kind === 'scheduled');
  const manual = routines.filter((r) => r.kind === 'manual');

  const renderCard = (routine: Routine): JSX.Element => {
    const isScheduled = routine.kind === 'scheduled';
    const iconStyle = iconStyleFor(routine);
    return (
      <div key={routine.id} className="routine-card">
        <div className="routine-card__head">
          <span
            className="routine-card__icon"
            style={{ background: iconStyle.background, color: iconStyle.color }}
          >
            {iconFor(routine.icon)}
          </span>
          {isScheduled && (
            <label className="routine-switch">
              <input
                type="checkbox"
                checked={routine.enabled}
                onChange={(event) => void toggle(routine, event.target.checked)}
              />
            </label>
          )}
        </div>
        <h3 className="routine-card__title">{routine.name}</h3>
        <p className="routine-card__detail">{routine.detail}</p>
        <div className="routine-card__foot">
          {isScheduled ? (
            <span className="routine-card__trigger">
              <ClockIcon size={12} />
              {triggerLabel(routine)}
            </span>
          ) : (
            <span className="routine-card__trigger routine-card__trigger--manual">manual</span>
          )}
          <button
            type="button"
            className={`routine-card__run${isScheduled ? '' : ' routine-card__run--manual'}`}
            onClick={() => void run(routine)}
          >
            <PlayIcon size={12} />
            Executar
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="routines-view">
      <div className="routines-view__header">
        <div>
          <h2 className="routines-view__title">Rotinas</h2>
          <p className="routines-view__subtitle">Automatize o que voce repete todo dia</p>
        </div>
        <button
          type="button"
          className="routines-view__new"
          onClick={() => void createRoutine()}
          disabled={creating}
        >
          <PlusIcon size={14} />
          Nova rotina
        </button>
      </div>

      <div className="routines-view__sections">
        <div className="routines-section__label">AGENDADAS</div>
        <div className="routines-grid">{scheduled.map(renderCard)}</div>

        <div className="routines-section__label routines-section__label--manual">MANUAIS</div>
        <div className="routines-grid">{manual.map(renderCard)}</div>
      </div>
    </div>
  );
}
