/** Builders for the phase-6c wire shapes (conversation messages, proposals, agent versions). */
import { checkProposal } from '../api';
import type { AgentVersion, GuideMessage, GuideProposal, ProposalKind } from '../types';
import { draftWithRoutines, makeRoutineDraft } from './routines-fixtures';

export function makeGuideMessage(over: Partial<GuideMessage> = {}): GuideMessage {
  return { id: 'gm1', author: 'owner', body: 'Deixe a Lia mais direta.', proposal_ids: [], created_at: '2026-11-12T12:00:00Z', ...over };
}

export function makeGuideReply(over: Partial<GuideMessage> = {}): GuideMessage {
  return makeGuideMessage({ id: 'gm2', author: 'seraphine', body: 'Preparei uma proposta para você conferir.', proposal_ids: ['pr1'], created_at: '2026-11-12T12:00:05Z', ...over });
}

/** The proposal as the backend sends it (wire shape: `payload` without a `kind` inside). */
export function wireProposal(kind: ProposalKind = 'update_agent', over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: 'pr1',
    kind,
    status: 'pending',
    result: null,
    detail: '',
    created_at: '2026-11-12T12:00:05Z',
    expires_at: '2026-11-13T12:00:05Z',
    decided_at: null,
  };
  const byKind: Record<ProposalKind, Record<string, unknown>> = {
    update_agent: {
      title: 'Mudar as instruções de Lia',
      payload: { agent_id: 'lia', changes: { instructions: 'Responda sempre de forma direta e curta.' } },
      before: { instructions: 'Ajude com lembretes e listas, falando simples.' },
      target: { agent_id: 'lia' },
    },
    create_agents: {
      title: 'Criar 2 agentes',
      payload: {
        agents: [
          draftWithRoutines([makeRoutineDraft({ title: 'Resumo da semana', schedule_text: 'Toda sexta às 17:00' })], { name: 'Bia', role: 'Viagens', description: 'Cuida das suas viagens.' }),
          draftWithRoutines([], { name: 'Caio', role: 'Estudos', description: 'Ajuda nos estudos.', routines: undefined }),
        ],
      },
      before: null,
      target: {},
    },
    create_routine: {
      title: 'Nova rotina de Lia: Revisão do dia',
      payload: { agent_id: 'lia', title: 'Revisão do dia', prompt: 'Revise o que ficou pendente hoje.', schedule: { kind: 'weekdays', time: '18:00' }, report: 'news' },
      before: null,
      target: { agent_id: 'lia' },
    },
    update_routine: {
      title: 'Mudar o horário de Pendências do dia',
      payload: { routine_id: 'rt1', changes: { schedule: { kind: 'weekdays', time: '07:00' } } },
      before: { schedule: { kind: 'weekdays', time: '08:00' }, schedule_text: 'Todo dia útil às 08:00' },
      target: { routine_id: 'rt1' },
    },
  };
  return { ...base, ...byKind[kind], ...over };
}

/** The proposal as the screen holds it (parsed by the real validator). */
export function makeProposal(kind: ProposalKind = 'update_agent', over: Record<string, unknown> = {}): GuideProposal {
  return checkProposal(wireProposal(kind, over), 'x');
}

export function makeVersion(over: Partial<AgentVersion> = {}): AgentVersion {
  return {
    version: 1,
    name: 'Lia',
    role: 'Lembretes e listas',
    description: 'Cuida dos seus lembretes.',
    instructions: 'Ajude com lembretes e listas, falando simples.',
    suggestions: ['Anote o que preciso comprar'],
    changed_by: 'owner',
    note: 'Criado.',
    changed_fields: [],
    created_at: '2026-11-01T10:00:00Z',
    ...over,
  };
}
