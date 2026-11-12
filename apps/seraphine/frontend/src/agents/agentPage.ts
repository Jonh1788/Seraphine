/**
 * Pure helpers and the words of phase 6c part 2: the agent page ("Sobre"), the to-do list, pause and archive, the settings
 * screen (usage, access table) and the undo of a team. No React, no network.
 */
import { formatTime, formatUsd } from './lib';
import type { Checklist, ChecklistItem, ChecklistItemId, GrantLevel, TeamUndoResult, ToolGroup, Usage } from './types';
import { CHECKLIST_ITEM_IDS } from './types';

// ---------- numbers ----------

const NUMBER = new Intl.NumberFormat('pt-BR');

/** `1234567` -> "1.234.567". */
export function formatCount(value: number | null | undefined): string {
  return NUMBER.format(Number.isFinite(value as number) ? (value as number) : 0);
}

export function runsLabel(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'execução' : 'execuções'}`;
}

/** `2026-11-12` -> "12/11". */
export function shortDay(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${d}/${m}` : date;
}

// ---------- access in words ----------

const LEVEL_WORDS: Record<GrantLevel, string> = { none: 'sem acesso', read: 'lê', write: 'lê e escreve' };
/** What a cell of the access table shows (a word, never a colour alone). */
const LEVEL_CELL: Record<GrantLevel, string> = { none: 'Sem acesso', read: 'Lê', write: 'Lê e escreve' };

export function levelWords(level: GrantLevel): string {
  return LEVEL_WORDS[level];
}
export function levelCell(level: GrantLevel): string {
  return LEVEL_CELL[level];
}

/** "Notas: lê e escreve". */
export function accessLine(label: string, level: GrantLevel): string {
  return `${label}: ${LEVEL_WORDS[level]}`;
}

const RANK: Record<GrantLevel, number> = { none: 0, read: 1, write: 2 };

/** The level a click moves to: the next one the group accepts, in the order Sem acesso, Lê, Lê e escreve, then back to the first. */
export function nextLevel(current: GrantLevel, levels: readonly GrantLevel[]): GrantLevel {
  const ordered = [...levels].sort((a, b) => RANK[a] - RANK[b]);
  if (ordered.length === 0) return current;
  const at = ordered.indexOf(current);
  return ordered[(at + 1) % ordered.length];
}

/** Raising the access of a sensitive group (the personal memory) asks for a confirmation. */
export function needsMemoryConfirm(group: Pick<ToolGroup, 'sensitive'>, from: GrantLevel, to: GrantLevel): boolean {
  return group.sensitive && RANK[to] > RANK[from];
}

/** The spoken name of a cell: "Notas de Bia: lê e escreve. Ative para mudar para sem acesso." */
export function cellAriaLabel(group: string, agent: string, level: GrantLevel, next: GrantLevel): string {
  return `${group} de ${agent}: ${LEVEL_WORDS[level]}. Ative para mudar para ${LEVEL_WORDS[next]}.`;
}

export function lockedCellAriaLabel(group: string, agent: string): string {
  return `${group} de ${agent}: travado. ${LOCKED_ROW_NOTE}`;
}

export const LOCKED_ROW_NOTE = 'Este agente só conversa e ainda não usa as ferramentas da Seraphine nesta versão.';

export function grantChangedLine(group: string, agent: string, level: GrantLevel): string {
  return `${group} de ${agent} agora: ${LEVEL_WORDS[level]}.`;
}

export function grantRestoredLine(group: string, agent: string, level: GrantLevel): string {
  return `Desfeito. ${group} de ${agent} voltou para: ${LEVEL_WORDS[level]}.`;
}

export function memoryConfirmMessage(agent: string): string {
  return `${agent} vai poder consultar o que a Seraphine guarda sobre você, e isso é enviado ao provedor de IA que ele usa. Você pode tirar o acesso quando quiser.`;
}

// ---------- to-do list of an agent ----------

export const AGENT_CHECKLIST_LABELS: Record<ChecklistItemId, string> = {
  engine: 'Ter um motor pronto',
  first_talk: 'Fazer o primeiro pedido',
  access: 'Conferir o acesso às ferramentas',
  routine: 'Combinar uma rotina',
};

export function checklistTitle(agentName: string, done: number, total: number): string {
  return `Para ${agentName} trabalhar bem · ${done} de ${total}`;
}

/** The items the screen knows, in the contract's order. */
export function knownChecklistItems(list: Checklist): (ChecklistItem & { id: ChecklistItemId })[] {
  return CHECKLIST_ITEM_IDS.flatMap((id) => {
    const item = list.items.find((i) => i.id === id);
    return item ? [{ ...item, id }] : [];
  });
}

/** The card shows while something is missing and the owner did not dismiss it. */
export function checklistVisible(list: Checklist | null | undefined): list is Checklist {
  return !!list && !list.dismissed && list.done < list.total;
}

/** A first request to put in the composer: the agent's own first example, else a plain hello. */
export function firstRequestText(agentName: string, suggestions: string[]): string {
  return suggestions[0]?.trim() || `Oi, ${agentName}! Me conte o que você consegue fazer por mim.`;
}

