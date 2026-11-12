/** Builders for the phase-6a wire shapes (setup, packs, drafts, team result). */
import type { AgentDraft, Pack, Setup, TeamResult } from '../types';
import { makeAgent, makeProject } from './fixtures';

export function makeSetup(over: Partial<Setup> = {}): Setup {
  return {
    areas: null,
    areas_skipped: false,
    default_engine: null,
    dismissed: false,
    home_dir: 'C:\\Users\\dono\\Seraphine\\agentes',
    steps: [
      { id: 'areas', done: false },
      { id: 'engine', done: false },
      { id: 'agents', done: false },
      { id: 'first_reply', done: false },
    ],
    done: 0,
    total: 4,
    ...over,
  };
}

/** A setup whose steps are done up to (and not including) the first id not listed. */
export function setupWithDone(done: string[], over: Partial<Setup> = {}): Setup {
  const ids = ['areas', 'engine', 'agents', 'first_reply'] as const;
  return makeSetup({ steps: ids.map((id) => ({ id, done: done.includes(id) })), done: done.length, ...over });
}

export function makeDraft(over: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name: 'Lia',
    role: 'Lembretes e listas',
    description: 'Cuida dos seus lembretes e listas.',
    instructions: 'Ajude com lembretes e listas, falando simples.',
    suggestions: ['Anote o que preciso comprar', 'Lembre-me de pagar a conta', 'Monte a lista do mercado'],
    ...over,
  };
}

export function makePack(over: Partial<Pack> = {}): Pack {
  return {
    id: 'dia_em_ordem',
    label: 'Dia em ordem',
    summary: 'Lembretes, listas e notas',
    detail: 'Para quem quer tirar da cabeça o que precisa lembrar.',
    areas: ['dia_a_dia', 'casa'],
    agents: [makeDraft(), makeDraft({ name: 'Nara', role: 'Notas e organização', description: 'Organiza as suas notas.' })],
    ...over,
  };
}

export function makeTeamResult(over: Partial<TeamResult> = {}): TeamResult {
  return {
    created: [
      {
        def: makeAgent({ id: 'lia', name: 'Lia', home_project_id: 'home-lia', origin: 'pack:dia_em_ordem' }),
        home: makeProject({ id: 'home-lia', name: 'Lia', kind: 'home', agent_id: 'lia' }),
      },
    ],
    failed: [],
    lowered: [],
    routines: [],
    batch: null,
    ...over,
  };
}
