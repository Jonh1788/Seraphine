/**
 * Pure helpers for the agents space: event reducers, step lists, labels,
 * formatting. No React, no network, so they are cheap to unit-test.
 */
import type {
  Agent,
  AgentAction,
  Approval,
  BridgeEngineStatus,
  BridgeTestResult,
  EngineInfo,
  GrantLevel,
  Grants,
  HarnessEvent,
  Message,
  ProviderInfo,
  ReasoningEffort,
  RiskLevel,
  Run,
  RunLimit,
  RunStatus,
  TaskPriority,
  TaskStatus,
  ToolGroup,
  WaitKind,
} from './types';
import { ACTIVE_RUN_STATUSES, INTERRUPTED_ERRORS, RUN_LIMIT_ERRORS, WAIT_KINDS } from './types';

// ---------- labels ----------

export const ENGINE_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  chat: 'Só conversa',
  ollama: 'Só conversa', // legacy name of the chat runtime
};
export const ENGINE_ORDER = ['codex', 'claude_code', 'chat'];

/** "Como ele trabalha": the runtime choices, in the words of the owner. */
export const RUNTIME_OPTIONS: { value: string; label: string }[] = [
  { value: 'codex', label: 'Age nos arquivos (Codex)' },
  { value: 'claude_code', label: 'Age nos arquivos (Claude Code)' },
  { value: 'chat', label: 'Só conversa' },
];

/** The backend still accepts (and old rows may hold) `ollama` for `chat`. */
export function canonRuntime(name: string | null | undefined): string {
  return name === 'ollama' ? 'chat' : (name ?? '');
}

export function engineLabel(name: string | null | undefined): string {
  if (!name) return 'motor padrão';
  return ENGINE_LABELS[name] ?? name;
}

export function runtimeOptionLabel(name: string): string {
  return RUNTIME_OPTIONS.find((o) => o.value === canonRuntime(name))?.label ?? engineLabel(name);
}

/** Provider each runtime uses when the owner does not pick one (mirrors the backend). */
export const DEFAULT_PROVIDER: Record<string, string> = {
  codex: 'openai',
  claude_code: 'anthropic',
  chat: 'ollama',
};

const PROVIDER_SHORT: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  moonshot: 'Kimi',
  xai: 'xAI',
  gemini: 'Gemini',
  groq: 'Groq',
};

/** Short provider name for cards and metadata lines ("OpenAI (login do Codex)" -> "OpenAI"). */
export function providerLabel(id: string | null | undefined, providers: ProviderInfo[] = []): string {
  if (!id) return '';
  const found = providers.find((p) => p.id === id);
  if (found) return found.label.replace(/\s*\(.*\)\s*$/, '');
  return PROVIDER_SHORT[id] ?? id;
}

/** "Codex · OpenAI · modelo": runtime, provider and model (parts that are unknown are left out). */
export function targetLine(
  t: { engine: string | null | undefined; provider?: string | null; model?: string | null },
  providers: ProviderInfo[] = [],
): string {
  return [engineLabel(canonRuntime(t.engine)), providerLabel(t.provider, providers), t.model ?? '']
    .filter(Boolean)
    .join(' · ');
}

/** Providers the runtime can use, in catalog order. */
export function providersForRuntime(providers: ProviderInfo[], runtime: string): ProviderInfo[] {
  const rt = canonRuntime(runtime);
  return providers.filter((p) => p.runtimes.includes(rt));
}

/** Only the runtimes that drive a coding CLI take a reasoning-effort setting. */
export function supportsEffort(runtime: string): boolean {
  const rt = canonRuntime(runtime);
  return rt === 'codex' || rt === 'claude_code';
}

export const EFFORT_OPTIONS: { value: '' | ReasoningEffort; label: string }[] = [
  { value: '', label: 'Padrão' },
  { value: 'low', label: 'Baixo' },
  { value: 'medium', label: 'Médio' },
  { value: 'high', label: 'Alto' },
];

/** Reason shown next to a provider the owner cannot pick yet ('' when usable). */
export function providerOptionLabel(p: ProviderInfo): string {
  return p.configured ? p.label : `${p.label} (${p.reason || 'indisponível'})`;
}

// ---------- tools and access (step 3b) ----------

/**
 * The levels of the access control, in order. Which of them a group shows is up to the group (`ToolGroup.levels`):
 * "Ler e escrever" only appears where the catalogue says the group has tools that write.
 */
export const GRANT_OPTIONS: { value: GrantLevel; label: string }[] = [
  { value: 'none', label: 'Sem acesso' },
  { value: 'read', label: 'Ler' },
  { value: 'write', label: 'Ler e escrever' },
];

/** The levels a group offers, in the order of `GRANT_OPTIONS`. */
export function groupLevelOptions(group: Pick<ToolGroup, 'levels'>): typeof GRANT_OPTIONS {
  return GRANT_OPTIONS.filter((o) => group.levels.includes(o.value));
}

/** Closing sentence of "Ferramentas e acesso": what the owner decides, and what no choice here can open. */
export const TOOLS_FIXED_NOTE =
  'Ler e escrever dependem da sua escolha em cada grupo. Nada aqui deixa um agente apagar, enviar algo para fora do seu computador ou gastar dinheiro.';

/**
 * What the agent will be able to do in a group set to "Ler e escrever", from the labels of that group's tools that write
 * (the raw tool names never reach the screen). Null when the group has none.
 */
export function writeAccessLine(group: Pick<ToolGroup, 'tools'>): string | null {
  const labels = group.tools.filter((t) => t.level === 'write').map((t) => lowerFirst(t.label.trim())).filter(Boolean);
  if (labels.length === 0) return null;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
  return `Aqui o agente poderá ${list}. Cada coisa que ele escrever aparece na conversa e você pode desfazer por alguns minutos.`;
}

/** What an agent has in a group: what was recorded, else the catalogue's default for that group. */
export function grantLevel(grants: Grants | undefined, group: ToolGroup): GrantLevel {
  return grants?.[group.id] ?? group.default;
}

/** The groups' levels as the owner sees them, for the whole catalogue. */
export function effectiveGrants(grants: Grants | undefined, groups: ToolGroup[]): Grants {
  const out: Grants = {};
  for (const g of groups) out[g.id] = grantLevel(grants, g);
  return out;
}

