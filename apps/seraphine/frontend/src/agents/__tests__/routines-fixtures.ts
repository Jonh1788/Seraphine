/** Builders for the phase-6b wire shapes (routines, ledger lines, drafts). */
import type { AgentDraft, Routine, RoutineDraft, RoutineDraftResult, RoutineRun } from '../types';

export function makeRoutine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'rt1',
    agent_id: 'lia',
    project_id: 'home-lia',
    title: 'Pendências do dia',
    prompt: 'Liste o que está pendente nas minhas notas.',
    schedule: { kind: 'weekdays', time: '08:00' },
    schedule_text: 'Todo dia útil às 08:00',
    report: 'news',
    enabled: true,
    paused_reason: null,
    next_run_at: '2026-11-13T11:00:00Z',
    upcoming: ['2026-11-13T11:00:00Z', '2026-11-16T11:00:00Z', '2026-11-17T11:00:00Z'],
    last_run_at: null,
    last_status: null,
    consecutive_failures: 0,
    week: { ok: 0, total: 0 },
    running: false,
    origin: 'manual',
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    ...over,
  };
}

export function makeRoutineRun(over: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 'rr1',
    routine_id: 'rt1',
    scheduled_for: '2026-11-12T11:00:00Z',
    trigger: 'schedule',
    status: 'reported',
    run_id: 'run-1',
    detail: '',
    finished_at: '2026-11-12T11:02:00Z',
    ...over,
  };
}

export function makeRoutineDraft(over: Partial<RoutineDraft> = {}): RoutineDraft {
  return {
    title: 'Resumo da semana',
    prompt: 'Resuma o que aconteceu nas minhas notas esta semana.',
    schedule: { kind: 'weekly', time: '17:00', days: [4] },
    report: 'news',
    ...over,
  };
}

export function makeDraftResult(over: Partial<RoutineDraftResult['draft']> = {}, say = 'Entendi: todo dia útil às 8h, pendências.'): RoutineDraftResult {
  return {
    say,
    draft: {
      title: 'Pendências',
      prompt: 'Me mande as pendências.',
      schedule: { kind: 'weekdays', time: '08:00' },
      schedule_text: 'Todo dia útil às 08:00',
      report: 'news',
      ...over,
    },
  };
}

/** A ready-team agent draft that brings one routine. */
export function draftWithRoutines(routines: RoutineDraft[] = [makeRoutineDraft()], over: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name: 'Lia',
    role: 'Lembretes e listas',
    description: 'Cuida dos seus lembretes e listas.',
    instructions: 'Ajude com lembretes e listas, falando simples.',
    suggestions: ['Anote o que preciso comprar'],
    routines,
    ...over,
  };
}
