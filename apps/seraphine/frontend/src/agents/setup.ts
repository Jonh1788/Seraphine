/**
 * Pure helpers of phase 6a: the first-steps screen, ready teams, the engine rows and the "Sem motor" state.
 * No React, no network.
 */
import { DEFAULT_PROVIDER, canonRuntime, providerLabel } from './lib';
import type { Agent, EngineInfo, GrantLevel, ProviderInfo, ToolGroup } from './types';

export const AREA_LABELS: Record<string, string> = {
  dia_a_dia: 'Dia a dia',
  estudos: 'Estudos',
  trabalho: 'Trabalho',
  programacao: 'Programação',
  pesquisa_escrita: 'Pesquisa e escrita',
  casa: 'Casa',
  outra: 'Outra coisa',
};

export const SETUP_STEP_LABELS = {
  areas: 'Com o que você quer ajuda?',
  engine: 'Conectar um motor',
  agents: 'Seus agentes',
} as const;
export type ScreenStep = keyof typeof SETUP_STEP_LABELS;
export const SCREEN_STEPS: readonly ScreenStep[] = ['areas', 'engine', 'agents'];

/** One sentence from the Seraphine per step (written by the app, no model call). */
export const GUIDE_SENTENCES: Record<ScreenStep, string> = {
  areas: 'Oi, eu sou a Seraphine. Me conte com o que você quer ajuda e eu sugiro os agentes certos.',
  engine: 'Agora preciso de um motor para os agentes pensarem. Use o plano que você já tem; aqui eu não peço nenhuma senha.',
  agents: 'Última etapa. Escolha um time pronto ou me conte o que você precisa. Nada é criado antes do seu clique.',
};

/** Labels of the four checklist lines on Início. */
export const CHECKLIST_LABELS: Record<string, string> = {
  areas: 'Escolher com o que você quer ajuda',
  engine: 'Conectar um motor',
  agents: 'Criar os seus agentes',
  first_reply: 'Ter a primeira conversa',
};

export function stepDone(steps: { id: string; done: boolean }[], id: string): boolean {
  return steps.some((s) => s.id === id && s.done);
}

/** The step the screen opens at: the first of areas, engine, agents that is not done (the last one when all are). */
export function currentSetupStep(steps: { id: string; done: boolean }[]): ScreenStep {
  for (const id of SCREEN_STEPS) {
    if (!stepDone(steps, id)) return id;
  }
  return 'agents';
}

/** How many of the three screen steps are done. */
export function screenStepsDone(steps: { id: string; done: boolean }[]): number {
  return SCREEN_STEPS.filter((id) => stepDone(steps, id)).length;
}

export function remainingLabel(remaining: number): string {
  if (remaining <= 0) return 'Tudo pronto';
  return remaining === 1 ? 'Falta 1 etapa' : `Faltam ${remaining} etapas`;
}

/** Ready teams whose areas meet the chosen ones come first; the order inside each group is the backend's. */
export function orderPacks<T extends { areas: string[] }>(packs: T[], areas: string[] | null | undefined): T[] {
  if (!areas || areas.length === 0) return packs;
  const mine = new Set(areas);
  const match = packs.filter((p) => p.areas.some((a) => mine.has(a)));
  const rest = packs.filter((p) => !p.areas.some((a) => mine.has(a)));
  return [...match, ...rest];
}

