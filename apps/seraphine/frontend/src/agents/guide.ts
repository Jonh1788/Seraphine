/**
 * Pure helpers of phase 6c part 1 (conversation with the Seraphine, proposal cards, agent history): the words of states,
 * the before/after rows, the suggestions of the empty conversation, the deadline sentence. No React, no network.
 */
import { parseIsoUtc } from './lib';
import { REPORT_LABELS, humanWhen, scheduleText } from './routines';
import type {
  Agent,
  AgentChangedBy,
  AgentTextField,
  AgentVersion,
  GuideAbout,
  GuideProposal,
  ProposalStatus,
  Routine,
} from './types';
import { AGENT_TEXT_FIELDS } from './types';

/** The chip of each state: the word (the icon is picked by the card). */
export const PROPOSAL_STATE_WORDS: Record<ProposalStatus, string> = {
  pending: 'Esperando você',
  applied: 'Aplicada',
  dismissed: 'Descartada',
  expired: 'Venceu',
  stale: 'Desatualizada',
  failed: 'Não deu certo',
};

/** A proposal still `pending` on the server but past its deadline on this clock reads as expired (the server decides on the next read). */
export function effectiveStatus(p: Pick<GuideProposal, 'status' | 'expires_at'>, now: Date = new Date()): ProposalStatus {
  if (p.status === 'pending' && p.expires_at) {
    const at = parseIsoUtc(p.expires_at);
    if (at && at.getTime() <= now.getTime()) return 'expired';
  }
  return p.status;
}

export function pendingProposalCount(proposals: Record<string, GuideProposal>, now: Date = new Date()): number {
  let n = 0;
  for (const p of Object.values(proposals)) if (effectiveStatus(p, now) === 'pending') n += 1;
  return n;
}

/** "A Seraphine tem 2 propostas esperando": the line of "ESPERANDO VOCÊ" and the tooltip of the sidebar entry. */
export function pendingProposalsLine(n: number): string {
  return `A Seraphine tem ${n} ${n === 1 ? 'proposta' : 'propostas'} esperando`;
}

/** The header subtitle part of Início: "uma proposta da Seraphine espera sua decisão". */
export function pendingProposalsSubtitle(n: number): string {
  return n === 1 ? 'uma proposta da Seraphine espera sua decisão' : `${n} propostas da Seraphine esperam sua decisão`;
}