// ---------- pause, archive, delete ----------

export function pausedSentence(name: string): string {
  return `${name} está pausado. Retome para conversar.`;
}

export function archiveMessage(name: string): string {
  return `${name} some das listas e deixa de receber mensagens e de rodar rotinas. A conversa, as rotinas, o histórico e a pasta ficam guardados, e você pode restaurar ${name} quando quiser em Agentes, com o filtro "Mostrar arquivados".`;
}

export const DELETE_GOES = ['o agente', 'as rotinas dele', 'o histórico das alterações'] as const;
export const DELETE_STAYS = ['as mensagens já trocadas', 'a pasta dele no disco'] as const;

/** The typed name must match exactly (case and accents included). */
export function nameMatches(typed: string, name: string): boolean {
  return typed === name;
}

/** Pause, resume, archive, restore and delete refusals in plain sentences. */
export function agentActionError(status: number | null, code: string | null | undefined, name: string, detail = ''): string {
  const c = (code ?? '').trim();
  if (status === 409 && c === 'agent_busy') return `${name} está trabalhando agora. Espere terminar, ou pare o trabalho, e tente de novo.`;
  if (status === 409 && c === 'agent_archived') return `${name} está arquivado. Restaure antes de mudar.`;
  if (status === 404) return `${name} não existe mais.`;
  return detail || 'Não consegui fazer isso agora. Tente de novo em instantes.';
}

export function archivedSendSentence(name: string): string {
  return `${name} está arquivado. Restaure para conversar.`;
}

export function copyOkSentence(): string {
  return 'Caminho copiado.';
}
export const COPY_FALLBACK = 'Não consegui copiar sozinho. Selecione o caminho acima e copie com Ctrl+C.';

// ---------- usage ----------

export const USAGE_NOTE = 'O custo em dólar só aparece quando o motor informa. Planos por assinatura não têm custo por uso.';
export const COST_UNKNOWN = 'não informado pelo motor';

export function costText(cost: number, known: boolean): string {
  return known ? formatUsd(cost) : COST_UNKNOWN;
}

export function periodLabel(days: number): string {
  return `${days} dias`;
}

/** Whether any agent of the window reported a cost (the total is only money then). */
export function usageCostKnown(usage: Usage): boolean {
  return usage.agents.some((a) => a.cost_known);
}

export function lastRunText(iso: string | null): string {
  return iso ? formatTime(iso) || 'nunca' : 'nunca';
}

/** The text alternative of one bar. */
export function barText(date: string, runs: number): string {
  return `${shortDay(date)}: ${runsLabel(runs)}`;
}

/** One sentence for the whole chart. */
export function chartSummary(days: Usage['by_day']): string {
  const total = days.reduce((n, d) => n + d.runs, 0);
  if (days.length === 0 || total === 0) return 'Nenhuma execução neste período.';
  const peak = days.reduce((best, d) => (d.runs > best.runs ? d : best), days[0]);
  return `${runsLabel(total)} em ${days.length} dias. O dia com mais execuções foi ${shortDay(peak.date)}, com ${peak.runs}.`;
}

// ---------- undo of a team ----------

export const UNDO_LABEL = 'Desfazer a criação';

export const UNDO_CONFIRM_TITLE = 'Desfazer a criação do time';
export function undoConfirmMessage(): string {
  return 'Os agentes deste time que ainda não foram usados são apagados, com as rotinas e o histórico deles. Os que já conversaram são arquivados, não apagados. A pasta de cada agente no disco fica.';
}

export function undoErrorSentence(status: number | null, code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (status === 409 && c === 'undo_expired') return 'O tempo para desfazer esta criação já passou.';
  if (status === 409 && c === 'already_undone') return 'Esta criação já foi desfeita.';
  if (status === 404) return 'Não encontrei esta criação. Ela pode já ter sido desfeita.';
  return 'Não consegui desfazer agora. Tente de novo em instantes.';
}

export interface UndoOutcomeLine {
  key: 'removed' | 'archived' | 'kept';
  heading: string;
  items: string[];
}

/** The three lists of an undo in words (empty lists are left out). */
export function undoOutcomeLines(result: TeamUndoResult): UndoOutcomeLine[] {
  const out: UndoOutcomeLine[] = [];
  if (result.removed.length) out.push({ key: 'removed', heading: 'Apagados', items: result.removed.map((a) => a.name) });
  if (result.archived.length) out.push({ key: 'archived', heading: 'Arquivados, porque já conversaram', items: result.archived.map((a) => a.name) });
  if (result.kept.length) out.push({ key: 'kept', heading: 'Ficaram como estavam', items: result.kept.map((a) => (a.detail ? `${a.name}: ${a.detail}` : a.name)) });
  return out;
}

/** Heading of the outcome, from what happened. */
export function undoOutcomeHeading(result: TeamUndoResult): string {
  if (result.removed.length + result.archived.length === 0 && result.kept.length > 0) return 'Nada foi desfeito';
  return result.kept.length > 0 ? 'Desfeito, com exceções' : 'Criação desfeita';
}