export function agentsCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'agente' : 'agentes'}`;
}

export function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Plain projects only: homes (the conversation of one agent) never show in a PROJETOS list. */
export function plainProjects<T extends { kind?: string }>(projects: T[]): T[] {
  return projects.filter((p) => p.kind !== 'home');
}

// ---------- engine state ----------

export interface EngineState {
  ready: boolean;
  /** What the owner does to make it ready ('' when it is). */
  how: string;
}

/**
 * Is an engine + provider pair ready to answer? Anything the page does not know about counts as ready
 * (an empty list means the lists did not load: never scare the owner with a guess).
 */
export function engineState(
  engine: string | null | undefined,
  provider: string | null | undefined,
  engines: EngineInfo[],
  providers: ProviderInfo[],
): EngineState {
  const rt = canonRuntime(engine);
  const eng = engines.find((e) => canonRuntime(e.name) === rt);
  const prov = providers.find((p) => p.id === (provider ?? DEFAULT_PROVIDER[rt]));
  if (eng && !eng.available) {
    return { ready: false, how: prov?.how?.trim() || eng.reason?.trim() || 'O motor deste agente não está disponível neste computador.' };
  }
  if (prov && !prov.configured) {
    return { ready: false, how: prov.how?.trim() || prov.reason?.trim() || 'O provedor deste agente ainda não está pronto.' };
  }
  return { ready: true, how: '' };
}

export function agentEngineState(agent: Pick<Agent, 'engine' | 'provider'>, engines: EngineInfo[], providers: ProviderInfo[]): EngineState {
  return engineState(agent.engine, agent.provider, engines, providers);
}

export interface EngineRow {
  id: 'claude' | 'chatgpt' | 'local' | 'api';
  name: string;
  hint: string;
  /** Can be tested with the bridge test (Claude Code and Codex). */
  testEngine: string | null;
  ready: boolean;
  /** Chip word: Pronto, Não conectado, Falta a chave, Sem resposta. */
  chip: string;
  how: string;
  /** What a default choice on this row writes. */
  choice: { engine: string; provider: string };
}

const HOW_FALLBACK = 'Ainda não está pronto neste computador.';

/** The four ways to connect a motor, in the contract's order, built from the lists the store already has. */
export function buildEngineRows(engines: EngineInfo[], providers: ProviderInfo[]): EngineRow[] {
  const engineOk = (name: string): boolean => engines.find((e) => e.name === name)?.available !== false;
  const engineReason = (name: string): string => (engineOk(name) ? '' : (engines.find((e) => e.name === name)?.reason?.trim() ?? ''));
  const byId = (id: string): ProviderInfo | undefined => providers.find((p) => p.id === id);
  // One sentence written here (not the backend's, one per provider) for the rows that group several providers.
  const localHow = (list: ProviderInfo[]): string =>
    list.length > 1 ? 'Abra o Ollama ou o LM Studio neste PC.' : list[0]?.how?.trim() || list[0]?.reason?.trim() || HOW_FALLBACK;
  const API_HOW = 'Ponha a chave do provedor no arquivo de configuração do servidor e reinicie a Seraphine.';

  const claude = byId('anthropic');
  const claudeReady = !!claude?.configured && engineOk('claude_code');
  const gpt = byId('openai');
  const gptReady = !!gpt?.configured && engineOk('codex');
  const local = providers.filter((p) => p.kind === 'local');
  const localOk = local.find((p) => p.configured);
  const keys = providers.filter((p) => p.kind === 'api_key');
  const keyOk = keys.find((p) => p.configured);

  return [
    {
      id: 'claude',
      name: 'Plano do Claude (Claude Code)',
      hint: 'Usa o plano do Claude que você já tem, entrando com a sua conta neste PC.',
      testEngine: 'claude_code',
      ready: claudeReady,
      chip: claudeReady ? 'Pronto' : 'Não conectado',
      how: claudeReady ? '' : claude?.how?.trim() || engineReason('claude_code') || claude?.reason?.trim() || HOW_FALLBACK,
      choice: { engine: 'claude_code', provider: 'anthropic' },
    },
    {
      id: 'chatgpt',
      name: 'Plano do ChatGPT (Codex)',
      hint: 'Usa o plano do ChatGPT que você já tem, entrando com a sua conta neste PC.',
      testEngine: 'codex',
      ready: gptReady,
      chip: gptReady ? 'Pronto' : 'Não conectado',
      how: gptReady ? '' : gpt?.how?.trim() || engineReason('codex') || gpt?.reason?.trim() || HOW_FALLBACK,
      choice: { engine: 'codex', provider: 'openai' },
    },
    {
      id: 'local',
      name: 'Modelos locais',
      hint: 'Rodam neste PC, sem plano nem chave. Só conversam.',
      testEngine: null,
      ready: !!localOk,
      chip: localOk ? 'Pronto' : 'Sem resposta',
      how: localOk ? '' : localHow(local),
      choice: { engine: 'chat', provider: localOk?.id ?? local[0]?.id ?? 'ollama' },
    },
    {
      id: 'api',
      name: 'Chaves de API',
      hint: 'Você paga pelo uso, direto ao provedor. Só conversam.',
      testEngine: null,
      ready: !!keyOk,
      chip: keyOk ? 'Pronto' : 'Falta a chave',
      how: keyOk ? '' : API_HOW,
      choice: { engine: 'chat', provider: keyOk?.id ?? keys[0]?.id ?? 'openrouter' },
    },
  ];
}

/** The row marked as default: the saved default when it is still ready, else the first ready one. */
export function defaultRowId(rows: EngineRow[], saved: { engine: string; provider: string | null } | null | undefined): EngineRow['id'] | null {
  const ready = rows.filter((r) => r.ready);
  if (saved) {
    const match = ready.find(
      (r) => canonRuntime(r.choice.engine) === canonRuntime(saved.engine) && (r.choice.engine === 'chat' || r.choice.provider === saved.provider),
    );
    if (match) return match.id;
  }
  return ready[0]?.id ?? null;
}

/** The engine a new agent will use, in the owner's words. */
export function engineChoiceLabel(engine: string | null | undefined, provider: string | null | undefined, providers: ProviderInfo[] = []): string {
  const rt = canonRuntime(engine);
  if (rt === 'claude_code') return 'Plano do Claude (Claude Code)';
  if (rt === 'codex') return 'Plano do ChatGPT (Codex)';
  return provider ? `${providerLabel(provider, providers)} (só conversa)` : 'Só conversa';
}

/** The pair a new agent gets when nothing says otherwise (the contract's own fallback). */
export function teamEngine(setup: { default_engine: { engine: string; provider: string | null } | null } | null | undefined): {
  engine: string;
  provider: string | null;
} {
  return setup?.default_engine ?? { engine: 'claude_code', provider: 'anthropic' };
}

const LEVEL_WORDS: Record<GrantLevel, string> = { none: 'sem acesso', read: 'só leitura', write: 'leitura e escrita' };

/** One line for an access that was lowered to the ceiling. */
export function loweredLine(l: { name: string; group: string; asked: GrantLevel; got: GrantLevel }, groups: ToolGroup[]): string {
  const label = groups.find((g) => g.id === l.group)?.label ?? l.group;
  return `${l.name}: pediu ${LEVEL_WORDS[l.asked]} em ${label} e ficou com ${LEVEL_WORDS[l.got]}.`;
}