/** "Vale até amanhã às 14:00" while the proposal waits ('' otherwise). */
export function deadlineLine(p: Pick<GuideProposal, 'status' | 'expires_at'>, now: Date = new Date()): string {
  if (effectiveStatus(p, now) !== 'pending' || !p.expires_at) return '';
  const when = humanWhen(p.expires_at, now);
  return when ? `Vale até ${when}` : '';
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

// ---------- fields ----------

export const AGENT_FIELD_LABELS: Record<AgentTextField, string> = {
  name: 'Nome',
  role: 'Papel',
  description: 'O que ele faz',
  instructions: 'Instruções',
  suggestions: 'Sugestões',
};

/** The field as the object of a sentence ("Muda o nome e as instruções de Bia"). */
export const AGENT_FIELD_WORDS: Record<AgentTextField, string> = {
  name: 'o nome',
  role: 'o papel',
  description: 'a descrição',
  instructions: 'as instruções',
  suggestions: 'as sugestões',
};

export const ROUTINE_FIELD_LABELS = { title: 'Título', prompt: 'Pedido', schedule: 'Horário', report: 'Relato', enabled: 'Situação' } as const;
const ROUTINE_FIELD_WORDS = { title: 'o título', prompt: 'o pedido', schedule: 'o horário', report: 'o relato', enabled: 'se ela está ligada' } as const;
const ROUTINE_FIELD_ORDER = ['title', 'prompt', 'schedule', 'report', 'enabled'] as const;
type RoutineField = (typeof ROUTINE_FIELD_ORDER)[number];

export const CHANGED_BY_WORDS: Record<AgentChangedBy, string> = {
  owner: 'você',
  guide: 'a Seraphine, a seu pedido',
  pack: 'um time pronto',
  restore: 'uma volta a uma versão anterior',
};

export function changedByWords(by: string): string {
  return by in CHANGED_BY_WORDS ? CHANGED_BY_WORDS[by as AgentChangedBy] : 'outra origem';
}

/** "Mudou o nome e as instruções" ('' for none). */
export function changedFieldsLine(fields: AgentTextField[]): string {
  const ordered = AGENT_TEXT_FIELDS.filter((f) => fields.includes(f));
  return ordered.length ? `Mudou ${joinWords(ordered.map((f) => AGENT_FIELD_WORDS[f]))}` : '';
}

// ---------- before and after ----------

/** One field of a before/after view: `list` fields (suggestions) show one item per line; `before` is null when it is not known. */
export interface DiffRow {
  key: string;
  label: string;
  list: boolean;
  before: string[] | null;
  after: string[];
}

/** Text longer than this is folded behind "Ver o texto inteiro". */
export const COLLAPSE_AFTER = 280;

function textLines(value: unknown): string[] | null {
  return typeof value === 'string' ? [value] : null;
}
function listLines(value: unknown): string[] | null {
  return Array.isArray(value) ? (value as string[]) : null;
}

export function agentFieldRow(field: AgentTextField, before: unknown, after: unknown): DiffRow {
  const list = field === 'suggestions';
  return {
    key: field,
    label: AGENT_FIELD_LABELS[field],
    list,
    before: list ? listLines(before) : textLines(before),
    after: (list ? listLines(after) : textLines(after)) ?? [],
  };
}

type RoutineValues = {
  title?: string;
  prompt?: string;
  schedule?: Parameters<typeof scheduleText>[0];
  schedule_text?: string;
  report?: 'news' | 'always';
  enabled?: boolean;
};

function routineSideValue(field: RoutineField, v: RoutineValues | null | undefined): string[] | null {
  if (!v) return null;
  switch (field) {
    case 'title':
      return textLines(v.title);
    case 'prompt':
      return textLines(v.prompt);
    case 'schedule':
      // The backend may send the sentence; with only the schedule object the page words it itself.
      return v.schedule_text ? [v.schedule_text] : v.schedule ? [scheduleText(v.schedule)] : null;
    case 'report':
      return v.report ? [REPORT_LABELS[v.report]] : null;
    default:
      return typeof v.enabled === 'boolean' ? [v.enabled ? 'Ligada' : 'Pausada'] : null;
  }
}

/** The rows of an `update_routine` proposal: every changed field with what it is now (`before`) and what it becomes. */
export function routineChangeRows(changes: RoutineValues, before: RoutineValues | null): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const field of ROUTINE_FIELD_ORDER) {
    const present = field === 'schedule' ? changes.schedule !== undefined || changes.schedule_text !== undefined : changes[field] !== undefined;
    if (!present) continue;
    rows.push({ key: field, label: ROUTINE_FIELD_LABELS[field], list: false, before: routineSideValue(field, before), after: routineSideValue(field, changes) ?? [] });
  }
  return rows;
}

/** The rows of an `update_agent` proposal. */
export function agentChangeRows(changes: Partial<Record<AgentTextField, unknown>>, before: Partial<Record<AgentTextField, unknown>> | null): DiffRow[] {
  return AGENT_TEXT_FIELDS.filter((f) => changes[f] !== undefined).map((f) => agentFieldRow(f, before?.[f], changes[f]));
}

/** What a version changed compared with the one before it in the list (`previous`), field by field. */
export function versionDiffRows(version: AgentVersion, previous: AgentVersion | null): DiffRow[] {
  return AGENT_TEXT_FIELDS.filter((f) => version.changed_fields.includes(f)).map((f) => agentFieldRow(f, previous ? previous[f] : undefined, version[f]));
}

// ---------- the sentence of a card ----------

