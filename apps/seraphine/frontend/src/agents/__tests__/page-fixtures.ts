/** Builders for the phase 6c part 2 wire shapes (agent page, checklist, usage, team batch). Parsed shapes, as the screens hold them. */
import type { AgentPage, Checklist, TeamBatch, TeamUndoResult, Usage } from '../types';
import { makeAgent, makeProject } from './fixtures';

export function makeChecklist(over: Partial<Checklist> = {}): Checklist {
  return {
    items: [
      { id: 'engine', done: true, optional: false },
      { id: 'first_talk', done: false, optional: false },
      { id: 'access', done: false, optional: false },
      { id: 'routine', done: false, optional: true },
    ],
    done: 1,
    total: 4,
    dismissed: false,
    ...over,
  };
}

/** A checklist whose listed ids are done and the others are not. */
export function checklistWithDone(done: string[], over: Partial<Checklist> = {}): Checklist {
  const ids = [
    ['engine', false],
    ['first_talk', false],
    ['access', false],
    ['routine', true],
  ] as const;
  return makeChecklist({ items: ids.map(([id, optional]) => ({ id, done: done.includes(id), optional })), done: done.length, total: 4, ...over });
}

export function makeAgentPage(over: Partial<AgentPage> = {}): AgentPage {
  return {
    def: makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes e listas', description: 'Cuida dos seus lembretes.', home_project_id: 'home-lia', project_ids: ['home-lia'], version: 3 }),
    home: makeProject({ id: 'home-lia', name: 'Lia', path: 'C:\\agentes\\lia', kind: 'home', agent_id: 'lia' }),
    engine: { ready: true, label: 'Plano do Claude (Claude Code)', how: '' },
    access: [
      { group: 'notes', label: 'Notas', level: 'write' },
      { group: 'wiki', label: 'Wiki', level: 'read' },
      { group: 'memory', label: 'Memória pessoal', level: 'none' },
    ],
    routines: { total: 2, active: 1, next_run_at: '2026-11-13T11:00:00Z' },
    activity: { runs: 12, last_run_at: '2026-11-12T11:00:00Z', tokens_in: 1234567, tokens_out: 8900 },
    checklist: makeChecklist(),
    ...over,
  };
}

/** The same shape as the backend sends it (what the validators read). */
export function wirePage(page: AgentPage = makeAgentPage()): Record<string, unknown> {
  return JSON.parse(JSON.stringify(page)) as Record<string, unknown>;
}

export function makeUsage(over: Partial<Usage> = {}): Usage {
  return {
    days: 30,
    totals: { runs: 40, routine_runs: 9, tokens_in: 1500000, tokens_out: 250000, cost_usd: 0.72 },
    agents: [
      { agent_id: 'lia', name: 'Lia', archived: false, runs: 12, routine_runs: 4, tokens_in: 1000000, tokens_out: 150000, cost_usd: 0.72, cost_known: true, last_run_at: '2026-11-12T11:00:00Z' },
      { agent_id: 'bia', name: 'Bia', archived: true, runs: 28, routine_runs: 5, tokens_in: 500000, tokens_out: 100000, cost_usd: 0, cost_known: false, last_run_at: null },
    ],
    by_day: [
      { date: '2026-11-10', runs: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
      { date: '2026-11-11', runs: 3, tokens_in: 10, tokens_out: 5, cost_usd: 0 },
      { date: '2026-11-12', runs: 5, tokens_in: 20, tokens_out: 9, cost_usd: 0.1 },
    ],
    ...over,
  };
}

export function makeBatch(over: Partial<TeamBatch> = {}): TeamBatch {
  return {
    id: 'b1',
    undo_until: '2026-11-13T10:00:00Z',
    undone_at: null,
    can_undo: true,
    agents: [
      { agent_id: 'lia', name: 'Lia', exists: true },
      { agent_id: 'nara', name: 'Nara', exists: true },
    ],
    ...over,
  };
}

export function makeUndoResult(over: Partial<TeamUndoResult> = {}): TeamUndoResult {
  return { removed: [{ agent_id: 'nara', name: 'Nara' }], archived: [{ agent_id: 'lia', name: 'Lia' }], kept: [], ...over };
}