/** The conversation-only engine gets no tools from the Seraphine in this version (the page offers nothing it cannot use). */
export function engineUsesTools(engine: string | null | undefined, engines: EngineInfo[] = []): boolean {
  if (canonRuntime(engine) === 'chat') return false;
  return engines.find((e) => e.name === engine)?.can_act !== false;
}

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Roster line: "Lê: notas, wiki", or that nothing is open. Null while the catalogue is not known. */
export function grantsSummary(agent: Pick<Agent, 'engine' | 'grants'>, groups: ToolGroup[], engines: EngineInfo[] = []): string | null {
  if (groups.length === 0) return null;
  if (!engineUsesTools(agent.engine, engines)) return 'Só conversa: sem ferramentas da Seraphine';
  const names = (level: GrantLevel): string[] => groups.filter((g) => grantLevel(agent.grants, g) === level).map((g) => lowerFirst(g.label));
  const read = names('read');
  const write = names('write');
  const parts = [read.length ? `Lê: ${read.join(', ')}` : '', write.length ? `Lê e escreve: ${write.join(', ')}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Sem acesso às ferramentas da Seraphine';
}

/** A refused level or group (422) in words; the backend's own text is validation jargon. */
export function grantsErrorMessage(status: number | null): string | null {
  return status === 422 ? 'Não consegui salvar o que este agente pode consultar: alguma das opções não é aceita. Revise e tente de novo.' : null;
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'na fila',
  running: 'trabalhando',
  waiting_approval: 'espera você',
  parked: 'em espera',
  done: 'feito',
  failed: 'falhou',
  cancelled: 'parado',
};

/** The backend restarted while this run was working (it is not a failure of the agent). */
export function isInterrupted(run: Pick<Run, 'status' | 'error'>): boolean {
  return run.status === 'failed' && !!run.error && INTERRUPTED_ERRORS.includes(run.error);
}

/** The limit that ended this run (step 1d), or null when it did not end by a limit. */
export function runLimitOf(run: Pick<Run, 'status' | 'error'>): RunLimit | null {
  return run.status === 'failed' && !!run.error && (RUN_LIMIT_ERRORS as readonly string[]).includes(run.error) ? (run.error as RunLimit) : null;
}

/** Chip wording of a run the harness stopped at a limit: its own word, never "falhou". */
export const RUN_LIMIT_LABELS: Record<RunLimit, string> = {
  step_limit: 'Limite de ações',
  stuck_loop: 'Travou',
  engine_silent: 'Sem resposta',
  turn_timeout: 'Tempo esgotado',
};

/** Words of the stopped-at-a-limit card: what happened, what the owner can do (with and without "Continuar"), and a short hint for plain error lines. */
export const RUN_LIMIT_COPY: Record<RunLimit, { what: string; canContinue: string; hint: string }> = {
  step_limit: {
    what: 'O agente chegou ao limite de ações para um único trabalho, então a Seraphine o parou.',
    canContinue: 'O que ele já fez ficou guardado: toque em "Continuar" se quiser que ele siga em frente.',
    hint: 'O que ele já fez ficou guardado. Se quiser, continue o trabalho.',
  },
  stuck_loop: {
    what: 'O agente ficou repetindo o mesmo passo sem chegar a lugar nenhum, então a Seraphine parou o trabalho.',
    canContinue: 'Confira o que ele fez e, se quiser tentar de novo, toque em "Continuar" ou explique o pedido de outro jeito na conversa.',
    hint: 'Confira o que ele fez antes de continuar ou de pedir de outro jeito.',
  },
  engine_silent: {
    what: 'O motor do agente ficou muito tempo sem responder, então a Seraphine encerrou o trabalho.',
    canContinue: 'O que ele já fez ficou guardado: toque em "Continuar" para tentar de novo de onde parou.',
    hint: 'O que ele já fez ficou guardado. Se quiser, continue o trabalho.',
  },
  turn_timeout: {
    what: 'O trabalho durou tempo demais de uma vez só, então a Seraphine o encerrou.',
    canContinue: 'O que ele já fez ficou guardado: toque em "Continuar" para seguir de onde parou.',
    hint: 'O que ele já fez ficou guardado. Se quiser, continue o trabalho.',
  },
};

/** "1 ação" / "12 ações"; '' when there is nothing to count. */
export function actionsLabel(count: number | null | undefined): string {
  const n = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return '';
  return n === 1 ? '1 ação' : `${n} ações`;
}

/** The engine in the owner's words ("Codex", "Claude Code"); a conversation-only or unknown engine is just "motor". */
export function engineName(engine: string | null | undefined): string {
  return !engine || canonRuntime(engine) === 'chat' ? 'motor' : engineLabel(engine);
}

type StatusRun = Pick<Run, 'status' | 'error'> &
  Partial<Pick<Run, 'engine' | 'wait_kind' | 'wait_until' | 'wait_detail' | 'wait_exact'>>;

const clean = (s: string | null | undefined): string => (typeof s === 'string' ? s.trim() : '');

/**
 * Word and tone of a run's status chip: an interrupted run reads "Interrompida", never "falhou".
 * A parked run names the reason (`label`) and, in `detail`, when it comes back or what the owner has to do.
 * Only the login case (`parked-auth`) waits on the owner; the others are neutral.
 */
export function runStatusView(run: StatusRun, now: Date = new Date()): { label: string; tone: string; detail?: string } {
  if (isInterrupted(run)) return { label: 'Interrompida', tone: 'interrupted' };
  const limit = runLimitOf(run);
  if (limit) return { label: RUN_LIMIT_LABELS[limit], tone: 'limit' };
  if (run.status === 'parked') {
    const when = whenPhrase(run.wait_until, now);
    switch (run.wait_kind) {
      case 'outage':
        return { label: 'Provedor fora do ar', tone: 'parked', detail: when ? `nova tentativa ${when}` : 'tentando de novo em breve' };
      case 'plan_limit':
        // `wait_exact`: the provider gave the real reset time; otherwise it is only the next check.
        return {
          label: 'Limite do plano atingido',
          tone: 'parked',
          detail: when ? (run.wait_exact ? `volta ${when}` : `nova verificação ${when}`) : 'verificando de novo em breve',
        };
      case 'auth':
        // The backend's sentence knows the real cause (expired login, missing key); the generic one is only a fallback.
        return { label: 'Esperando você', tone: 'parked-auth', detail: clean(run.wait_detail) || `o login do ${engineName(run.engine)} expirou` };
      case 'owner_input':
        return { label: 'Esperando você', tone: 'parked-auth', detail: 'fez uma pergunta' };
      default:
        return { label: RUN_STATUS_LABELS.parked, tone: 'parked' };
    }
  }
  return { label: RUN_STATUS_LABELS[run.status], tone: run.status };
}

export interface ParkingCopy {
  /** What happened. */
  first: string;
  /** When the work comes back, or what the owner needs to do. */
  second: string;
  /** Quieter extra line (the backend's `wait_detail`) when it adds something to the two sentences above. */
  extra?: string;
  /** `auth` is the only case that needs the owner first: its button is the primary one. */
  primary: boolean;
  button: string;
}

/** Text of the parking card (calm: what happened, then when it comes back or what to do). Null when the reason is unknown. */
export function parkingCopy(
  run: Pick<Run, 'engine' | 'wait_kind' | 'wait_until'> & Partial<Pick<Run, 'wait_detail' | 'wait_exact'>>,
  agentName: string,
  now: Date = new Date(),
): ParkingCopy | null {
  const when = whenPhrase(run.wait_until, now);
  const detail = clean(run.wait_detail);
  switch (run.wait_kind) {
    case 'outage': {
      const first = `O provedor de IA que ${agentName} usa está fora do ar. O trabalho não foi perdido.`;
      const second = `A Seraphine tenta de novo ${when || 'em breve'} e continua de onde parou.`;
      return { first, second, extra: detail && detail !== first && detail !== second ? detail : undefined, primary: false, button: 'Tentar agora' };
    }
    case 'plan_limit': {
      const first = `O limite de uso do plano acabou. O trabalho de ${agentName} está guardado.`;
      const second =
        run.wait_exact && when
          ? `O trabalho volta sozinho ${when} e continua de onde parou.`
          : `A Seraphine confere de novo ${when || 'em breve'} e continua de onde parou.`;
      return { first, second, extra: detail && detail !== first && detail !== second ? detail : undefined, primary: false, button: 'Tentar agora' };
    }
    case 'auth': {
      // The cause is not always an expired login (it can be a missing key): the backend's sentence leads when present.
      const engine = engineName(run.engine);
      return {
        first: detail || `O login do ${engine} expirou, então ${agentName} não consegue continuar. O trabalho está guardado.`,
        second: 'Resolva isso e depois toque em "Tentar de novo". O trabalho continua de onde parou.',
        primary: true,
        button: 'Tentar de novo',
      };
    }
    default:
      return null;
  }
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'A fazer',
  doing: 'Em andamento',
  review: 'Em revisão',
  done: 'Feito',
  cancelled: 'Cancelada',
};
export const TASK_STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'review', 'done', 'cancelled'];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
};
export const PRIORITY_ORDER: TaskPriority[] = ['high', 'medium', 'low'];

export function isActiveRun(run: Pick<Run, 'status'>): boolean {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}

// ---------- role presets ----------

export interface RolePreset {
  id: string;
  label: string;
  role: string;
  instructions: string;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'codigo',
    label: 'Código',
    role: 'Código',
    instructions:
      'Você cuida do código deste projeto. Investigue antes de mudar, rode os testes e explique em uma frase o que achou. Nunca faça deploy sem pedir aprovação.',
  },
  {
    id: 'infra',
    label: 'Infra',
    role: 'Infra',
    instructions:
      'Você cuida do servidor e da infraestrutura. Leia logs e estados antes de sugerir qualquer mudança, explique o que viu em linguagem simples e peça aprovação antes de reiniciar, apagar ou alterar algo em produção.',
  },
  {
    id: 'pesquisa',
    label: 'Pesquisa',
    role: 'Pesquisa',
    instructions:
      'Você pesquisa e resume. Busque fontes confiáveis, compare as opções e entregue um resumo curto com o que importa e o que ainda está em aberto. Não altere arquivos.',
  },
  {
    id: 'conteudo',
    label: 'Conteúdo',
    role: 'Conteúdo',
    instructions:
      'Você escreve e revisa os textos do projeto: posts, páginas e mensagens. Mantenha o tom do dono, proponha a versão final e nunca publique nada sem pedir aprovação.',
  },
];

export const AGENT_COLORS = ['#f2a65a', '#7fb2ff', '#6fdcaa', '#f29bc0', '#9a93ff'];

// ---------- formatting ----------

const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });

export function formatUsd(value: number | null | undefined): string {
  return usd.format(Number.isFinite(value as number) ? (value as number) : 0);
}

const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Parse a backend timestamp (ISO-8601 UTC). A value with no zone is read as UTC, never as local time. */
export function parseIsoUtc(iso: string | null | undefined): Date | null {
  if (!iso || typeof iso !== 'string') return null;
  let text = iso.trim();
  if (NAIVE_ISO.test(text) && !HAS_ZONE.test(text)) text = `${text.replace(' ', 'T')}Z`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The one way the agents space shows a time: the viewer's local `HH:mm` (24h),
 * prefixed with `dd/MM` (plus the year when it is not this year) when the day is not today.
 * Missing or invalid input gives ''.
 */
export function formatTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseIsoUtc(iso);
  if (!d) return '';
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hm;
  }
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${hm}` : `${date}/${d.getFullYear()} ${hm}`;
}

// ---------- message text ----------

export type InlinePart = { kind: 'text' | 'code'; value: string };
export type MessageBlock =
  | { kind: 'paragraph'; parts: InlinePart[] }
  | { kind: 'fence'; code: string; lang: string };

/** Backtick spans become code parts; an unmatched or empty backtick stays literal text. Never produces HTML. */
export function splitInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > i + 1) {
        if (buf) parts.push({ kind: 'text', value: buf });
        buf = '';
        parts.push({ kind: 'code', value: text.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  if (buf) parts.push({ kind: 'text', value: buf });
  return parts;
}

const FENCE = /```([\w+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/** Split message text into paragraphs (inline formatting) and fenced code blocks. */
export function parseMessageText(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const pushText = (chunk: string): void => {
    const t = chunk.replace(/^(?:[ \t]*\r?\n)+|\s+$/g, '');
    if (t) blocks.push({ kind: 'paragraph', parts: splitInline(t) });
  };
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const at = m.index ?? 0;
    pushText(text.slice(last, at));
    blocks.push({ kind: 'fence', lang: m[1] ?? '', code: m[2] ?? '' });
    last = at + m[0].length;
  }
  pushText(text.slice(last));
  return blocks;
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Boa noite';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** "2 min", "40 s": how long a run took (or has been going). */
export function formatDuration(run: Pick<Run, 'started_at' | 'created_at' | 'finished_at'>, now = Date.now()): string {
  const start = Date.parse(run.started_at ?? run.created_at);
  if (Number.isNaN(start)) return '';
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  const secs = Math.max(0, Math.round(((Number.isNaN(end) ? now : end) - start) / 1000));
  if (secs < 60) return `${secs} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

/** Readable text color (dark or light) on top of an agent's tile color. */
export function readableOn(color: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((color ?? '').trim());
  if (!m) return '#14121f';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#14121f' : '#ffffff';
}

export function safeColor(color: string | null | undefined, fallback = '#9a93ff'): string {
  return /^#[0-9a-f]{3,8}$/i.test((color ?? '').trim()) ? (color as string).trim() : fallback;
}

export function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

// ---------- event reducers ----------

export const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'parked',
  'done',
  'failed',
  'cancelled',
];

/** Merge events into a run's list: dedupe by id; ids are monotonic, so id order is chronological. */
export function mergeEvents(existing: HarnessEvent[], incoming: HarnessEvent[]): HarnessEvent[] {
  const seen = new Map<number, HarnessEvent>();
  for (const ev of existing) seen.set(ev.id, ev);
  let changed = false;
  for (const ev of incoming) {
    if (!seen.has(ev.id)) {
      seen.set(ev.id, ev);
      changed = true;
    }
  }
  if (!changed) return existing;
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function statusFromEvent(ev: HarnessEvent): RunStatus | null {
  if (ev.kind !== 'status') return null;
  const raw = str(ev.payload.status);
  return (RUN_STATUSES as readonly string[]).includes(raw) ? (raw as RunStatus) : null;
}

/** `approval_result` payload: `decision` is `'approved' | 'denied' | 'expired'`. */
function decisionOf(payload: Record<string, unknown>): 'approved' | 'denied' | 'expired' | null {
  const raw = str(payload.decision);
  return raw === 'approved' || raw === 'denied' || raw === 'expired' ? raw : null;
}

/** A `risk_level` from the wire; anything else (events from before approvals v2) counts as medium. */
export function riskOf(value: unknown): RiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Risco baixo',
  medium: 'Risco médio',
  high: 'Risco alto',
};

/** "Expira às 14:30", or "Expira amanhã às 14:30" / "Expira em 12/11 às 14:30" when it is not today. '' without a date. */
export function expiryLine(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseIsoUtc(iso);
  if (!d) return '';
  if (d.getTime() <= now.getTime()) return `Expirou às ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `Expira ${whenPhrase(iso, now)}`;
}

/** "às 14:32", "amanhã às 09:00" or "em 12/11 às 09:00" (local time); '' without a date. Shared by expiry and parking wording. */
export function whenPhrase(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseIsoUtc(iso);
  if (!d) return '';
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(d) - day(now)) / 86_400_000);
  if (diffDays <= 0) return `às ${hm}`;
  if (diffDays === 1) return `amanhã às ${hm}`;
  return `em ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} às ${hm}`;
}

/** Sentences for the 409 codes of `POST /approvals/{id}/decide`. */
const APPROVAL_ERROR_TEXT: Record<string, string> = {
  digest_mismatch: 'O pedido mudou desde que esta tela foi carregada. Confira o comando de novo.',
  high_risk_unconfirmed: 'Este comando tem risco alto e precisa de uma segunda confirmação. Toque em "Aprovar mesmo assim".',
  approval_expired: 'Este pedido expirou. Peça ao agente para tentar de novo.',
  already_decided: 'Este pedido já foi respondido. Nada mais a fazer aqui.',
  run_not_waiting: 'O agente não está mais esperando esta resposta. Peça a ele para tentar de novo.',
};

export function approvalErrorMessage(code: string | null | undefined): string | null {
  return APPROVAL_ERROR_TEXT[(code ?? '').trim()] ?? null;
}

/** One line saying how a decided approval ended; `agent` is the name shown in the sentence. */
export function decidedLine(
  a: Pick<Approval, 'status' | 'decided_by' | 'decision_note'>,
  agent: string,
): string {
  const note = (a.decision_note ?? '').trim();
  if (a.status === 'approved') return `Você aprovou. ${agent} está seguindo com isso.`;
  if (a.status === 'expired') return 'Expirou sem resposta. Nada foi executado.';
  if (a.decided_by === 'harness') {
    return note ? `Recusado automaticamente: ${note}` : 'Recusado automaticamente. Nada foi executado.';
  }
  const base = `Você negou. ${agent} parou aqui e nada foi alterado.`;
  return note ? `${base} Motivo: ${note}` : base;
}

export interface EventSlice {
  runs: Record<string, Run>;
  approvals: Record<string, Approval>;
  eventsByRun: Record<string, HarnessEvent[]>;
}

export interface EventResult {
  patch: Partial<EventSlice>;
  /** The event refers to something we do not know yet: reload the overview. */
  refresh: boolean;
}

/** Fold one live event into runs / approvals / per-run events. Pure. */
export function reduceEvent(slice: EventSlice, ev: HarnessEvent): EventResult {
  const patch: Partial<EventSlice> = {};
  let refresh = false;
  const payload = ev.payload ?? {};

  const prior = slice.eventsByRun[ev.run_id] ?? [];
  const merged = mergeEvents(prior, [ev]);
  if (merged !== prior) patch.eventsByRun = { ...slice.eventsByRun, [ev.run_id]: merged };

  const run = slice.runs[ev.run_id];
  const status = statusFromEvent(ev);
  if (status) {
    if (run) {
      const next: Run = { ...run, status };
      if (status === 'failed' && str(payload.error)) next.error = str(payload.error);
      if (payload.reason === 'recovered' && typeof payload.recoveries === 'number' && Number.isFinite(payload.recoveries)) {
        next.recoveries = payload.recoveries;
      }
      if (status === 'parked') {
        const kind = (WAIT_KINDS as readonly unknown[]).includes(payload.wait_kind) ? (payload.wait_kind as WaitKind) : null;
        const attempts = payload.wait_attempts;
        next.wait_kind = kind;
        next.wait_until = typeof payload.wait_until === 'string' ? payload.wait_until : null;
        next.wait_detail = typeof payload.wait_detail === 'string' && payload.wait_detail.trim() ? payload.wait_detail.trim() : null;
        next.wait_exact = payload.wait_exact === true;
        next.wait_attempts = typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0 ? attempts : run.wait_attempts;
        // The question lives on the run row: a run parked for an answer that we do not know yet is reloaded.
        if (kind !== 'owner_input') next.question = null;
        else if (!next.question) refresh = true;
        // The first parking of a sequence starts it; later ones keep the original instant.
        next.wait_since = next.wait_attempts <= 1 ? ev.ts : (run.wait_since ?? ev.ts);
        // An unknown reason cannot be worded: load the real row.
        if (!kind) refresh = true;
      } else {
        // Back in the queue (`reason: 'woke'`), running again or finished: nothing is waited for any more.
        next.wait_kind = null;
        next.wait_until = null;
        next.wait_detail = null;
        next.wait_exact = false;
        next.wait_attempts = 0;
        next.question = null;
      }
      if (!ACTIVE_RUN_STATUSES.includes(status) && !next.finished_at) next.finished_at = ev.ts;
      patch.runs = { ...slice.runs, [ev.run_id]: next };
    } else {
      refresh = true;
    }
  }

  if (ev.kind === 'approval_request') {
    const id = str(payload.approval_id);
    if (id && (str(payload.title) || str(payload.command))) {
      const existing = slice.approvals[id];
      // The event carries no agent/project: they come from the run (refresh fills gaps).
      const approval: Approval = {
        id,
        run_id: ev.run_id,
        agent_id: run?.agent_id ?? '',
        project_id: run?.project_id ?? '',
        title: str(payload.title) || str(payload.command),
        command: str(payload.command),
        reason: str(payload.reason),
        status: 'pending',
        output: null,
        created_at: ev.ts,
        decided_at: null,
        // Events recorded before approvals v2 lack these: medium risk, no reasons, no expiry.
        risk_level: riskOf(payload.risk_level),
        risk_reasons: Array.isArray(payload.risk_reasons)
          ? payload.risk_reasons.filter((r): r is string => typeof r === 'string')
          : [],
        command_digest: str(payload.digest),
        expires_at: str(payload.expires_at) || null,
        decided_by: null,
        decision_note: null,
      };
      patch.approvals = { ...slice.approvals, [id]: existing ?? approval };
      // Without a digest the card cannot approve: load the real row.
      if (!approval.command_digest) refresh = true;
    } else {
      refresh = true;
    }
  }

  if (ev.kind === 'approval_result') {
    const id = str(payload.approval_id);
    const decision = decisionOf(payload);
    const existing = id ? slice.approvals[id] : undefined;
    if (existing && decision) {
      patch.approvals = {
        ...slice.approvals,
        [id]: {
          ...existing,
          status: decision,
          decided_at: ev.ts,
          decided_by: payload.decided_by === 'harness' ? 'harness' : payload.decided_by === 'owner' ? 'owner' : existing.decided_by,
          decision_note: typeof payload.note === 'string' ? payload.note.trim() || null : existing.decision_note,
        },
      };
    } else {
      refresh = true;
    }
  }

  return { patch, refresh };
}

// ---------- step list ----------

export type StepKind = 'step' | 'command' | 'message' | 'error' | 'approval' | 'system';

/**
 * `note` steps the backend writes about the run itself (resumed, parked, back, messages read, stopped by the owner):
 * shown as quiet system lines.
 */
export type SystemNoteReason =
  | 'recovered'
  | 'parked'
  | 'woke'
  | 'inbox'
  | 'interrupted_by_owner'
  | 'limit_warning'
  | 'limit_stop'
  | 'tool_denied'
  | 'bridge_unavailable'
  | 'action_undone'
  | 'asked_owner'
  | 'session';
const SYSTEM_NOTE_REASONS: readonly unknown[] = [
  'recovered',
  'parked',
  'woke',
  'inbox',
  'interrupted_by_owner',
  'limit_warning',
  'limit_stop',
  'tool_denied',
  'bridge_unavailable',
  'action_undone',
  'asked_owner',
  'session',
];

/** `running`: an action that started and has no end yet; `unfinished`: it never ended and the run did. */
export type StepState = 'done' | 'running' | 'unfinished';

export interface Step {
  id: string;
  kind: StepKind;
  text: string;
  ts: string;
  state: StepState;
  /** For `system` lines: what the backend's note was about. */
  reason?: SystemNoteReason;
  /** From the `command` event that ended a command line. */
  exitCode?: number | null;
  output?: string;
  /** For a use of the Seraphine's tools (step 3b): the group it belongs to (notes, wiki, memory...). */
  group?: string;
  /** Short result of a finished tool call (quiet text under the line). */
  summary?: string;
  /** A tool call that ended badly; `error` is the sentence that says why. */
  failed?: boolean;
  error?: string;
  /** A write that went through (step 3c): the line is a receipt. `actionId`/`undoUntil` come with the finished call. */
  receipt?: boolean;
  actionId?: string;
  undoUntil?: string;
  /** The note that an undo happened was seen in the run's events. */
  undone?: boolean;
  /** For `action_undone` system lines: which action. */
  forAction?: string;
  /** For `session` system lines: continuing the previous conversation, or a new one (the icon follows it). */
  sessionMode?: 'continued' | 'fresh_with_history';
}

/** Backup wording of the "how the conversation began" line, used only when the note carries no text. */
export function sessionLine(mode: unknown): string {
  return mode === 'continued'
    ? 'O agente está continuando a conversa anterior'
    : 'É uma conversa nova, e o agente recebeu o histórico recente';
}

/** Shown when a tool line carries no `label` of its own. */
export const TOOL_LINE_FALLBACK = 'Consultou uma ferramenta da Seraphine';
export const TOOL_FAILED_FALLBACK = 'Não deu certo';

/** One-line text for a step payload (`note`/`reasoning`, `file_change`, `web_search`, `tool_use`, `tool_call`). */
function stepText(p: Record<string, unknown>): string {
  const text = str(p.text);
  if (text) return text;
  switch (str(p.type)) {
    case 'file_change': {
      const changes = Array.isArray(p.changes) ? p.changes : [];
      const paths = changes
        .map((c) => (c && typeof c === 'object' ? str((c as Record<string, unknown>).path) : ''))
        .filter(Boolean);
      if (paths.length === 0) return 'Alterou arquivos';
      const shown = paths.slice(0, 3).join(', ');
      return `Alterou ${shown}${paths.length > 3 ? ` e mais ${paths.length - 3}` : ''}`;
    }
    case 'web_search':
      return str(p.query) ? `Pesquisou: ${str(p.query)}` : 'Fez uma pesquisa na web';
    case 'tool_use': {
      const tool = str(p.tool);
      const target = str(p.target);
      return [tool, target].filter(Boolean).join(' ');
    }
    case 'tool_call':
      return str(p.tool);
    case 'seraphine_tool':
      // The raw tool name is never shown: only the sentence the backend wrote.
      return str(p.label);
    case 'command':
      return str(p.command);
    default:
      return '';
  }
}

/** The extra fields of a `seraphine_tool` step, copied onto its line (nothing for any other step). */
function toolFields(p: Record<string, unknown>, completed: boolean): Partial<Step> {
  if (str(p.type) !== 'seraphine_tool') return {};
  const out: Partial<Step> = {};
  if (str(p.group)) out.group = str(p.group);
  if (completed) {
    if (str(p.summary)) out.summary = str(p.summary);
    if (p.ok === false) {
      out.failed = true;
      if (str(p.error)) out.error = str(p.error);
    } else if (p.read_only === false) {
      out.receipt = true;
      if (str(p.action_id)) out.actionId = str(p.action_id);
      if (str(p.undo_until)) out.undoUntil = str(p.undo_until);
    }
  }
  return out;
}

/** Mirrors the backend's `strip_approval_blocks`: the raw `message` event still carries the fenced request. */
const APPROVAL_BLOCK = /```approval-request[ \t]*\r?\n(.*?)\r?\n?```/gs;

/** Human text of an event, by `kind` (see the payload table in types.ts). */
export function eventText(ev: HarnessEvent): string {
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case 'step':
      return stepText(p);
    case 'message':
      return str(typeof p.text === 'string' ? p.text.replace(APPROVAL_BLOCK, '') : '');
    case 'command':
      return str(p.command);
    case 'approval_request':
    case 'approval_result':
      return str(p.title) || str(p.command);
    case 'error':
      return str(p.message);
    case 'status':
      return p.error ? runErrorMessage(str(p.error)).text : '';
    default:
      return '';
  }
}

/** "Retomada depois de um reinício", with the count from the second time on. */
export function recoveredLine(recoveries: unknown): string {
  const n = typeof recoveries === 'number' && Number.isFinite(recoveries) ? recoveries : 0;
  return n >= 2 ? `Retomada depois de um reinício (${n}ª vez)` : 'Retomada depois de um reinício';
}

/** Backup wording of the "agent read the inbox" line, used only when the note carries no text. */
export function inboxLine(count: unknown): string {
  const n = typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
  if (n === 0) return 'Leu mensagens novas';
  return n === 1 ? 'Leu 1 mensagem nova' : `Leu ${n} mensagens novas`;
}

/**
 * Turn a run's events into the "O que ele fez" list (status events are not steps; the
 * automatic resume is the backend's `note` step carrying `reason: 'recovered'`, shown as a system line).
 *
 * An action is one line. A `step` with `phase: 'started'` and a `call_id` opens it as
 * `running`; the `completed` step with the same `call_id`, or the `command` event whose
 * `approval_id` is that id, closes that same line instead of adding another. A lone
 * `completed` is a line of its own. When `runEnded` and a line never closed, it is
 * `unfinished`. Events without `phase` or `call_id` behave as plain steps.
 */
export function buildSteps(events: HarnessEvent[], opts: { runEnded?: boolean } = {}): Step[] {
  const steps: Step[] = [];
  const byCall = new Map<string, Step>(); // call_id -> its line (running or already closed)
  for (const ev of events) {
    const base = { id: String(ev.id), ts: ev.ts, state: 'done' as StepState };
    switch (ev.kind) {
      case 'step': {
        const p = ev.payload ?? {};
        const callId = str(p.call_id);
        const phase = str(p.phase);
        const text = eventText(ev);
        const kind: StepKind = str(p.type) === 'command' ? 'command' : 'step';
        // The backend's note about an automatic resume, a parking or a return: the one discreet system line (the status event adds none).
        if (str(p.type) === 'note' && SYSTEM_NOTE_REASONS.includes(p.reason)) {
          const reason = p.reason as SystemNoteReason;
          const fallback =
            reason === 'recovered'
              ? recoveredLine(p.recoveries)
              : reason === 'parked'
                ? 'O trabalho ficou em espera'
                : reason === 'inbox'
                  ? inboxLine(p.count)
                  : reason === 'interrupted_by_owner'
                    ? 'Você parou o trabalho para mandar uma mensagem'
                    : reason === 'limit_warning'
                      ? 'O agente está perto do limite de ações deste trabalho'
                      : reason === 'limit_stop'
                        ? 'O trabalho foi parado por um limite'
                        : reason === 'tool_denied'
                          ? 'O agente tentou consultar algo que você não liberou'
                          : reason === 'bridge_unavailable'
                            ? 'As ferramentas da Seraphine não ficaram disponíveis neste trabalho'
                            : reason === 'action_undone'
                              ? 'Você desfez uma ação do agente'
                              : reason === 'asked_owner'
                                ? 'O agente fez uma pergunta a você'
                                : reason === 'session'
                                  ? sessionLine(p.mode)
                                  : 'O trabalho voltou para a fila';
          const group = str(p.group);
          const forAction = reason === 'action_undone' ? str(p.action_id) : '';
          const sessionMode = reason === 'session' ? (p.mode === 'continued' ? 'continued' : 'fresh_with_history') : null;
          steps.push({
            ...base,
            kind: 'system',
            reason,
            text: text || fallback,
            ...(group ? { group } : {}),
            ...(forAction ? { forAction } : {}),
            ...(sessionMode ? { sessionMode } : {}),
          });
          break;
        }
        const isTool = str(p.type) === 'seraphine_tool';
        if (callId && phase === 'started') {
          if (byCall.has(callId)) break;
          const line: Step = { ...base, kind, text: text || (isTool ? TOOL_LINE_FALLBACK : 'Uma ação do agente'), state: 'running', ...toolFields(p, false) };
          byCall.set(callId, line);
          steps.push(line);
        } else if (callId && phase === 'completed') {
          const line = byCall.get(callId);
          if (!line) {
            if (text || isTool) {
              const done: Step = { ...base, kind, text: text || TOOL_LINE_FALLBACK, ...toolFields(p, true) };
              byCall.set(callId, done);
              steps.push(done);
            }
          } else if (line.state === 'running') {
            // Same line, same key: it turns from "em andamento" to "feita" in place.
            line.state = 'done';
            if (text) line.text = text;
            Object.assign(line, toolFields(p, true));
          }
        } else if (text) {
          steps.push({ ...base, kind: 'step', text });
        }
        break;
      }
      case 'message': {
        const text = eventText(ev);
        if (text) steps.push({ ...base, kind: 'message', text });
        break;
      }
      case 'command': {
        const p = ev.payload ?? {};
        const cmd = str(p.command) || eventText(ev);
        // The command event ends the action named by `call_id`, or by `approval_id` when there is no call_id.
        const id = str(p.call_id) || str(p.approval_id);
        const detail = {
          exitCode: typeof p.exit_code === 'number' ? p.exit_code : null,
          output: typeof p.output === 'string' ? p.output : undefined,
        };
        const line = id ? byCall.get(id) : undefined;
        if (line) {
          if (line.state === 'running') {
            line.state = 'done';
            if (cmd) line.text = cmd;
            Object.assign(line, detail);
          }
        } else if (cmd) {
          const done: Step = { ...base, kind: 'command', text: cmd, ...detail };
          if (id) byCall.set(id, done);
          steps.push(done);
        }
        break;
      }
      case 'approval_request': {
        const what = eventText(ev) || str(ev.payload?.command);
        steps.push({ ...base, kind: 'approval', text: what ? `Pediu sua aprovação: ${what}` : 'Pediu sua aprovação' });
        break;
      }
      case 'approval_result': {
        const p = ev.payload ?? {};
        const d = decisionOf(p);
        const note = str(p.note);
        let text = 'Pedido de aprovação respondido';
        if (d === 'approved') text = 'Você aprovou';
        else if (d === 'expired') text = 'Expirou sem resposta';
        else if (d === 'denied') {
          if (p.decided_by === 'harness') text = note ? `Recusado automaticamente: ${note}` : 'Recusado automaticamente';
          else text = note ? `Você disse agora não: ${note}` : 'Você disse agora não';
        }
        steps.push({ ...base, kind: 'approval', text });
        break;
      }
      case 'error': {
        const text = eventText(ev);
        steps.push({ ...base, kind: 'error', text: text ? `Erro: ${text}` : 'Algo deu errado' });
        break;
      }
      default:
        break;
    }
  }
  if (opts.runEnded) {
    for (const line of byCall.values()) if (line.state === 'running') line.state = 'unfinished';
  }
  // The note of an undo closes the receipt it refers to (also when the action list was never loaded).
  const undone = new Set(steps.filter((s) => s.forAction).map((s) => s.forAction));
  if (undone.size) for (const s of steps) if (s.receipt && s.actionId && undone.has(s.actionId)) s.undone = true;
  return steps;
}

// ---------- project rules summary ----------

/** One line per rule, derived from the permissions of the agents that can act in the project. */
export function summarizeRules(agents: Agent[]): string[] {
  const active = agents.filter((a) => a.enabled);
  const lines = ['Ler e testar: livre'];
  if (active.length === 0) {
    lines.push('Nenhum agente tem acesso a este projeto ainda');
  } else {
    const names = (list: Agent[]): string => list.map((a) => a.name).join(', ');
    const free = active.filter((a) => a.perm_edit === 'free');
    const blockedEdit = active.filter((a) => a.perm_edit !== 'free');
    if (blockedEdit.length === 0) lines.push('Editar arquivos: livre dentro da pasta');
    else if (free.length === 0) lines.push('Editar arquivos: bloqueado');
    else lines.push(`Editar arquivos: livre dentro da pasta para ${names(free)}; bloqueado para ${names(blockedEdit)}`);

    const ask = active.filter((a) => a.perm_commands === 'ask');
    const blockedCmd = active.filter((a) => a.perm_commands !== 'ask');
    if (blockedCmd.length === 0) lines.push('Outros comandos: pedem aprovação');
    else if (ask.length === 0) lines.push('Outros comandos: bloqueados');
    else lines.push(`Outros comandos: pedem aprovação para ${names(ask)}; bloqueados para ${names(blockedCmd)}`);
  }
  lines.push('Deploy, apagar, pagar, publicar: sempre pede aprovação');
  return lines;
}

export function agentStateLabel(agent: Agent, runs: Run[]): { label: string; busy: boolean; waiting: boolean } {
  if (!agent.enabled) return { label: 'pausado', busy: false, waiting: false };
  const mine = runs.filter((r) => r.agent_id === agent.id && isActiveRun(r));
  // A run waiting for the engine's login, or for the answer to a question, waits on the owner just like an approval does.
  if (mine.some((r) => r.status === 'waiting_approval' || isWaitingForLogin(r) || isWaitingForAnswer(r))) {
    return { label: 'espera você', busy: true, waiting: true };
  }
  if (mine.some((r) => r.status !== 'parked')) return { label: 'trabalhando', busy: true, waiting: false };
  if (mine.length > 0) return { label: 'em espera', busy: true, waiting: false };
  return { label: 'livre', busy: false, waiting: false };
}

// ---------- run failure codes ----------

const RUN_ERROR_TEXT: Record<string, string> = {
  budget_exceeded: 'O orçamento diário deste agente acabou.',
  // Since the parking step this code only means "the login was not fixed within a day".
  engine_auth:
    'O login do motor do agente não foi refeito em um dia, então a Seraphine parou de esperar. Entre no motor de novo e peça o trabalho outra vez.',
  engine_unavailable: 'O motor deste agente não está disponível neste computador.',
  provider_unavailable:
    'O provedor de IA do agente ficou fora do ar por mais de um dia e a Seraphine parou de tentar. Peça o trabalho de novo quando o serviço voltar.',
  plan_limit:
    'O limite de uso do plano do agente acabou e não voltou a tempo, então a Seraphine parou de esperar. Quando o limite voltar, peça o trabalho de novo.',
  no_access: 'O agente não tem acesso a este projeto.',
  agent_unavailable: 'O agente não existe ou foi desativado.',
  project_unavailable: 'O projeto não existe ou foi arquivado.',
  invalid_project_path: 'A pasta do projeto não é válida.',
  approval_expired: 'O pedido de aprovação expirou sem resposta. Peça ao agente para tentar de novo.',
  approval_tampered: 'O comando aprovado não é mais o mesmo que você viu, então nada foi executado.',
  approval_limit: 'O agente pediu aprovações demais nesta execução.',
  session_missing: 'Não foi possível retomar a execução depois da aprovação.',
  nothing_to_resume: 'Não havia nenhuma decisão pendente para retomar.',
  interrupted:
    'A Seraphine reiniciou enquanto o agente trabalhava e não conseguiu retomar o trabalho sozinha. Peça para ele continuar de onde parou.',
  interrupted_mid_action:
    'A Seraphine reiniciou no meio de uma ação do agente, que pode ter parado pela metade. Confira o que foi feito e peça de novo.',
  owner_no_answer:
    'O agente fez uma pergunta e ficou um dia sem resposta, então a Seraphine parou de esperar. Se ainda precisar, peça o trabalho de novo.',
  engine_error: 'O motor do agente encontrou um erro.',
  step_limit: `${RUN_LIMIT_COPY.step_limit.what} ${RUN_LIMIT_COPY.step_limit.hint}`,
  stuck_loop: `${RUN_LIMIT_COPY.stuck_loop.what} ${RUN_LIMIT_COPY.stuck_loop.hint}`,
  engine_silent: `${RUN_LIMIT_COPY.engine_silent.what} ${RUN_LIMIT_COPY.engine_silent.hint}`,
  turn_timeout: `${RUN_LIMIT_COPY.turn_timeout.what} ${RUN_LIMIT_COPY.turn_timeout.hint}`,
};

/**
 * Plain pt-BR sentence for a `Run.error` code. Unknown codes get the generic
 * sentence and are returned in `code` so the UI can show them (small, mono)
 * for debugging; known codes return no `code`.
 */
export function runErrorMessage(code: string | null | undefined): { text: string; code?: string } {
  const raw = (code ?? '').trim();
  if (!raw) return { text: 'A execução falhou.' };
  const known = RUN_ERROR_TEXT[raw];
  return known ? { text: known } : { text: 'A execução falhou.', code: raw };
}

// ---------- waking a parked run ----------

/** A parked run that only the owner can free: the engine's login expired. */
export function isWaitingForLogin(run: Pick<Run, 'status' | 'wait_kind'>): boolean {
  return run.status === 'parked' && run.wait_kind === 'auth';
}

/** A parked run whose agent asked the owner a question and waits for the answer (step 3c). */
export function isWaitingForAnswer(run: Pick<Run, 'status' | 'wait_kind'>): boolean {
  return run.status === 'parked' && run.wait_kind === 'owner_input';
}

/** Sentence for a refused or failed `POST /runs/{id}/wake`; never the raw code or a server text in English. */
export function wakeErrorMessage(status: number | null, code: string | null | undefined): string {
  if (status === 409 && (code ?? '').trim() === 'not_parked') {
    return 'Este trabalho já não está em espera. Atualizei a tela com a situação atual.';
  }
  if (status === 404) return 'Não encontrei este trabalho. Ele pode ter sido removido.';
  return 'Não consegui tentar de novo agora. Tente mais uma vez em instantes.';
}

// ---------- a message in the middle of the work (step 1c) ----------

/** "1 mensagem esperando" / "2 mensagens esperando"; '' when none wait. */
export function inboxCountLabel(count: number | null | undefined): string {
  const n = typeof count === 'number' && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return '';
  return n === 1 ? '1 mensagem esperando' : `${n} mensagens esperando`;
}

/** Sentence for the 409 `inbox_full` of a message post. */
export function inboxFullMessage(agentName?: string | null): string {
  return `${clean(agentName) || 'O agente'} já tem muitas mensagens esperando. Espere ele ler ou pare o trabalho.`;
}

/** What the composer can say about the work a new message would meet. */
export type ComposerTarget =
  | { kind: 'none' }
  /** The chosen agent has an active run in this project: the message joins it. */
  | { kind: 'agent'; run: Run }
  /** Automatic routing and exactly one agent is working here: the message may join that work. */
  | { kind: 'maybe'; run: Run };

/**
 * The run a message from the composer would join. Mirrors the backend rule: only a run of the SAME project counts,
 * and `queued`, `running`, `waiting_approval` and `parked` are all active. With one specific agent that agent's active run
 * is the target (a `running` one wins if there are several, otherwise the oldest). With automatic routing the page cannot
 * know who will be picked, so a target exists only when exactly one agent is working in the project.
 */
export function composerTarget(runs: Iterable<Run>, projectId: string, agentId: string): ComposerTarget {
  const active = [...runs].filter((r) => r.project_id === projectId && isActiveRun(r));
  if (agentId !== 'auto') {
    const mine = active
      .filter((r) => r.agent_id === agentId)
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    return mine.length ? { kind: 'agent', run: mine[0] } : { kind: 'none' };
  }
  const agents = new Set(active.map((r) => r.agent_id));
  if (agents.size !== 1) return { kind: 'none' };
  const only = active.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  return { kind: 'maybe', run: only[0] };
}

/** The quiet line above the composer: who is working and when a new message is read. */
export function composerLiveLine(target: ComposerTarget, agentName: string): string {
  if (target.kind === 'none') return '';
  if (isWaitingForAnswer(target.run)) {
    return `${agentName} está esperando a sua resposta. A sua próxima mensagem responde à pergunta.`;
  }
  if (target.kind === 'maybe') {
    return `${agentName} está trabalhando neste projeto. Sua mensagem pode se juntar a esse trabalho.`;
  }
  switch (target.run.status) {
    case 'running':
      return `${agentName} está trabalhando. Ele lê sua mensagem na próxima pausa.`;
    case 'waiting_approval':
      return `${agentName} espera a sua aprovação. Ele lê sua mensagem depois que você decidir.`;
    case 'parked':
      return `O trabalho de ${agentName} está em espera. Ele lê sua mensagem quando o trabalho voltar.`;
    default:
      return `${agentName} está na fila para trabalhar. Ele lê sua mensagem assim que começar.`;
  }
}

/** Whether "Começar do zero" can be offered, and when not, the short reason (for hover and assistive technology). */
export function freshAvailability(target: ComposerTarget, agentName: string): { allowed: boolean; reason: string } {
  if (target.kind === 'agent') {
    return { allowed: false, reason: `Indisponível: ${agentName} já está trabalhando e sua mensagem se junta a esse trabalho.` };
  }
  if (target.kind === 'maybe') {
    return { allowed: false, reason: `Indisponível enquanto ${agentName} trabalha neste projeto: sua mensagem pode se juntar a esse trabalho.` };
  }
  return { allowed: true, reason: '' };
}

export const FRESH_LABEL = 'Começar do zero';
export const FRESH_HELP = 'Faz a próxima mensagem abrir uma conversa nova, sem lembrar das anteriores.';

/** The line above the composer while "Começar do zero" is on. `agentName` is empty under automatic routing. */
export function freshArmedLine(agentName: string): string {
  return agentName
    ? `A próxima mensagem começa uma conversa nova com ${agentName}. Ele não vai se lembrar das conversas anteriores.`
    : 'A próxima mensagem começa uma conversa nova. O agente que responder não vai se lembrar das conversas anteriores.';
}

/** "Parar e mandar" only makes sense while the agent is running, and only when the target is certain. */
export function canInterrupt(target: ComposerTarget): boolean {
  return target.kind === 'agent' && target.run.status === 'running';
}

/** Words of the receipt under an owner message; null shows nothing. `agentName` is who the message went to. */
export function deliveryLine(delivery: Message['delivery'], agentName: string): { text: string; tone: 'pending' | 'delivered' | 'undelivered' } | null {
  switch (delivery) {
    case 'pending':
      return { text: `Esperando a próxima pausa de ${agentName}`, tone: 'pending' };
    case 'delivered':
      return { text: `Lida por ${agentName}`, tone: 'delivered' };
    case 'undelivered':
      return { text: 'Não foi lida: o trabalho terminou antes', tone: 'undelivered' };
    default:
      return null;
  }
}

// ---------- continuing an interrupted run ----------

/** Sentences for the 409 codes of `POST /runs/{id}/continue`; anything else gets the generic one. */
export function continueErrorMessage(code: string | null | undefined, agentName = 'O agente'): string {
  const c = (code ?? '').trim();
  if (c === 'continue_not_allowed') return 'Esta execução não pode ser continuada. Confira o que foi feito e peça de novo.';
  if (c === 'already_continued') return 'Este trabalho já foi continuado. A nova execução aparece na conversa.';
  // The backend has no dedicated slug for this yet: any "busy" style code is read as the agent being occupied.
  if (c === 'agent_busy') {
    return `${agentName} está ocupado com outro trabalho agora. Tente de novo quando terminar.`;
  }
  return 'Não consegui continuar o trabalho agora. Tente de novo em instantes.';
}

// ---------- receipts and undo (step 3c) ----------

const MINUTE_MS = 60_000;

/** Time left to undo, in words: "4 min", "menos de 1 min". Empty when the window is over. */
export function undoRemainingLabel(ms: number): string {
  if (!(ms > 0)) return '';
  return ms > MINUTE_MS ? `${Math.ceil(ms / MINUTE_MS)} min` : 'menos de 1 min';
}

/** Milliseconds until the label above changes (or the window ends); null when there is nothing left to wait for. */
export function undoNextChangeIn(ms: number): number | null {
  if (!(ms > 0)) return null;
  if (ms <= MINUTE_MS) return ms;
  return ms - (Math.ceil(ms / MINUTE_MS) - 1) * MINUTE_MS;
}

/** The label of a receipt line: "Desfazer · 4 min". */
export function undoButtonLabel(ms: number): string {
  const left = undoRemainingLabel(ms);
  return left ? `Desfazer · ${left}` : 'Desfazer';
}

/** Sentences for the refusals of `POST /actions/{id}/undo` (409) and for the other failures. */
export function undoErrorMessage(status: number | null, code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (status === 409 && c === 'undo_expired') return 'O tempo para desfazer já passou.';
  if (status === 409 && c === 'already_undone') return 'Isso já foi desfeito.';
  if (status === 409 && c === 'undo_conflict') {
    return 'Este item foi alterado depois, então desfazer descartaria essa alteração. Nada foi mudado.';
  }
  if (status === 404) return 'Não encontrei essa ação. Ela pode ter sido removida.';
  return 'Não consegui desfazer agora. Tente de novo em instantes.';
}

/** Refusals after which the line has nothing more to offer. */
export const UNDO_FINAL_CODES: readonly string[] = ['undo_expired', 'already_undone', 'undo_conflict'];

export interface ReceiptView {
  state: 'open' | 'undone' | 'closed';
  /** Time left while `open`. */
  remainingMs: number;
}

/** Where a write stands: still undoable, undone, or past the window. `action` (when known) says more than the event did. */
export function receiptView(
  step: Pick<Step, 'actionId' | 'undoUntil' | 'undone'>,
  action: Pick<AgentAction, 'undone_at' | 'can_undo' | 'undo_until'> | undefined,
  now: number,
): ReceiptView {
  if (step.undone || action?.undone_at) return { state: 'undone', remainingMs: 0 };
  const until = parseIsoUtc(action?.undo_until ?? step.undoUntil)?.getTime();
  const remainingMs = until === undefined ? 0 : until - now;
  const undoable = !!step.actionId && remainingMs > 0 && (action ? action.can_undo : true);
  return { state: undoable ? 'open' : 'closed', remainingMs: undoable ? remainingMs : 0 };
}

// ---------- the Seraphine's tools inside the engines (step 3c) ----------

/** Time a bridge test took, in the owner's words ("3,2 s"). */
export function tookLabel(ms: number): string {
  const secs = Math.max(0, ms) / 1000;
  return `${secs.toFixed(1).replace('.', ',')} s`;
}

/** One line for an engine in the panel: its state in words and when it last worked. */
export function bridgeStatusLine(e: Pick<BridgeEngineStatus, 'state' | 'last_ok_at' | 'last_failure'>, now: Date = new Date()): string {
  const at = formatTime(e.last_ok_at, now);
  const lastOk = at ? `último sucesso ${at.includes(' ') ? 'em' : 'às'} ${at}` : '';
  if (e.state === 'ok') return ['Funcionando', lastOk].filter(Boolean).join(' · ');
  if (e.state === 'failed') {
    const why = clean(e.last_failure);
    return [why ? `Falhou: ${why}` : 'Falhou na última vez', lastOk].filter(Boolean).join(' · ');
  }
  return 'Ainda não usado desde que a Seraphine ligou';
}

/** The sentence a finished test leaves in the row. */
export function bridgeTestLine(r: BridgeTestResult): string {
  if (r.ok) return `Funcionou em ${tookLabel(r.took_ms)}.`;
  return `Não funcionou: ${clean(r.detail) || 'sem detalhes'}`;
}

export const BRIDGE_TEST_RUNNING_MESSAGE = 'Já tem um teste em andamento. Espere ele terminar.';
export const BRIDGE_TEST_FAILED_MESSAGE = 'Não consegui fazer o teste agora. Tente de novo em instantes.';

/** The plain warning before a test: it is a real turn of the engine. */
export function bridgeTestHint(label: string): string {
  return `O teste usa um pouco do seu plano do ${label}.`;
}