/** What a proposal does, in words ("Muda o nome e as instruções de Bia."). Names come from `before` first, so an applied rename still reads right. */
export function proposalSummary(p: GuideProposal, agents: Agent[], routines: Record<string, Routine>): string {
  const payload = p.payload;
  const agentName = (id: string): string => p.before?.name ?? agents.find((a) => a.id === id)?.name ?? 'o agente';
  switch (payload.kind) {
    case 'create_agents': {
      const n = payload.agents.length;
      return `Cria ${n === 1 ? '1 agente' : `${n} agentes`}: ${joinWords(payload.agents.map((a) => a.name))}.`;
    }
    case 'update_agent': {
      const fields = AGENT_TEXT_FIELDS.filter((f) => payload.changes[f] !== undefined).map((f) => AGENT_FIELD_WORDS[f]);
      return `Muda ${joinWords(fields)} de ${agentName(payload.agent_id)}.`;
    }
    case 'create_routine':
      return `Cria uma rotina para ${agents.find((a) => a.id === payload.agent_id)?.name ?? 'o agente'}: «${payload.routine.title}».`;
    default: {
      const title = p.before?.title ?? routines[payload.routine_id]?.title ?? 'sem nome';
      const c = payload.changes;
      const keys = ROUTINE_FIELD_ORDER.filter((f) => (f === 'schedule' ? c.schedule !== undefined || c.schedule_text !== undefined : c[f] !== undefined));
      if (keys.length === 1 && keys[0] === 'enabled') return c.enabled ? `Retoma a rotina «${title}».` : `Pausa a rotina «${title}».`;
      return `Muda ${joinWords(keys.map((f) => ROUTINE_FIELD_WORDS[f]))} da rotina «${title}».`;
    }
  }
}

// ---------- entry points and suggestions ----------

/** What the next message is about, for the chip above the composer ('' when the thing no longer exists). */
export function aboutLabel(about: GuideAbout | undefined, agents: Agent[], routines: Record<string, Routine>): string {
  if (!about) return '';
  if (about.routine_id) {
    const r = routines[about.routine_id];
    return r ? `Sobre a rotina «${r.title}»` : '';
  }
  if (about.agent_id) {
    const a = agents.find((x) => x.id === about.agent_id);
    return a ? `Sobre ${a.name}` : '';
  }
  return '';
}

export const aboutAgentPrefill = (name: string): string => `Sobre ${name}: `;
export const aboutRoutinePrefill = (title: string): string => `Sobre a rotina «${title}»: `;

/** The four suggestions of the empty conversation, written from what exists. They only fill the composer. */
export function guideSuggestions(agents: Agent[], routines: Record<string, Routine>): string[] {
  const agent = agents[0];
  const routine = Object.values(routines).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
  const out: string[] = [];
  out.push(agent ? `Deixe as respostas de ${agent.name} mais diretas` : 'Monte um time para me ajudar com os estudos');
  out.push(
    routine
      ? `Passe a rotina «${routine.title}» para as 7h`
      : agent
        ? `Crie uma rotina para ${agent.name} me lembrar das pendências toda manhã`
        : 'Crie uma rotina que me lembre de revisar a semana toda sexta',
  );
  out.push('Crie um agente para cuidar das minhas viagens');
  out.push(agent ? 'O que cada um dos meus agentes faz hoje?' : 'O que você consegue fazer por mim?');
  return out;
}

// ---------- sentences of refusals ----------

export const GUIDE_BUSY_MESSAGE = 'A Seraphine está ocupada com outro pedido. Espere um instante e tente de novo.';
export const GUIDE_UNAVAILABLE_MESSAGE = 'Não consegui falar com a Seraphine agora. A sua mensagem ficou guardada.';

export function proposalErrorMessage(status: number | null, code: string | null | undefined, detail: string): string {
  if (status === 409 && code === 'proposal_stale') return detail || 'Esta proposta ficou desatualizada: o que ela muda já mudou. Peça de novo à Seraphine.';
  if (status === 409 && code === 'proposal_not_pending') return detail || 'Esta proposta já foi decidida ou venceu.';
  if (status === 409 && code === 'routine_limit') return detail || 'Já existem rotinas demais ligadas para esse agente. Pause uma e tente de novo.';
  if (status === 404) return 'Essa proposta não existe mais.';
  return detail || 'Não consegui fazer isso agora. Tente de novo em instantes.';
}

export function versionErrorMessage(status: number | null, code: string | null | undefined, detail: string): string {
  if (status === 409 && code === 'version_current') return 'Esta já é a versão atual.';
  if (status === 404) return 'Essa versão não existe mais.';
  return detail || 'Não consegui voltar para essa versão agora. Tente de novo em instantes.';
}
