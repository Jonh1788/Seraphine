/**
 * REST + WebSocket client for the agents harness. Every call except bootstrap
 * carries `X-Seraphine-Agents-Token`. The token lives only in this module's
 * memory: never in storage, never logged.
 *
 * Response shapes are the contract in `types.ts`. A 2xx answer that does not
 * have the documented shape throws an `ApiError` (never a silent empty list),
 * so drift between backend and frontend is loud.
 */
import { API_BASE } from '../api';
import type {
  Agent,
  AgentAction,
  AgentChangedBy,
  AgentDraft,
  AgentInput,
  AgentPage,
  AgentTextField,
  AgentVersion,
  Approval,
  BridgeEngineStatus,
  BridgeState,
  BridgeTestResult,
  Checklist,
  ChecklistPatch,
  DecideOptions,
  Decision,
  EngineInfo,
  GrantLevel,
  Grants,
  GuideAbout,
  GuideMessage,
  GuideProposal,
  HarnessEvent,
  Message,
  MessageDelivery,
  Overview,
  Pack,
  ProposalPayload,
  ProposalResult,
  ProviderInfo,
  Project,
  ProjectInput,
  ProjectKind,
  Proposal,
  Routine,
  RoutineDraft,
  RoutineDraftResult,
  RoutineInput,
  RoutinePatch,
  RoutineReport,
  RoutineRun,
  Run,
  RunQuestion,
  SendMessageResult,
  SendMode,
  Schedule,
  SessionMode,
  Setup,
  SetupEngine,
  SetupPatch,
  StreamLine,
  Task,
  TaskInput,
  TaskPatch,
  TeamBatch,
  TeamBatchRef,
  TeamResult,
  TeamUndoResult,
  ToolGroup,
  Usage,
  WaitKind,
} from './types';
import { AGENT_CHANGED_BY, AGENT_TEXT_FIELDS, GRANT_LEVELS, MESSAGE_DELIVERIES, PROPOSAL_KINDS, PROPOSAL_STATUSES, ROUTINE_RUN_STATUSES, ROUTINE_TRIGGERS, SCHEDULE_KINDS, SESSION_MODES, SETUP_STEP_IDS, WAIT_KINDS } from './types';

export const TOKEN_HEADER = 'X-Seraphine-Agents-Token';
const DISABLED_DETAIL = 'agents harness disabled';

/** The harness is switched off (or unreachable at bootstrap). Calm state, not an error. */
export class HarnessDisabledError extends Error {
  constructor() {
    super(DISABLED_DETAIL);
    this.name = 'HarnessDisabledError';
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  /** Machine code of a conflict (`digest_mismatch`, `already_decided`, ...), when the body carries one. */
  readonly code: string;
  constructor(status: number, detail: string, code = '') {
    super(detail || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

let token: string | null = null;
let pendingBootstrap: Promise<string> | null = null;

/** Forget the cached token (tests, or after the backend rejected it). */
export function resetToken(): void {
  token = null;
  pendingBootstrap = null;
}

/** Bootstrap once; later callers share the cached token (or the in-flight request). */
export function ensureToken(): Promise<string> {
  if (token) return Promise.resolve(token);
  if (pendingBootstrap) return pendingBootstrap;
  pendingBootstrap = (async () => {
    let res: Response;
    try {
      // POST: a browser sends no Origin on a same-origin GET, and a GET could be
      // fired from <img>/<link>. The backend answers GET with 405.
      res = await fetch(`${API_BASE}/agents/bootstrap`, { method: 'POST', cache: 'no-store' });
    } catch {
      throw new HarnessDisabledError();
    }
    if (!res.ok) throw new HarnessDisabledError();
    const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
    const value = typeof body?.token === 'string' ? body.token : '';
    if (!value) throw new HarnessDisabledError();
    token = value;
    return value;
  })().finally(() => {
    pendingBootstrap = null;
  });
  return pendingBootstrap;
}

/**
 * Human text plus machine code of an error body. The code may sit beside the
 * text (`{detail, code}`) or inside it (`{detail: {message, code}}`); both are read.
 */
async function readError(res: Response): Promise<{ detail: string; code: string }> {
  const body = (await res.clone().json().catch(() => null)) as { detail?: unknown; code?: unknown } | null;
  const detail = body?.detail;
  let code = typeof body?.code === 'string' ? body.code : '';
  if (typeof detail === 'string') return { detail, code };
  if (Array.isArray(detail)) {
    return {
      detail: detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join('; '),
      code,
    };
  }
  if (isRecord(detail)) {
    if (typeof detail.code === 'string') code = detail.code;
    const text = detail.message ?? detail.msg;
    return { detail: typeof text === 'string' ? text : '', code };
  }
  return { detail: '', code };
}

async function readDetail(res: Response): Promise<string> {
  return (await readError(res)).detail;
}

async function send(path: string, init: RequestInit, canRetry = true): Promise<Response> {
  const t = await ensureToken();
  const headers: Record<string, string> = { [TOKEN_HEADER]: t };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}/agents${path}`, {
    ...init,
    // Harness state changes constantly; never let the browser's HTTP cache
    // answer (it served a stale list of messages and approvals on page load).
    cache: 'no-store',
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 404 && (await readDetail(res)) === DISABLED_DETAIL) {
    throw new HarnessDisabledError();
  }
  if ((res.status === 401 || res.status === 403) && canRetry) {
    // The backend restarted and issued a new token: bootstrap again, once.
    resetToken();
    return send(path, init, false);
  }
  return res;
}

// ---------- response shape checks ----------

/** The backend answered 2xx with a body that is not the documented shape. */
class ShapeMismatch extends Error {}

type Parse<T> = (body: unknown) => T;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function record(body: unknown, expected = 'um objeto'): Record<string, unknown> {
  if (!isRecord(body)) throw new ShapeMismatch(`esperava ${expected}, mas veio ${describe(body)}`);
  return body;
}

/** `{ [key]: [...] }` -> the array. Anything else throws (no silent `[]`). */
function takeArray<T>(key: string): Parse<T[]> {
  return (body) => {
    const value = record(body, `{"${key}": [...]}`)[key];
    if (!Array.isArray(value)) {
      throw new ShapeMismatch(`esperava {"${key}": [...]}, mas "${key}" veio ${describe(value)}`);
    }
    return value as T[];
  };
}

/** The open question of a run (step 3c): `{text, options, asked_at}` or null; a missing field reads as null, a wrong shape is a contract break. */
function checkQuestion(value: unknown, where: string): RunQuestion | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto ou null, mas veio ${describe(value)}`);
  const { text, options, asked_at } = value;
  if (typeof text !== 'string') throw new ShapeMismatch(`esperava "text" (texto) em ${where}, mas veio ${describe(text)}`);
  if (!Array.isArray(options) || options.some((o) => typeof o !== 'string')) {
    throw new ShapeMismatch(`esperava "options" (lista de textos) em ${where}, mas veio ${describe(options)}`);
  }
  if (typeof asked_at !== 'string') throw new ShapeMismatch(`esperava "asked_at" (texto) em ${where}, mas veio ${describe(asked_at)}`);
  return { text, options: options as string[], asked_at };
}

/**
 * A run with the step-1a and 1b fields. Runs recorded before those steps lack them: a
 * missing field gets its neutral default (never fails the screen); a field that is
 * there with the wrong type is a contract break.
 */
export function checkRun(value: unknown, where: string): Run {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const bad = (field: string, expected: string): never => {
    throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(value[field])}`);
  };
  const { recoveries, can_continue, continued_from, continued_by, wait_kind, wait_until, wait_since, wait_attempts, wait_detail, wait_exact, inbox_count, actions_count, question } = value;
  if (actions_count !== undefined && (typeof actions_count !== 'number' || !Number.isInteger(actions_count) || actions_count < 0)) {
    bad('actions_count', 'número inteiro');
  }
  if (recoveries !== undefined && (typeof recoveries !== 'number' || !Number.isInteger(recoveries) || recoveries < 0)) {
    bad('recoveries', 'número inteiro');
  }
  if (can_continue !== undefined && typeof can_continue !== 'boolean') bad('can_continue', 'verdadeiro ou falso');
  if (continued_from !== undefined && continued_from !== null && typeof continued_from !== 'string') bad('continued_from', 'texto ou null');
  if (continued_by !== undefined && continued_by !== null && typeof continued_by !== 'string') bad('continued_by', 'texto ou null');
  if (wait_kind !== undefined && wait_kind !== null && !(WAIT_KINDS as readonly unknown[]).includes(wait_kind)) {
    bad('wait_kind', 'outage, plan_limit, auth, owner_input ou null');
  }
  if (wait_until !== undefined && wait_until !== null && typeof wait_until !== 'string') bad('wait_until', 'texto ou null');
  if (wait_since !== undefined && wait_since !== null && typeof wait_since !== 'string') bad('wait_since', 'texto ou null');
  if (wait_attempts !== undefined && (typeof wait_attempts !== 'number' || !Number.isInteger(wait_attempts) || wait_attempts < 0)) {
    bad('wait_attempts', 'número inteiro');
  }
  if (wait_detail !== undefined && wait_detail !== null && typeof wait_detail !== 'string') bad('wait_detail', 'texto ou null');
  if (wait_exact !== undefined && typeof wait_exact !== 'boolean') bad('wait_exact', 'verdadeiro ou falso');
  if (inbox_count !== undefined && (typeof inbox_count !== 'number' || !Number.isInteger(inbox_count) || inbox_count < 0)) {
    bad('inbox_count', 'número inteiro');
  }
  const { session_mode, session_from } = value;
  if (session_mode !== undefined && !(SESSION_MODES as readonly unknown[]).includes(session_mode)) {
    bad('session_mode', 'continued, fresh_with_history ou fresh');
  }
  if (session_from !== undefined && session_from !== null && typeof session_from !== 'string') bad('session_from', 'texto ou null');
  // Phase 6b: a backend without routines sends neither field (tolerated here, in the one place that tolerates older runs).
  const { routine_id, routine_title } = value;
  if (routine_id !== undefined && routine_id !== null && typeof routine_id !== 'string') bad('routine_id', 'texto ou null');
  if (routine_title !== undefined && routine_title !== null && typeof routine_title !== 'string') bad('routine_title', 'texto ou null');
  return {
    ...value,
    routine_id: (routine_id as string | null | undefined) ?? null,
    routine_title: (routine_title as string | null | undefined) ?? null,
    session_mode: (session_mode as SessionMode | undefined) ?? 'fresh',
    session_from: (session_from as string | null | undefined) ?? null,
    question: checkQuestion(question, `"question" de ${where}`),
    inbox_count: (inbox_count as number | undefined) ?? 0,
    actions_count: (actions_count as number | undefined) ?? 0,
    wait_detail: (wait_detail as string | null | undefined) ?? null,
    wait_exact: (wait_exact as boolean | undefined) ?? false,
    recoveries: (recoveries as number | undefined) ?? 0,
    can_continue: (can_continue as boolean | undefined) ?? false,
    continued_from: (continued_from as string | null | undefined) ?? null,
    continued_by: (continued_by as string | null | undefined) ?? null,
    wait_kind: (wait_kind as WaitKind | null | undefined) ?? null,
    wait_until: (wait_until as string | null | undefined) ?? null,
    wait_since: (wait_since as string | null | undefined) ?? null,
    wait_attempts: (wait_attempts as number | undefined) ?? 0,
  } as unknown as Run;
}

function parseRun(body: unknown): Run {
  return checkRun(takeObject<unknown>('run')(body), '"run"');
}

function parseRuns(body: unknown): Run[] {
  return takeArray<unknown>('runs')(body).map((r, i) => checkRun(r, `runs[${i}]`));
}

/**
 * A message with the step-1c `delivery`. Rows from before that step lack it: it defaults to null;
 * a value outside the three known ones is a contract break.
 */
export function checkMessage(value: unknown, where: string): Message {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const { delivery } = value;
  if (delivery !== undefined && delivery !== null && !(MESSAGE_DELIVERIES as readonly unknown[]).includes(delivery)) {
    throw new ShapeMismatch(`esperava "delivery" (pending, delivered, undelivered ou null) em ${where}, mas veio ${describe(delivery)}`);
  }
  // Phase 6b: `routine_id` is missing in the answers of a backend without routines.
  const { routine_id } = value;
  if (routine_id !== undefined && routine_id !== null && typeof routine_id !== 'string') {
    throw new ShapeMismatch(`esperava "routine_id" (texto ou null) em ${where}, mas veio ${describe(routine_id)}`);
  }
  return {
    ...value,
    delivery: (delivery as MessageDelivery | null | undefined) ?? null,
    routine_id: (routine_id as string | null | undefined) ?? null,
  } as unknown as Message;
}

function parseMessages(body: unknown): Message[] {
  return takeArray<unknown>('messages')(body).map((m, i) => checkMessage(m, `messages[${i}]`));
}

/** `{ [key]: {...} }` -> the object. Anything else throws. */
function takeObject<T>(key: string): Parse<T> {
  return (body) => {
    const value = record(body, `{"${key}": {...}}`)[key];
    if (!isRecord(value)) {
      throw new ShapeMismatch(`esperava {"${key}": {...}}, mas "${key}" veio ${describe(value)}`);
    }
    return value as unknown as T;
  };
}

/** `{group: level}` with only known levels; anything else is a contract break. */
function checkGrants(value: unknown, where: string): Grants {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  for (const [group, level] of Object.entries(value)) {
    if (!(GRANT_LEVELS as readonly unknown[]).includes(level)) {
      throw new ShapeMismatch(`esperava "${group}" (none, read ou write) em ${where}, mas veio ${describe(level)}`);
    }
  }
  return { ...value } as Grants;
}

/**
 * An agent: `grants` (step 3b) and the phase-6a fields (`description`, `suggestions`, `home_project_id`, `origin`) are missing
 * in answers of an older backend and then get their neutral default; a field that is there with the wrong type is a
 * contract break. This (with `checkProject` and `checkProvider` below) is the only place that tolerates a missing 6a field
 * (and the 6c `version`, `archived` and `archived_at`; `checkBatchRef` does the same for a missing `batch`).
 */
export function checkAgent(value: unknown, where: string): Agent {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const grants = value.grants === undefined ? {} : checkGrants(value.grants, `"grants" de ${where}`);
  const { description, suggestions, home_project_id, origin } = value;
  const bad = (field: string, expected: string): never => {
    throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(value[field])}`);
  };
  if (description !== undefined && typeof description !== 'string') bad('description', 'texto');
  if (suggestions !== undefined && (!Array.isArray(suggestions) || suggestions.some((x) => typeof x !== 'string'))) bad('suggestions', 'lista de textos');
  if (home_project_id !== undefined && home_project_id !== null && typeof home_project_id !== 'string') bad('home_project_id', 'texto ou null');
  if (origin !== undefined && typeof origin !== 'string') bad('origin', 'texto');
  // Phase 6c: an older backend sends no `version`; it reads as 0 ("no history yet").
  const { version } = value;
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 0)) bad('version', 'número inteiro');
  // Phase 6c part 2: an older backend sends neither `archived` nor `archived_at`; they read as "not archived".
  const { archived, archived_at } = value;
  if (archived !== undefined && typeof archived !== 'boolean') bad('archived', 'verdadeiro ou falso');
  if (archived_at !== undefined && archived_at !== null && typeof archived_at !== 'string') bad('archived_at', 'texto ou null');
  return {
    ...value,
    version: (version as number | undefined) ?? 0,
    archived: (archived as boolean | undefined) ?? false,
    archived_at: (archived_at as string | null | undefined) ?? null,
    grants,
    description: (description as string | undefined) ?? '',
    suggestions: (suggestions as string[] | undefined) ?? [],
    home_project_id: (home_project_id as string | null | undefined) ?? null,
    origin: (origin as string | undefined) ?? 'manual',
  } as unknown as Agent;
}

/** A project (phase 6a): `kind` and `agent_id` default to a plain project when the backend does not send them. */
export function checkProject(value: unknown, where: string): Project {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const { kind, agent_id } = value;
  if (kind !== undefined && kind !== 'project' && kind !== 'home') {
    throw new ShapeMismatch(`esperava "kind" (project ou home) em ${where}, mas veio ${describe(kind)}`);
  }
  if (agent_id !== undefined && agent_id !== null && typeof agent_id !== 'string') {
    throw new ShapeMismatch(`esperava "agent_id" (texto ou null) em ${where}, mas veio ${describe(agent_id)}`);
  }
  return { ...value, kind: (kind as ProjectKind | undefined) ?? 'project', agent_id: (agent_id as string | null | undefined) ?? null } as unknown as Project;
}

function parseProject(body: unknown): Project {
  return checkProject(takeObject<unknown>('project')(body), '"project"');
}

function parseProjects(body: unknown): Project[] {
  return takeArray<unknown>('projects')(body).map((p, i) => checkProject(p, `projects[${i}]`));
}

/** A provider (phase 6a): `how` defaults to "" when the backend does not send it. */
export function checkProvider(value: unknown, where: string): ProviderInfo {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  if (value.how !== undefined && typeof value.how !== 'string') {
    throw new ShapeMismatch(`esperava "how" (texto) em ${where}, mas veio ${describe(value.how)}`);
  }
  return { ...value, how: (value.how as string | undefined) ?? '' } as unknown as ProviderInfo;
}

function parseProviders(body: unknown): ProviderInfo[] {
  return takeArray<unknown>('providers')(body).map((p, i) => checkProvider(p, `providers[${i}]`));
}

function parseAgent(body: unknown): Agent {
  return checkAgent(takeObject<unknown>('def')(body), '"def"');
}

function parseAgents(body: unknown): Agent[] {
  return takeArray<unknown>('defs')(body).map((a, i) => checkAgent(a, `defs[${i}]`));
}

function parseGrants(body: unknown): Grants {
  return checkGrants(takeObject<unknown>('grants')(body), '"grants"');
}

const TOOL_GROUP_LEVELS = GRANT_LEVELS as readonly unknown[];

/** The catalogue of tools: every group and tool must have the documented fields (no silent defaults). */
function parseTools(body: unknown): ToolGroup[] {
  const groups = takeArray<unknown>('groups')(body);
  return groups.map((g, i) => {
    const where = `groups[${i}]`;
    if (!isRecord(g)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(g)}`);
    const bad = (field: string, expected: string, v: unknown = g[field]): never => {
      throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(v)}`);
    };
    if (typeof g.id !== 'string' || !g.id) bad('id', 'texto');
    if (typeof g.label !== 'string') bad('label', 'texto');
    if (typeof g.description !== 'string') bad('description', 'texto');
    if (!TOOL_GROUP_LEVELS.includes(g.default)) bad('default', 'none, read ou write');
    if (typeof g.sensitive !== 'boolean') bad('sensitive', 'verdadeiro ou falso');
    // `levels` (step 3c) is missing in older answers: such a group only knew "Sem acesso" and "Ler".
    if (g.levels !== undefined && (!Array.isArray(g.levels) || g.levels.length === 0 || g.levels.some((l) => !TOOL_GROUP_LEVELS.includes(l)))) {
      bad('levels', 'lista de none, read ou write');
    }
    const levels = (g.levels as GrantLevel[] | undefined) ?? (['none', 'read'] as GrantLevel[]);
    if (!Array.isArray(g.tools)) bad('tools', 'lista');
    const tools = (g.tools as unknown[]).map((t, j) => {
      if (!isRecord(t)) throw new ShapeMismatch(`esperava ${where}.tools[${j}] como objeto, mas veio ${describe(t)}`);
      for (const field of ['name', 'label', 'description'] as const) {
        if (typeof t[field] !== 'string') bad(`tools[${j}].${field}`, 'texto', t[field]);
      }
      if (typeof t.read_only !== 'boolean') bad(`tools[${j}].read_only`, 'verdadeiro ou falso', t.read_only);
      if (t.level !== undefined && t.level !== 'read' && t.level !== 'write') bad(`tools[${j}].level`, 'read ou write', t.level);
      const level = (t.level as 'read' | 'write' | undefined) ?? (t.read_only ? 'read' : 'write');
      return { name: t.name, label: t.label, description: t.description, read_only: t.read_only, level };
    });
    return { id: g.id, label: g.label, description: g.description, default: g.default, sensitive: g.sensitive, levels, tools } as ToolGroup;
  });
}

const RISK_LEVELS = ['low', 'medium', 'high'];
const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired'];

/** An approval with every field of approvals v2; a missing or mistyped one is a contract break. */
function checkApproval(value: unknown, where: string): Approval {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const bad = (field: string, expected: string): never => {
    throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(value[field])}`);
  };
  if (typeof value.id !== 'string') bad('id', 'texto');
  if (typeof value.command !== 'string') bad('command', 'texto');
  if (typeof value.status !== 'string' || !APPROVAL_STATUSES.includes(value.status)) bad('status', 'pending, approved, denied ou expired');
  if (typeof value.risk_level !== 'string' || !RISK_LEVELS.includes(value.risk_level)) bad('risk_level', 'low, medium ou high');
  if (!Array.isArray(value.risk_reasons) || value.risk_reasons.some((r) => typeof r !== 'string')) bad('risk_reasons', 'lista de textos');
  if (typeof value.command_digest !== 'string' || !value.command_digest) bad('command_digest', 'texto');
  if (typeof value.expires_at !== 'string') bad('expires_at', 'texto');
  if (value.decided_by !== null && value.decided_by !== 'owner' && value.decided_by !== 'harness') bad('decided_by', 'owner, harness ou null');
  if (value.decision_note !== null && typeof value.decision_note !== 'string') bad('decision_note', 'texto ou null');
  return value as unknown as Approval;
}

function parseApprovals(body: unknown): Approval[] {
  const list = takeArray<unknown>('approvals')(body);
  return list.map((a, i) => checkApproval(a, `approvals[${i}]`));
}

function parseApproval(body: unknown): Approval {
  return checkApproval(takeObject<unknown>('approval')(body), '"approval"');
}

function parseOverview(body: unknown): Overview {
  const o = record(body);
  for (const key of ['pending_approvals', 'active_runs', 'spend_today']) {
    if (!Array.isArray(o[key])) {
      throw new ShapeMismatch(`esperava "${key}" como lista, mas veio ${describe(o[key])}`);
    }
  }
  (o.pending_approvals as unknown[]).forEach((a, i) => checkApproval(a, `pending_approvals[${i}]`));
  const active = o.routines_active;
  if (active !== undefined && (typeof active !== 'number' || !Number.isInteger(active) || active < 0)) {
    throw new ShapeMismatch(`esperava "routines_active" (número inteiro), mas veio ${describe(active)}`);
  }
  return { ...o, routines_active: (active as number | undefined) ?? 0, active_runs: (o.active_runs as unknown[]).map((r, i) => checkRun(r, `active_runs[${i}]`)) } as unknown as Overview;
}

function parseSendResult(body: unknown): SendMessageResult {
  const o = record(body);
  if (!isRecord(o.message)) {
    throw new ShapeMismatch(`esperava "message" como objeto, mas veio ${describe(o.message)}`);
  }
  if (o.run !== null && !isRecord(o.run)) {
    throw new ShapeMismatch(`esperava "run" como objeto ou null, mas veio ${describe(o.run)}`);
  }
  for (const flag of ['joined', 'interrupted']) {
    if (o[flag] !== undefined && typeof o[flag] !== 'boolean') {
      throw new ShapeMismatch(`esperava "${flag}" (verdadeiro ou falso), mas veio ${describe(o[flag])}`);
    }
  }
  return {
    ...o,
    message: checkMessage(o.message, '"message"'),
    run: o.run === null ? null : checkRun(o.run, '"run"'),
    joined: o.joined === true,
    interrupted: o.interrupted === true,
  } as unknown as SendMessageResult;
}

const BRIDGE_STATES: readonly BridgeState[] = ['ok', 'failed', 'unknown'];

/** An action (receipt) of step 3c with every field of the contract; a missing or mistyped one is a contract break. */
export function checkAction(value: unknown, where: string): AgentAction {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const bad = (field: string, expected: string): never => {
    throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(value[field])}`);
  };
  for (const field of ['id', 'run_id', 'agent_id', 'project_id', 'tool', 'group', 'label', 'created_at', 'undo_until'] as const) {
    if (typeof value[field] !== 'string') bad(field, 'texto');
  }
  if (!value.id) bad('id', 'texto');
  if (value.undone_at !== null && typeof value.undone_at !== 'string') bad('undone_at', 'texto ou null');
  if (typeof value.can_undo !== 'boolean') bad('can_undo', 'verdadeiro ou falso');
  return value as unknown as AgentAction;
}

function parseActions(body: unknown): AgentAction[] {
  return takeArray<unknown>('actions')(body).map((a, i) => checkAction(a, `actions[${i}]`));
}

function parseAction(body: unknown): AgentAction {
  return checkAction(takeObject<unknown>('action')(body), '"action"');
}

function parseBridgeStatus(body: unknown): BridgeEngineStatus[] {
  return takeArray<unknown>('engines')(body).map((e, i) => {
    const where = `engines[${i}]`;
    if (!isRecord(e)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(e)}`);
    const bad = (field: string, expected: string): never => {
      throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(e[field])}`);
    };
    if (typeof e.engine !== 'string' || !e.engine) bad('engine', 'texto');
    if (typeof e.label !== 'string') bad('label', 'texto');
    if (!BRIDGE_STATES.includes(e.state as BridgeState)) bad('state', 'ok, failed ou unknown');
    for (const field of ['last_ok_at', 'last_failure_at', 'last_failure'] as const) {
      if (e[field] !== null && typeof e[field] !== 'string') bad(field, 'texto ou null');
    }
    return e as unknown as BridgeEngineStatus;
  });
}

function parseBridgeTest(body: unknown): BridgeTestResult {
  const o = record(body);
  if (typeof o.ok !== 'boolean') throw new ShapeMismatch(`esperava "ok" (verdadeiro ou falso), mas veio ${describe(o.ok)}`);
  if (typeof o.detail !== 'string') throw new ShapeMismatch(`esperava "detail" (texto), mas veio ${describe(o.detail)}`);
  if (typeof o.took_ms !== 'number' || !Number.isFinite(o.took_ms) || o.took_ms < 0) {
    throw new ShapeMismatch(`esperava "took_ms" (número), mas veio ${describe(o.took_ms)}`);
  }
  return { ok: o.ok, detail: o.detail, took_ms: o.took_ms };
}

function parseOk(body: unknown): true {
  if (record(body).ok !== true) throw new ShapeMismatch('esperava {"ok": true}');
  return true;
}

async function request<T>(path: string, init: RequestInit, parse: Parse<T>): Promise<T> {
  const res = await send(path, init);
  if (!res.ok) {
    const { detail, code } = await readError(res);
    throw new ApiError(res.status, detail, code);
  }
  const text = await res.text();
  try {
    return parse(text ? JSON.parse(text) : null);
  } catch (err) {
    const why = err instanceof ShapeMismatch ? err.message : 'a resposta não é JSON';
    throw new ApiError(res.status, `Resposta inesperada do servidor em ${init.method ?? 'GET'} /agents${path}: ${why}.`);
  }
}

function json(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;
const GET: RequestInit = { method: 'GET' };

// ---------- overview / engines ----------

export function getOverview(): Promise<Overview> {
  return request('/overview', GET, parseOverview);
}

export function getEngines(): Promise<EngineInfo[]> {
  return request('/engines', GET, takeArray<EngineInfo>('engines'));
}

export function getProviders(): Promise<ProviderInfo[]> {
  return request('/providers', GET, parseProviders);
}

// ---------- projects ----------

export function listProjects(): Promise<Project[]> {
  return request('/projects', GET, parseProjects);
}
export function createProject(input: ProjectInput): Promise<Project> {
  return request('/projects', json('POST', input), parseProject);
}
export function updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project> {
  return request(`/projects/${enc(id)}`, json('PATCH', patch), parseProject);
}
/** DELETE archives: resolves with the archived project. */
export function archiveProject(id: string): Promise<Project> {
  return request(`/projects/${enc(id)}`, json('DELETE'), parseProject);
}

// ---------- agents ----------

/** Archived agents only come with `includeArchived` (the default list leaves them out). */
export function listAgents(opts: { includeArchived?: boolean } = {}): Promise<Agent[]> {
  return request(`/defs${opts.includeArchived ? '?include_archived=true' : ''}`, GET, parseAgents);
}
export function createAgent(input: AgentInput): Promise<Agent> {
  return request('/defs', json('POST', input), parseAgent);
}
export function updateAgent(id: string, patch: Partial<AgentInput>): Promise<Agent> {
  return request(`/defs/${enc(id)}`, json('PATCH', patch), parseAgent);
}

// ---------- first steps, ready teams, guide, homes (phase 6a) ----------

function bad6a(where: string, field: string, expected: string, value: unknown): never {
  throw new ShapeMismatch(`esperava "${field}" (${expected}) em ${where}, mas veio ${describe(value)}`);
}

function checkSetupEngine(value: unknown, where: string): SetupEngine | null {
  if (value === null) return null;
  if (!isRecord(value)) return bad6a(where, 'default_engine', 'objeto ou null', value);
  if (typeof value.engine !== 'string' || !value.engine) bad6a(where, 'default_engine.engine', 'texto', value.engine);
  if (value.provider !== null && typeof value.provider !== 'string') bad6a(where, 'default_engine.provider', 'texto ou null', value.provider);
  if (value.model !== null && typeof value.model !== 'string') bad6a(where, 'default_engine.model', 'texto ou null', value.model);
  return { engine: value.engine as string, provider: value.provider as string | null, model: value.model as string | null };
}

/** `{setup: {...}}` with every field of the contract; a missing or mistyped one is a contract break (the route is new: no older answer exists). */
export function checkSetup(value: unknown, where = '"setup"'): Setup {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const { areas, areas_skipped, dismissed, home_dir, steps, done, total } = value;
  if (areas !== null && (!Array.isArray(areas) || areas.some((a) => typeof a !== 'string'))) bad6a(where, 'areas', 'lista de textos ou null', areas);
  if (typeof areas_skipped !== 'boolean') bad6a(where, 'areas_skipped', 'verdadeiro ou falso', areas_skipped);
  if (typeof dismissed !== 'boolean') bad6a(where, 'dismissed', 'verdadeiro ou falso', dismissed);
  if (typeof home_dir !== 'string') bad6a(where, 'home_dir', 'texto', home_dir);
  if (!Array.isArray(steps)) bad6a(where, 'steps', 'lista', steps);
  const parsedSteps = (steps as unknown[]).map((s, i) => {
    if (!isRecord(s) || !(SETUP_STEP_IDS as readonly unknown[]).includes(s.id) || typeof s.done !== 'boolean') {
      throw new ShapeMismatch(`esperava ${where}.steps[${i}] como {id, done}, mas veio ${describe(s)}`);
    }
    return { id: s.id as Setup['steps'][number]['id'], done: s.done };
  });
  if (typeof done !== 'number' || !Number.isInteger(done) || done < 0) bad6a(where, 'done', 'número inteiro', done);
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) bad6a(where, 'total', 'número inteiro', total);
  return {
    areas: areas as string[] | null,
    areas_skipped: areas_skipped as boolean,
    default_engine: checkSetupEngine(value.default_engine === undefined ? null : value.default_engine, where),
    dismissed: dismissed as boolean,
    home_dir: home_dir as string,
    steps: parsedSteps,
    done: done as number,
    total: total as number,
  };
}

function parseSetup(body: unknown): Setup {
  return checkSetup(takeObject<unknown>('setup')(body));
}

/** An agent draft (ready team or proposal): the text fields are required; the optional ones are kept when well formed. */
export function checkDraft(value: unknown, where: string): AgentDraft {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  for (const field of ['name', 'role', 'description', 'instructions'] as const) {
    if (typeof value[field] !== 'string') bad6a(where, field, 'texto', value[field]);
  }
  if (!Array.isArray(value.suggestions) || value.suggestions.some((x) => typeof x !== 'string')) bad6a(where, 'suggestions', 'lista de textos', value.suggestions);
  const draft: AgentDraft = {
    name: value.name as string,
    role: value.role as string,
    description: value.description as string,
    instructions: value.instructions as string,
    suggestions: value.suggestions as string[],
  };
  if (typeof value.color === 'string') draft.color = value.color;
  if (value.perm_edit === 'free' || value.perm_edit === 'blocked') draft.perm_edit = value.perm_edit;
  if (value.grants !== undefined) draft.grants = checkGrants(value.grants, `"grants" de ${where}`);
  for (const field of ['engine', 'provider', 'model'] as const) {
    const v = value[field];
    if (typeof v === 'string') draft[field] = v;
  }
  if (value.routines !== undefined) {
    if (!Array.isArray(value.routines)) bad6a(where, 'routines', 'lista', value.routines);
    draft.routines = (value.routines as unknown[]).map((r, i) => checkRoutineDraft(r, `${where}.routines[${i}]`));
  }
  return draft;
}

// ---------- routines (phase 6b) ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The schedule object of contract section 1: `kind` and exactly the fields of that kind; anything else is a contract break. */
export function checkSchedule(value: unknown, where: string): Schedule {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const kind = value.kind;
  if (!(SCHEDULE_KINDS as readonly unknown[]).includes(kind)) {
    throw new ShapeMismatch(`esperava "kind" (daily, weekdays, weekly, monthly, interval ou once) em ${where}, mas veio ${describe(kind)}`);
  }
  const time = (): string => {
    if (typeof value.time !== 'string' || !HHMM.test(value.time)) bad6a(where, 'time', 'hora HH:MM', value.time);
    return value.time as string;
  };
  switch (kind) {
    case 'daily':
      return { kind, time: time() };
    case 'weekdays':
      return { kind, time: time() };
    case 'weekly': {
      const days = value.days;
      if (
        !Array.isArray(days) ||
        days.length < 1 ||
        days.length > 7 ||
        days.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) ||
        new Set(days).size !== days.length
      ) {
        bad6a(where, 'days', 'lista de 1 a 7 dias (0 a 6) sem repetição', days);
      }
      return { kind, time: time(), days: days as number[] };
    }
    case 'monthly': {
      const day = value.day;
      if (day !== 'last' && (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 28)) bad6a(where, 'day', '1 a 28 ou "last"', day);
      return { kind, time: time(), day: day as number | 'last' };
    }
    case 'interval': {
      const every = value.every_minutes;
      if (typeof every !== 'number' || !Number.isInteger(every) || every < 15 || every > 1440) bad6a(where, 'every_minutes', 'número de 15 a 1440', every);
      return { kind, every_minutes: every as number };
    }
    default: {
      if (typeof value.at !== 'string' || Number.isNaN(new Date(value.at).getTime())) bad6a(where, 'at', 'data e hora', value.at);
      return { kind: 'once', at: value.at as string };
    }
  }
}

function checkReport(value: unknown, where: string): RoutineReport {
  if (value !== 'news' && value !== 'always') bad6a(where, 'report', 'news ou always', value);
  return value as RoutineReport;
}

/** A routine of the contract (section 2), every field present: the route is new, so no older answer exists. */
export function checkRoutine(value: unknown, where: string): Routine {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  for (const field of ['id', 'agent_id', 'project_id', 'title', 'prompt', 'schedule_text', 'origin', 'created_at', 'updated_at'] as const) {
    if (typeof value[field] !== 'string') bad6a(where, field, 'texto', value[field]);
  }
  if (!value.id) bad6a(where, 'id', 'texto', value.id);
  if (typeof value.enabled !== 'boolean') bad6a(where, 'enabled', 'verdadeiro ou falso', value.enabled);
  if (typeof value.running !== 'boolean') bad6a(where, 'running', 'verdadeiro ou falso', value.running);
  if (value.paused_reason !== null && value.paused_reason !== 'failures') bad6a(where, 'paused_reason', 'failures ou null', value.paused_reason);
  for (const field of ['next_run_at', 'last_run_at', 'last_status'] as const) {
    if (value[field] !== null && typeof value[field] !== 'string') bad6a(where, field, 'texto ou null', value[field]);
  }
  if (!Array.isArray(value.upcoming) || value.upcoming.some((u) => typeof u !== 'string')) bad6a(where, 'upcoming', 'lista de textos', value.upcoming);
  const failures = value.consecutive_failures;
  if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) bad6a(where, 'consecutive_failures', 'número inteiro', failures);
  const week = value.week;
  if (
    !isRecord(week) ||
    typeof week.ok !== 'number' ||
    typeof week.total !== 'number' ||
    !Number.isInteger(week.ok) ||
    !Number.isInteger(week.total) ||
    week.ok < 0 ||
    week.total < 0
  ) {
    bad6a(where, 'week', '{ok, total}', week);
  }
  const w = week as { ok: number; total: number };
  return {
    id: value.id as string,
    agent_id: value.agent_id as string,
    project_id: value.project_id as string,
    title: value.title as string,
    prompt: value.prompt as string,
    schedule: checkSchedule(value.schedule, `"schedule" de ${where}`),
    schedule_text: value.schedule_text as string,
    report: checkReport(value.report, where),
    enabled: value.enabled as boolean,
    paused_reason: value.paused_reason as 'failures' | null,
    next_run_at: value.next_run_at as string | null,
    upcoming: value.upcoming as string[],
    last_run_at: value.last_run_at as string | null,
    last_status: value.last_status as string | null,
    consecutive_failures: failures as number,
    week: { ok: w.ok, total: w.total },
    running: value.running as boolean,
    origin: value.origin as string,
    created_at: value.created_at as string,
    updated_at: value.updated_at as string,
  };
}

/** A routine of an agent draft: title, request and schedule are required; `report` defaults on the backend; `schedule_text` is kept when sent. */
export function checkRoutineDraft(value: unknown, where: string): RoutineDraft {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  for (const field of ['title', 'prompt'] as const) {
    if (typeof value[field] !== 'string') bad6a(where, field, 'texto', value[field]);
  }
  const out: RoutineDraft = { title: value.title as string, prompt: value.prompt as string, schedule: checkSchedule(value.schedule, `"schedule" de ${where}`) };
  if (value.report !== undefined) out.report = checkReport(value.report, where);
  if (typeof value.schedule_text === 'string') out.schedule_text = value.schedule_text;
  return out;
}

/** One line of a routine's ledger (contract section 3). */
export function checkRoutineRun(value: unknown, where: string): RoutineRun {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  for (const field of ['id', 'routine_id', 'scheduled_for', 'detail'] as const) {
    if (typeof value[field] !== 'string') bad6a(where, field, 'texto', value[field]);
  }
  if (!(ROUTINE_TRIGGERS as readonly unknown[]).includes(value.trigger)) bad6a(where, 'trigger', 'schedule, manual ou catchup', value.trigger);
  if (!(ROUTINE_RUN_STATUSES as readonly unknown[]).includes(value.status)) bad6a(where, 'status', 'running, reported, quiet, failed, cancelled, skipped ou missed', value.status);
  for (const field of ['run_id', 'finished_at'] as const) {
    if (value[field] !== null && typeof value[field] !== 'string') bad6a(where, field, 'texto ou null', value[field]);
  }
  return value as unknown as RoutineRun;
}

function parseRoutine(body: unknown): Routine {
  return checkRoutine(takeObject<unknown>('routine')(body), '"routine"');
}

function parseRoutines(body: unknown): Routine[] {
  return takeArray<unknown>('routines')(body).map((r, i) => checkRoutine(r, `routines[${i}]`));
}

function parseRoutineRuns(body: unknown): RoutineRun[] {
  return takeArray<unknown>('runs')(body).map((r, i) => checkRoutineRun(r, `runs[${i}]`));
}

function parseRoutineRunNow(body: unknown): { routine: Routine; run: Run } {
  const o = record(body);
  return { routine: checkRoutine(o.routine, '"routine"'), run: checkRun(o.run, '"run"') };
}

function parseRoutineDraft(body: unknown): RoutineDraftResult {
  const o = record(body);
  if (typeof o.say !== 'string') bad6a('a resposta', 'say', 'texto', o.say);
  const d = o.draft;
  if (!isRecord(d)) throw new ShapeMismatch(`esperava "draft" como objeto, mas veio ${describe(d)}`);
  for (const field of ['title', 'prompt', 'schedule_text'] as const) {
    if (typeof d[field] !== 'string') bad6a('"draft"', field, 'texto', d[field]);
  }
  return {
    say: o.say as string,
    draft: {
      title: d.title as string,
      prompt: d.prompt as string,
      schedule: checkSchedule(d.schedule, '"schedule" de "draft"'),
      schedule_text: d.schedule_text as string,
      report: checkReport(d.report, '"draft"'),
    },
  };
}

function parsePacks(body: unknown): Pack[] {
  return takeArray<unknown>('packs')(body).map((p, i) => {
    const where = `packs[${i}]`;
    if (!isRecord(p)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(p)}`);
    for (const field of ['id', 'label', 'summary', 'detail'] as const) {
      if (typeof p[field] !== 'string') bad6a(where, field, 'texto', p[field]);
    }
    if (!Array.isArray(p.areas) || p.areas.some((a) => typeof a !== 'string')) bad6a(where, 'areas', 'lista de textos', p.areas);
    if (!Array.isArray(p.agents)) bad6a(where, 'agents', 'lista', p.agents);
    return {
      id: p.id as string,
      label: p.label as string,
      summary: p.summary as string,
      detail: p.detail as string,
      areas: p.areas as string[],
      agents: (p.agents as unknown[]).map((a, j) => checkDraft(a, `${where}.agents[${j}]`)),
    };
  });
}

function parseProposal(body: unknown): Proposal {
  const p = takeObject<Record<string, unknown>>('proposal')(body);
  if (typeof p.say !== 'string') bad6a('"proposal"', 'say', 'texto', p.say);
  if (!Array.isArray(p.agents)) bad6a('"proposal"', 'agents', 'lista', p.agents);
  return { say: p.say as string, agents: (p.agents as unknown[]).map((a, i) => checkDraft(a, `proposal.agents[${i}]`)) };
}

/** `{id, undo_until}` or null; a missing `batch` (an older backend) reads as null, a wrong shape is a contract break. */
export function checkBatchRef(value: unknown, where: string): TeamBatchRef | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto ou null, mas veio ${describe(value)}`);
  if (typeof value.id !== 'string' || !value.id) bad6a(where, 'id', 'texto', value.id);
  if (typeof value.undo_until !== 'string' || !value.undo_until) bad6a(where, 'undo_until', 'texto', value.undo_until);
  return { id: value.id as string, undo_until: value.undo_until as string };
}

function parseTeamResult(body: unknown): TeamResult {
  const o = record(body);
  for (const key of ['created', 'failed', 'lowered']) {
    if (!Array.isArray(o[key])) throw new ShapeMismatch(`esperava "${key}" como lista, mas veio ${describe(o[key])}`);
  }
  const created = (o.created as unknown[]).map((c, i) => {
    const where = `created[${i}]`;
    if (!isRecord(c)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(c)}`);
    return { def: checkAgent(c.def, `${where}.def`), home: checkProject(c.home, `${where}.home`) };
  });
  const failed = (o.failed as unknown[]).map((f, i) => {
    const where = `failed[${i}]`;
    if (!isRecord(f) || typeof f.name !== 'string' || typeof f.detail !== 'string') {
      throw new ShapeMismatch(`esperava ${where} como {name, detail}, mas veio ${describe(f)}`);
    }
    return { name: f.name, detail: f.detail };
  });
  const lowered = (o.lowered as unknown[]).map((l, i) => {
    const where = `lowered[${i}]`;
    if (
      !isRecord(l) ||
      typeof l.name !== 'string' ||
      typeof l.group !== 'string' ||
      !(GRANT_LEVELS as readonly unknown[]).includes(l.asked) ||
      !(GRANT_LEVELS as readonly unknown[]).includes(l.got)
    ) {
      throw new ShapeMismatch(`esperava ${where} como {name, group, asked, got}, mas veio ${describe(l)}`);
    }
    return { name: l.name, group: l.group, asked: l.asked as GrantLevel, got: l.got as GrantLevel };
  });
  // Phase 6b: a backend without routines sends no `routines`.
  if (o.routines !== undefined && !Array.isArray(o.routines)) throw new ShapeMismatch(`esperava "routines" como lista, mas veio ${describe(o.routines)}`);
  const routines = ((o.routines as unknown[] | undefined) ?? []).map((r, i) => checkRoutine(r, `routines[${i}]`));
  return { created, failed, lowered, routines, batch: checkBatchRef(o.batch, '"batch"') };
}

export function getSetup(): Promise<Setup> {
  return request('/setup', GET, parseSetup);
}
/** Partial body; the answer is the whole setup. 422 for an unknown field or an invalid value. */
export function putSetup(patch: SetupPatch): Promise<Setup> {
  return request('/setup', json('PUT', patch), parseSetup);
}
export function getPacks(): Promise<Pack[]> {
  return request('/packs', GET, parsePacks);
}
/** Nothing is created by this call. 503 `guide_unavailable`, 409 `guide_busy`, 422 invalid body. */
export function proposeTeam(input: { text: string; previous?: { agents: AgentDraft[] }; areas?: string[] }): Promise<Proposal> {
  return request('/guide/propose', json('POST', input), parseProposal);
}
/** 200 even when some (or all) of the agents failed: read `failed` and `lowered`. */
export function createTeam(input: { origin: string; agents: AgentDraft[] }): Promise<TeamResult> {
  return request('/team', json('POST', input), parseTeamResult);
}
/** Makes sure the agent's home conversation exists (creates it, or brings it back from the archive). 404, 422 `home_unavailable`. */
export function ensureAgentHome(agentId: string): Promise<Project> {
  return request(`/defs/${enc(agentId)}/home`, json('POST'), parseProject);
}

// ---------- routines (phase 6b) ----------

/** 404 means a backend without routines (the store hides every routines feature). */
export function listRoutines(agentId?: string): Promise<Routine[]> {
  return request(`/routines${qs({ agent_id: agentId })}`, GET, parseRoutines);
}
/** 404 agent unknown, 422 invalid field, 409 `routine_limit` (already 20 on). */
export function createRoutine(input: RoutineInput): Promise<Routine> {
  return request('/routines', json('POST', input), parseRoutine);
}
/** Partial body. Turning on clears the failure pause; changing `schedule` or turning on recomputes the next time. 409 `routine_limit` when turning on. */
export function updateRoutine(id: string, patch: RoutinePatch): Promise<Routine> {
  return request(`/routines/${enc(id)}`, json('PATCH', patch), parseRoutine);
}
export async function deleteRoutine(id: string): Promise<void> {
  await request(`/routines/${enc(id)}`, json('DELETE'), parseOk);
}
/** "Rodar agora": works with the routine turned off. 409 `routine_running` while one of its runs is in progress. */
export function runRoutineNow(id: string): Promise<{ routine: Routine; run: Run }> {
  return request(`/routines/${enc(id)}/run`, json('POST'), parseRoutineRunNow);
}
/** The copy is born turned off. */
export function copyRoutine(id: string): Promise<Routine> {
  return request(`/routines/${enc(id)}/copy`, json('POST'), parseRoutine);
}
/** The ledger of a routine, newest first (`limit` default 20, max 100). */
export function listRoutineRuns(id: string, limit = 20): Promise<RoutineRun[]> {
  return request(`/routines/${enc(id)}/runs${qs({ limit })}`, GET, parseRoutineRuns);
}
/** Reads one sentence of the owner into form fields; nothing is created. 503 `guide_unavailable`, 409 `guide_busy`. */
export function draftRoutine(input: { text: string; agent_id?: string }): Promise<RoutineDraftResult> {
  return request('/routines/draft', json('POST', input), parseRoutineDraft);
}

// ---------- conversation with the Seraphine, proposals, history (phase 6c part 1) ----------

/** A message of the conversation with the Seraphine; `proposal_ids` is missing on an owner message and then reads as `[]`. */
export function checkGuideMessage(value: unknown, where: string): GuideMessage {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  if (typeof value.id !== 'string' || !value.id) bad6a(where, 'id', 'texto', value.id);
  if (value.author !== 'owner' && value.author !== 'seraphine') bad6a(where, 'author', 'owner ou seraphine', value.author);
  if (typeof value.body !== 'string') bad6a(where, 'body', 'texto', value.body);
  if (typeof value.created_at !== 'string') bad6a(where, 'created_at', 'texto', value.created_at);
  const ids = value.proposal_ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))) bad6a(where, 'proposal_ids', 'lista de textos', ids);
  return {
    id: value.id as string,
    author: value.author as GuideMessage['author'],
    body: value.body as string,
    proposal_ids: (ids as string[] | undefined) ?? [],
    created_at: value.created_at as string,
  };
}

/** One field of an agent text change or of a routine change, checked by its name; any other key is not part of the contract and is dropped. */
function checkChangeField(key: string, v: unknown, where: string): unknown {
  switch (key) {
    case 'name':
    case 'role':
    case 'description':
    case 'instructions':
    case 'title':
    case 'prompt':
    case 'schedule_text':
      if (typeof v !== 'string') bad6a(where, key, 'texto', v);
      return v;
    case 'suggestions':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad6a(where, key, 'lista de textos', v);
      return v;
    case 'schedule':
      return checkSchedule(v, `"schedule" de ${where}`);
    case 'report':
      return checkReport(v, where);
    default:
      // `enabled`
      if (typeof v !== 'boolean') bad6a(where, key, 'verdadeiro ou falso', v);
      return v;
  }
}

function readChangeFields(value: Record<string, unknown>, where: string, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = checkChangeField(key, value[key], where);
  }
  return out;
}

const AGENT_CHANGE_KEYS = AGENT_TEXT_FIELDS as readonly string[];
const ROUTINE_CHANGE_KEYS = ['title', 'prompt', 'schedule', 'schedule_text', 'report', 'enabled'] as const;

function checkProposalPayload(kind: GuideProposal['kind'], value: unknown, where: string): ProposalPayload {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava "payload" de ${where} como objeto, mas veio ${describe(value)}`);
  const w = `"payload" de ${where}`;
  switch (kind) {
    case 'create_agents': {
      const agents = value.agents;
      if (!Array.isArray(agents) || agents.length < 1) bad6a(w, 'agents', 'lista com pelo menos um agente', agents);
      return { kind, agents: (agents as unknown[]).map((a, i) => checkDraft(a, `${w}.agents[${i}]`)) };
    }
    case 'update_agent': {
      if (typeof value.agent_id !== 'string' || !value.agent_id) bad6a(w, 'agent_id', 'texto', value.agent_id);
      if (!isRecord(value.changes)) bad6a(w, 'changes', 'objeto', value.changes);
      const changes = readChangeFields(value.changes as Record<string, unknown>, `${w}.changes`, AGENT_CHANGE_KEYS);
      if (Object.keys(changes).length === 0) bad6a(w, 'changes', 'pelo menos um campo', value.changes);
      return { kind, agent_id: value.agent_id as string, changes };
    }
    case 'create_routine': {
      if (typeof value.agent_id !== 'string' || !value.agent_id) bad6a(w, 'agent_id', 'texto', value.agent_id);
      return { kind, agent_id: value.agent_id as string, routine: checkRoutineDraft(value, w) };
    }
    default: {
      if (typeof value.routine_id !== 'string' || !value.routine_id) bad6a(w, 'routine_id', 'texto', value.routine_id);
      if (!isRecord(value.changes)) bad6a(w, 'changes', 'objeto', value.changes);
      const changes = readChangeFields(value.changes as Record<string, unknown>, `${w}.changes`, ROUTINE_CHANGE_KEYS);
      if (Object.keys(changes).length === 0) bad6a(w, 'changes', 'pelo menos um campo', value.changes);
      // The backend also sends the sentence of a changed schedule next to `changes` (output only, optional): the card prefers it.
      if (typeof value.schedule_text === 'string' && changes.schedule_text === undefined && changes.schedule !== undefined) changes.schedule_text = value.schedule_text;
      return { kind: 'update_routine', routine_id: value.routine_id as string, changes };
    }
  }
}

function checkProposalResult(value: unknown, where: string): ProposalResult | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new ShapeMismatch(`esperava "result" de ${where} como objeto ou null, mas veio ${describe(value)}`);
  const out: ProposalResult = {};
  for (const key of ['agent_ids', 'routine_ids'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad6a(`"result" de ${where}`, key, 'lista de textos', v);
    out[key] = v as string[];
  }
  if (value.failed !== undefined) {
    if (!Array.isArray(value.failed)) bad6a(`"result" de ${where}`, 'failed', 'lista', value.failed);
    out.failed = (value.failed as unknown[]).map((f, i) => {
      if (!isRecord(f) || typeof f.name !== 'string' || typeof f.detail !== 'string') {
        throw new ShapeMismatch(`esperava "result".failed[${i}] de ${where} como {name, detail}, mas veio ${describe(f)}`);
      }
      return { name: f.name, detail: f.detail };
    });
  }
  if (value.batch !== undefined) out.batch = checkBatchRef(value.batch, `"batch" de "result" de ${where}`);
  return out;
}

function stringOrNull(value: unknown, where: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad6a(where, field, 'texto ou null', value);
  return value as string;
}

/**
 * A proposal card (contract section 2). `payload` is checked by `kind` and comes out as a union with the kind inside; `before`
 * keeps only the fields of the contract; `detail` reads as '' when the backend sends none (it only sends one for a state that has a reason).
 */
export function checkProposal(value: unknown, where: string): GuideProposal {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  if (typeof value.id !== 'string' || !value.id) bad6a(where, 'id', 'texto', value.id);
  if (!(PROPOSAL_KINDS as readonly unknown[]).includes(value.kind)) {
    bad6a(where, 'kind', 'create_agents, update_agent, create_routine ou update_routine', value.kind);
  }
  if (!(PROPOSAL_STATUSES as readonly unknown[]).includes(value.status)) {
    bad6a(where, 'status', 'pending, applied, dismissed, expired, stale ou failed', value.status);
  }
  if (typeof value.title !== 'string') bad6a(where, 'title', 'texto', value.title);
  const kind = value.kind as GuideProposal['kind'];
  let before: GuideProposal['before'] = null;
  if (value.before !== undefined && value.before !== null) {
    if (!isRecord(value.before)) bad6a(where, 'before', 'objeto ou null', value.before);
    before = readChangeFields(value.before as Record<string, unknown>, `"before" de ${where}`, [...AGENT_CHANGE_KEYS, ...ROUTINE_CHANGE_KEYS]);
  }
  const target: GuideProposal['target'] = {};
  if (value.target !== undefined && value.target !== null) {
    if (!isRecord(value.target)) bad6a(where, 'target', 'objeto', value.target);
    const t = value.target as Record<string, unknown>;
    for (const key of ['agent_id', 'routine_id'] as const) {
      if (t[key] === undefined) continue;
      if (typeof t[key] !== 'string') bad6a(`"target" de ${where}`, key, 'texto', t[key]);
      target[key] = t[key] as string;
    }
  }
  if (value.detail !== undefined && value.detail !== null && typeof value.detail !== 'string') bad6a(where, 'detail', 'texto', value.detail);
  return {
    id: value.id as string,
    kind,
    status: value.status as GuideProposal['status'],
    title: value.title as string,
    payload: checkProposalPayload(kind, value.payload, where),
    before,
    target,
    result: checkProposalResult(value.result, where),
    detail: (value.detail as string | null | undefined) ?? '',
    created_at: stringOrNull(value.created_at, where, 'created_at'),
    expires_at: stringOrNull(value.expires_at, where, 'expires_at'),
    decided_at: stringOrNull(value.decided_at, where, 'decided_at'),
  };
}

function parseGuideConversation(body: unknown): { messages: GuideMessage[]; proposals: GuideProposal[] } {
  const o = record(body);
  if (!Array.isArray(o.messages)) throw new ShapeMismatch(`esperava "messages" como lista, mas veio ${describe(o.messages)}`);
  if (!Array.isArray(o.proposals)) throw new ShapeMismatch(`esperava "proposals" como lista, mas veio ${describe(o.proposals)}`);
  return {
    messages: o.messages.map((m, i) => checkGuideMessage(m, `messages[${i}]`)),
    proposals: o.proposals.map((p, i) => checkProposal(p, `proposals[${i}]`)),
  };
}

function parseGuideSend(body: unknown): { message: GuideMessage; reply: GuideMessage; proposals: GuideProposal[] } {
  const o = record(body);
  if (!Array.isArray(o.proposals)) throw new ShapeMismatch(`esperava "proposals" como lista, mas veio ${describe(o.proposals)}`);
  return {
    message: checkGuideMessage(o.message, '"message"'),
    reply: checkGuideMessage(o.reply, '"reply"'),
    proposals: o.proposals.map((p, i) => checkProposal(p, `proposals[${i}]`)),
  };
}

function parseApplied(body: unknown): { proposal: GuideProposal; agents: Agent[]; routines: Routine[] } {
  const o = record(body);
  if (!Array.isArray(o.agents)) throw new ShapeMismatch(`esperava "agents" como lista, mas veio ${describe(o.agents)}`);
  if (!Array.isArray(o.routines)) throw new ShapeMismatch(`esperava "routines" como lista, mas veio ${describe(o.routines)}`);
  return {
    proposal: checkProposal(o.proposal, '"proposal"'),
    agents: o.agents.map((a, i) => checkAgent(a, `agents[${i}]`)),
    routines: o.routines.map((r, i) => checkRoutine(r, `routines[${i}]`)),
  };
}

/** One version of an agent's text (contract section 3), every field present. */
export function checkAgentVersion(value: unknown, where: string): AgentVersion {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const n = value.version;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) bad6a(where, 'version', 'número inteiro', n);
  for (const field of ['name', 'role', 'description', 'instructions', 'note', 'created_at'] as const) {
    if (typeof value[field] !== 'string') bad6a(where, field, 'texto', value[field]);
  }
  if (!Array.isArray(value.suggestions) || value.suggestions.some((x) => typeof x !== 'string')) bad6a(where, 'suggestions', 'lista de textos', value.suggestions);
  if (!(AGENT_CHANGED_BY as readonly unknown[]).includes(value.changed_by)) bad6a(where, 'changed_by', 'owner, guide, pack ou restore', value.changed_by);
  const fields = value.changed_fields;
  if (!Array.isArray(fields) || fields.some((f) => !(AGENT_TEXT_FIELDS as readonly unknown[]).includes(f))) {
    bad6a(where, 'changed_fields', 'lista de name, role, description, instructions ou suggestions', fields);
  }
  return {
    version: n as number,
    name: value.name as string,
    role: value.role as string,
    description: value.description as string,
    instructions: value.instructions as string,
    suggestions: value.suggestions as string[],
    changed_by: value.changed_by as AgentChangedBy,
    note: value.note as string,
    changed_fields: fields as AgentTextField[],
    created_at: value.created_at as string,
  };
}

function parseVersions(body: unknown): AgentVersion[] {
  return takeArray<unknown>('versions')(body).map((v, i) => checkAgentVersion(v, `versions[${i}]`));
}

function parseRestored(body: unknown): { def: Agent; version: AgentVersion } {
  const o = record(body);
  return { def: checkAgent(o.def, '"def"'), version: checkAgentVersion(o.version, '"version"') };
}

/** The conversation, oldest message first, with every proposal the messages cite. A 404 means a backend without it (the conversation hides). */
export function listGuideMessages(limit = 200): Promise<{ messages: GuideMessage[]; proposals: GuideProposal[] }> {
  return request(`/guide/messages${qs({ limit })}`, GET, parseGuideConversation);
}
/** 503 `guide_unavailable` (the owner's message stays stored), 409 `guide_busy`, 422 invalid body. `about` is sent only when given. */
export function sendGuideMessage(input: { body: string; about?: GuideAbout }): Promise<{ message: GuideMessage; reply: GuideMessage; proposals: GuideProposal[] }> {
  const about = input.about && (input.about.agent_id || input.about.routine_id) ? input.about : undefined;
  return request('/guide/messages', json('POST', { body: input.body, ...(about ? { about } : {}) }), parseGuideSend);
}
export async function clearGuideConversation(): Promise<void> {
  await request('/guide/messages', json('DELETE'), parseOk);
}
/** Applies the proposal. 409 `proposal_not_pending` | `proposal_stale` | `routine_limit`, 422, 404. */
export function applyProposal(id: string): Promise<{ proposal: GuideProposal; agents: Agent[]; routines: Routine[] }> {
  return request(`/guide/proposals/${enc(id)}/apply`, json('POST'), parseApplied);
}
/** 409 `proposal_not_pending`. */
export async function dismissProposal(id: string): Promise<GuideProposal> {
  return request(`/guide/proposals/${enc(id)}/dismiss`, json('POST'), (body) => checkProposal(record(body).proposal, '"proposal"'));
}
/** The versions of an agent, newest first (at most 50). A 404 means a backend without history (the section hides). */
export function listAgentVersions(agentId: string): Promise<AgentVersion[]> {
  return request(`/defs/${enc(agentId)}/versions`, GET, parseVersions);
}
/** Brings the five texts back to what they were in `version` (creates a new version). 404, 409 `version_current`. */
export function restoreAgentVersion(agentId: string, version: number): Promise<{ def: Agent; version: AgentVersion }> {
  return request(`/defs/${enc(agentId)}/versions/${version}/restore`, json('POST'), parseRestored);
}

// ---------- agent page, pause and archive, usage, undo of a team (phase 6c part 2) ----------

function nonNegInt(value: unknown, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) bad6a(where, field, 'número inteiro', value);
  return value as number;
}

function nonNegNumber(value: unknown, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad6a(where, field, 'número', value);
  return value as number;
}

function textOrNull(value: unknown, where: string, field: string): string | null {
  if (value !== null && typeof value !== 'string') bad6a(where, field, 'texto ou null', value);
  return value as string | null;
}

/** The to-do list of an agent: every field present (the route is new, no older answer exists). */
export function checkChecklist(value: unknown, where = '"checklist"'): Checklist {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  if (!Array.isArray(value.items)) bad6a(where, 'items', 'lista', value.items);
  const items = (value.items as unknown[]).map((it, i) => {
    const w = `${where}.items[${i}]`;
    if (!isRecord(it)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(it)}`);
    if (typeof it.id !== 'string' || !it.id) bad6a(w, 'id', 'texto', it.id);
    if (typeof it.done !== 'boolean') bad6a(w, 'done', 'verdadeiro ou falso', it.done);
    if (typeof it.optional !== 'boolean') bad6a(w, 'optional', 'verdadeiro ou falso', it.optional);
    return { id: it.id as string, done: it.done as boolean, optional: it.optional as boolean };
  });
  if (typeof value.dismissed !== 'boolean') bad6a(where, 'dismissed', 'verdadeiro ou falso', value.dismissed);
  return { items, done: nonNegInt(value.done, where, 'done'), total: nonNegInt(value.total, where, 'total'), dismissed: value.dismissed };
}

/** `GET /agents/defs/{id}/page`. */
export function checkAgentPage(value: unknown, where = 'a resposta'): AgentPage {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const engine = value.engine;
  if (!isRecord(engine)) bad6a(where, 'engine', 'objeto', engine);
  const e = engine as Record<string, unknown>;
  if (typeof e.ready !== 'boolean') bad6a('"engine"', 'ready', 'verdadeiro ou falso', e.ready);
  if (typeof e.label !== 'string') bad6a('"engine"', 'label', 'texto', e.label);
  if (typeof e.how !== 'string') bad6a('"engine"', 'how', 'texto', e.how);
  if (!Array.isArray(value.access)) bad6a(where, 'access', 'lista', value.access);
  const access = (value.access as unknown[]).map((a, i) => {
    const w = `access[${i}]`;
    if (!isRecord(a)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(a)}`);
    if (typeof a.group !== 'string' || !a.group) bad6a(w, 'group', 'texto', a.group);
    if (typeof a.label !== 'string') bad6a(w, 'label', 'texto', a.label);
    if (!(GRANT_LEVELS as readonly unknown[]).includes(a.level)) bad6a(w, 'level', 'none, read ou write', a.level);
    return { group: a.group as string, label: a.label as string, level: a.level as GrantLevel };
  });
  const r = value.routines;
  if (!isRecord(r)) bad6a(where, 'routines', 'objeto', r);
  const rr = r as Record<string, unknown>;
  const act = value.activity;
  if (!isRecord(act)) bad6a(where, 'activity', 'objeto', act);
  const a = act as Record<string, unknown>;
  return {
    def: checkAgent(value.def, '"def"'),
    home: value.home === null || value.home === undefined ? null : checkProject(value.home, '"home"'),
    engine: { ready: e.ready as boolean, label: e.label as string, how: e.how as string },
    access,
    routines: { total: nonNegInt(rr.total, '"routines"', 'total'), active: nonNegInt(rr.active, '"routines"', 'active'), next_run_at: textOrNull(rr.next_run_at, '"routines"', 'next_run_at') },
    activity: {
      runs: nonNegInt(a.runs, '"activity"', 'runs'),
      last_run_at: textOrNull(a.last_run_at, '"activity"', 'last_run_at'),
      tokens_in: nonNegInt(a.tokens_in, '"activity"', 'tokens_in'),
      tokens_out: nonNegInt(a.tokens_out, '"activity"', 'tokens_out'),
    },
    checklist: checkChecklist(value.checklist),
  };
}

/** `GET /agents/usage`. */
export function checkUsage(value: unknown, where = 'a resposta'): Usage {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const days = nonNegInt(value.days, where, 'days');
  const t = value.totals;
  if (!isRecord(t)) bad6a(where, 'totals', 'objeto', t);
  const tt = t as Record<string, unknown>;
  if (!Array.isArray(value.agents)) bad6a(where, 'agents', 'lista', value.agents);
  if (!Array.isArray(value.by_day)) bad6a(where, 'by_day', 'lista', value.by_day);
  const agents = (value.agents as unknown[]).map((row, i) => {
    const w = `agents[${i}]`;
    if (!isRecord(row)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(row)}`);
    if (typeof row.agent_id !== 'string' || !row.agent_id) bad6a(w, 'agent_id', 'texto', row.agent_id);
    if (typeof row.name !== 'string') bad6a(w, 'name', 'texto', row.name);
    if (typeof row.archived !== 'boolean') bad6a(w, 'archived', 'verdadeiro ou falso', row.archived);
    if (typeof row.cost_known !== 'boolean') bad6a(w, 'cost_known', 'verdadeiro ou falso', row.cost_known);
    return {
      agent_id: row.agent_id as string,
      name: row.name as string,
      archived: row.archived as boolean,
      runs: nonNegInt(row.runs, w, 'runs'),
      routine_runs: nonNegInt(row.routine_runs, w, 'routine_runs'),
      tokens_in: nonNegInt(row.tokens_in, w, 'tokens_in'),
      tokens_out: nonNegInt(row.tokens_out, w, 'tokens_out'),
      cost_usd: nonNegNumber(row.cost_usd, w, 'cost_usd'),
      cost_known: row.cost_known as boolean,
      last_run_at: textOrNull(row.last_run_at, w, 'last_run_at'),
    };
  });
  const by_day = (value.by_day as unknown[]).map((row, i) => {
    const w = `by_day[${i}]`;
    if (!isRecord(row)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(row)}`);
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) bad6a(w, 'date', 'data AAAA-MM-DD', row.date);
    return {
      date: row.date as string,
      runs: nonNegInt(row.runs, w, 'runs'),
      tokens_in: nonNegInt(row.tokens_in, w, 'tokens_in'),
      tokens_out: nonNegInt(row.tokens_out, w, 'tokens_out'),
      cost_usd: nonNegNumber(row.cost_usd, w, 'cost_usd'),
    };
  });
  return {
    days,
    totals: {
      runs: nonNegInt(tt.runs, '"totals"', 'runs'),
      routine_runs: nonNegInt(tt.routine_runs, '"totals"', 'routine_runs'),
      tokens_in: nonNegInt(tt.tokens_in, '"totals"', 'tokens_in'),
      tokens_out: nonNegInt(tt.tokens_out, '"totals"', 'tokens_out'),
      cost_usd: nonNegNumber(tt.cost_usd, '"totals"', 'cost_usd'),
    },
    agents,
    by_day,
  };
}

/** `{batch}` of `GET /agents/team/batches/{id}`. */
export function checkTeamBatch(value: unknown, where = '"batch"'): TeamBatch {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  if (typeof value.id !== 'string' || !value.id) bad6a(where, 'id', 'texto', value.id);
  if (typeof value.undo_until !== 'string') bad6a(where, 'undo_until', 'texto', value.undo_until);
  if (typeof value.can_undo !== 'boolean') bad6a(where, 'can_undo', 'verdadeiro ou falso', value.can_undo);
  if (!Array.isArray(value.agents)) bad6a(where, 'agents', 'lista', value.agents);
  return {
    id: value.id as string,
    undo_until: value.undo_until as string,
    undone_at: textOrNull(value.undone_at === undefined ? null : value.undone_at, where, 'undone_at'),
    can_undo: value.can_undo as boolean,
    agents: (value.agents as unknown[]).map((a, i) => {
      const w = `${where}.agents[${i}]`;
      if (!isRecord(a)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(a)}`);
      if (typeof a.agent_id !== 'string' || !a.agent_id) bad6a(w, 'agent_id', 'texto', a.agent_id);
      if (typeof a.name !== 'string') bad6a(w, 'name', 'texto', a.name);
      if (typeof a.exists !== 'boolean') bad6a(w, 'exists', 'verdadeiro ou falso', a.exists);
      return { agent_id: a.agent_id as string, name: a.name as string, exists: a.exists as boolean };
    }),
  };
}

/** The outcome of an undo: three lists; `kept` carries the reason of each agent that stayed. */
export function checkTeamUndoResult(value: unknown, where = 'a resposta'): TeamUndoResult {
  if (!isRecord(value)) throw new ShapeMismatch(`esperava ${where} como objeto, mas veio ${describe(value)}`);
  const pair = (key: 'removed' | 'archived'): { agent_id: string; name: string }[] => {
    const list = value[key];
    if (!Array.isArray(list)) bad6a(where, key, 'lista', list);
    return (list as unknown[]).map((a, i) => {
      const w = `${key}[${i}]`;
      if (!isRecord(a)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(a)}`);
      if (typeof a.agent_id !== 'string' || !a.agent_id) bad6a(w, 'agent_id', 'texto', a.agent_id);
      if (typeof a.name !== 'string') bad6a(w, 'name', 'texto', a.name);
      return { agent_id: a.agent_id as string, name: a.name as string };
    });
  };
  if (!Array.isArray(value.kept)) bad6a(where, 'kept', 'lista', value.kept);
  const kept = (value.kept as unknown[]).map((a, i) => {
    const w = `kept[${i}]`;
    if (!isRecord(a)) throw new ShapeMismatch(`esperava ${w} como objeto, mas veio ${describe(a)}`);
    if (typeof a.agent_id !== 'string' || !a.agent_id) bad6a(w, 'agent_id', 'texto', a.agent_id);
    if (typeof a.name !== 'string') bad6a(w, 'name', 'texto', a.name);
    if (typeof a.detail !== 'string') bad6a(w, 'detail', 'texto', a.detail);
    return { agent_id: a.agent_id as string, name: a.name as string, detail: a.detail as string };
  });
  return { removed: pair('removed'), archived: pair('archived'), kept };
}

/** Archives the agent (and its home). 409 `agent_busy` while a run is in progress; asking again changes nothing. */
export function archiveAgent(id: string): Promise<Agent> {
  return request(`/defs/${enc(id)}/archive`, json('POST'), parseAgent);
}
/** Brings the agent and its home back as they were. */
export function unarchiveAgent(id: string): Promise<Agent> {
  return request(`/defs/${enc(id)}/unarchive`, json('POST'), parseAgent);
}
/** Everything the "Sobre" tab shows. A 404 means a backend without it (the tab and the checklist hide). */
export function getAgentPage(id: string): Promise<AgentPage> {
  return request(`/defs/${enc(id)}/page`, GET, (body) => checkAgentPage(body));
}
/** Partial body; the answer is the whole checklist. */
export function putAgentChecklist(id: string, patch: ChecklistPatch): Promise<Checklist> {
  return request(`/defs/${enc(id)}/checklist`, json('PUT', patch), (body) => checkChecklist(takeObject<unknown>('checklist')(body)));
}
/** `days` is 7, 30 or 90. A 404 means a backend without it (the usage block hides). */
export function getUsage(days = 30): Promise<Usage> {
  return request(`/usage${qs({ days })}`, GET, (body) => checkUsage(body));
}
/** A 404 means a backend without batches (or an unknown batch): the undo hides. */
export function getTeamBatch(id: string): Promise<TeamBatch> {
  return request(`/team/batches/${enc(id)}`, GET, (body) => checkTeamBatch(takeObject<unknown>('batch')(body)));
}
/** 404; 409 `undo_expired` | `already_undone`. */
export function undoTeamBatch(id: string): Promise<TeamUndoResult> {
  return request(`/team/batches/${enc(id)}/undo`, json('POST'), (body) => checkTeamUndoResult(body));
}

// ---------- tools and grants (step 3b) ----------

export function getAgentTools(): Promise<ToolGroup[]> {
  return request('/tools', GET, parseTools);
}
export function getAgentGrants(id: string): Promise<Grants> {
  return request(`/defs/${enc(id)}/grants`, GET, parseGrants);
}
/** Partial bodies are fine; the answer is the full set of the agent. 422 for an unknown group or level. */
export function setAgentGrants(id: string, grants: Grants): Promise<Grants> {
  return request(`/defs/${enc(id)}/grants`, json('PUT', { grants }), parseGrants);
}
export async function deleteAgent(id: string): Promise<void> {
  await request(`/defs/${enc(id)}`, json('DELETE'), parseOk);
}

// ---------- actions and receipts (step 3c) ----------

/** The writes a run made. */
export function listRunActions(runId: string): Promise<AgentAction[]> {
  return request(`/actions${qs({ run_id: runId })}`, GET, parseActions);
}
/** Undo a write (no body). 409 `code`: undo_expired | already_undone | undo_conflict. */
export function undoAction(id: string): Promise<AgentAction> {
  return request(`/actions/${enc(id)}/undo`, json('POST'), parseAction);
}

// ---------- the Seraphine's tools inside the engines (step 3c) ----------

export function getBridgeStatus(): Promise<BridgeEngineStatus[]> {
  return request('/bridge/status', GET, parseBridgeStatus);
}
/** Runs one short, real turn of the engine: uses a little of the owner's plan. 409 `test_running` while another test runs. */
export function testBridge(engine: string): Promise<BridgeTestResult> {
  return request('/bridge/test', json('POST', { engine }), parseBridgeTest);
}

// ---------- messages ----------

/** `after` is a message id (uuid): returns the messages stored after that one. */
export function listMessages(
  projectId: string,
  opts: { after?: string; limit?: number } = {},
): Promise<Message[]> {
  return request(
    `/projects/${enc(projectId)}/messages${qs({ after: opts.after, limit: opts.limit })}`,
    GET,
    parseMessages,
  );
}

/** `mode` goes on the wire only when it is not the default (`join`), `fresh` only when true ("Começar do zero"). */
export function sendMessage(
  projectId: string,
  input: { body: string; agent_id?: string; task_id?: string; mode?: SendMode; fresh?: boolean },
): Promise<SendMessageResult> {
  const { mode, fresh, ...rest } = input;
  const body = { ...rest, ...(mode && mode !== 'join' ? { mode } : {}), ...(fresh === true ? { fresh: true } : {}) };
  return request(`/projects/${enc(projectId)}/messages`, json('POST', body), parseSendResult);
}

// ---------- tasks ----------

export function listTasks(opts: { project_id?: string; status?: string } = {}): Promise<Task[]> {
  return request(`/tasks${qs(opts)}`, GET, takeArray<Task>('tasks'));
}
export function createTask(input: TaskInput): Promise<Task> {
  return request('/tasks', json('POST', input), takeObject<Task>('task'));
}
export function getTask(id: string): Promise<Task> {
  return request(`/tasks/${enc(id)}`, GET, takeObject<Task>('task'));
}
export function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  return request(`/tasks/${enc(id)}`, json('PATCH', patch), takeObject<Task>('task'));
}
export function listTaskMessages(id: string): Promise<Message[]> {
  return request(`/tasks/${enc(id)}/messages`, GET, parseMessages);
}
export function runTask(id: string, agentId: string): Promise<Run> {
  return request(`/tasks/${enc(id)}/run`, json('POST', { agent_id: agentId }), parseRun);
}

// ---------- runs ----------

export function createRun(input: {
  agent_id: string;
  project_id: string;
  goal: string;
  task_id?: string;
}): Promise<Run> {
  return request('/runs', json('POST', input), parseRun);
}
export function listRuns(
  opts: { project_id?: string; status?: string; limit?: number } = {},
): Promise<Run[]> {
  return request(`/runs${qs(opts)}`, GET, parseRuns);
}
export function getRun(id: string): Promise<Run> {
  return request(`/runs/${enc(id)}`, GET, parseRun);
}
/** `after` is the integer id of the last event already known. */
export function listRunEvents(id: string, after?: number): Promise<HarnessEvent[]> {
  return request(`/runs/${enc(id)}/events${qs({ after })}`, GET, takeArray<HarnessEvent>('events'));
}
export function cancelRun(id: string): Promise<Run> {
  return request(`/runs/${enc(id)}/cancel`, json('POST'), parseRun);
}
/** Creates a NEW run that continues `id` (no body); resolves with the new run. 409s carry a `code`. */
export function continueRun(id: string): Promise<Run> {
  return request(`/runs/${enc(id)}/continue`, json('POST'), parseRun);
}

/** Takes a parked run out of parking and queues it now (no body). 409 `not_parked` when it is not parked. */
export function wakeRun(id: string): Promise<Run> {
  return request(`/runs/${enc(id)}/wake`, json('POST'), parseRun);
}

// ---------- approvals ----------

export function listApprovals(status = 'pending'): Promise<Approval[]> {
  return request(`/approvals${qs({ status })}`, GET, parseApprovals);
}
/**
 * `digest` ties the decision to the exact command the owner saw. Fields that do
 * not apply are left out of the body (`confirm_high_risk` only when true).
 */
export function decideApproval(id: string, decision: Decision, opts: DecideOptions = {}): Promise<Approval> {
  const body = {
    decision,
    ...(opts.digest ? { digest: opts.digest } : {}),
    ...(opts.confirmHighRisk ? { confirm_high_risk: true } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
  return request(`/approvals/${enc(id)}/decide`, json('POST', body), parseApproval);
}

// ---------- live event channel (WebSocket) ----------

/** Minimal shape check: string `id` and `project_id` (and `status` for runs). */
function hasIds(value: unknown, withStatus: boolean): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.project_id === 'string' &&
    (!withStatus || typeof value.status === 'string')
  );
}

/** A `{"type":"event"}` line with the documented fields (`id` is an integer). */
function isEventLine(value: unknown): value is Extract<StreamLine, { type: 'event' }> {
  return (
    isRecord(value) &&
    value.type === 'event' &&
    typeof value.id === 'number' &&
    typeof value.run_id === 'string' &&
    typeof value.ts === 'string' &&
    typeof value.kind === 'string' &&
    isRecord(value.payload)
  );
}

// Valid frames that carry nothing the reducers need: keep-alive, the pong
// answering our ping.
const IGNORED_FRAME_TYPES = new Set(['heartbeat', 'pong']);

export interface StreamOptions {
  /** First reconnect delay; doubles up to `maxDelayMs`. Reset once `ready` arrives. */
  minDelayMs?: number;
  maxDelayMs?: number;
  onStatus?: (connected: boolean) => void;
  /** A message was stored (owner, agent or system note), possibly by a run this page did not start. */
  onMessage?: (message: Message) => void;
  /** The `delivery` of a message changed (read by the agent, or the work ended first). */
  onMessageUpdate?: (message: Message) => void;
  /** A run row changed (created, started, parked, finished, cancelled). */
  onRunUpdate?: (run: Run) => void;
  /** An action (receipt) changed: undone here or on another screen. */
  onActionUpdate?: (action: AgentAction) => void;
  /** A routine was created, changed, ran or paused (phase 6b). */
  onRoutineUpdate?: (routine: Routine) => void;
  /** A routine was deleted (phase 6b). */
  onRoutineDeleted?: (id: string) => void;
  /** Bootstrap or the endpoint says the harness is off; the loop stops. */
  onDisabled?: () => void;
  /** A frame's `seq` skipped ahead: frames were lost. Called once per gap, never once per later frame. */
  onGap?: () => void;
  /** The `boot` of a connection differs from the one seen before: the backend restarted. Called when it is first seen. */
  onBootChange?: () => void;
}

const PING_EVERY_MS = 25_000;
const DEAD_AFTER_MS = 60_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN_ORIGIN = 4403;
const CLOSE_DISABLED = 4404;

function socketUrl(): string {
  const path = '/agents/ws';
  if (API_BASE) return `${API_BASE.replace(/^http/i, 'ws')}${path}`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

/**
 * Follow the harness' live events over `WS /agents/ws` until the returned
 * `stop()` is called. A WebSocket (unlike a long-lived `fetch`) does not hold
 * one of the browser's 6 HTTP connections per host. The token travels in the
 * first frame, never in the URL. Connected = the server answered `ready`.
 * Reconnects with exponential backoff; only well-formed `{type:'event'}`
 * frames reach `onEvent`, anything outside the contract is `console.warn`ed once.
 */
export function openGlobalSocket(
  onEvent: (event: HarnessEvent) => void,
  opts: StreamOptions = {},
): () => void {
  const minDelay = opts.minDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 15000;
  let stopped = false;
  let current: WebSocket | null = null;
  let delay = minDelay;
  let retriedAfter401 = false;
  let warned = false;
  // `boot` outlives a connection (a new one is compared with the last); `seq` is per connection.
  let lastBoot: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let deadTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (deadTimer) clearTimeout(deadTimer);
    reconnectTimer = pingTimer = deadTimer = null;
  };

  const detach = (ws: WebSocket): void => {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  };

  const halt = (): void => {
    stopped = true;
    clearTimers();
    if (current) {
      const ws = current;
      current = null;
      detach(ws);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, maxDelay);
  };

  /** The socket ended (closed by either side): decide what comes next. */
  const handleEnd = (ws: WebSocket, code: number): void => {
    if (stopped || ws !== current) return;
    current = null;
    detach(ws);
    clearTimers();
    opts.onStatus?.(false);
    if (code === CLOSE_DISABLED) {
      halt();
      opts.onDisabled?.();
      return;
    }
    if (code === CLOSE_FORBIDDEN_ORIGIN) {
      halt();
      return;
    }
    if (code === CLOSE_UNAUTHORIZED) {
      resetToken();
      if (!retriedAfter401) {
        retriedAfter401 = true;
        connect();
        return;
      }
    }
    scheduleReconnect();
  };

  const armDeadTimer = (ws: WebSocket): void => {
    if (deadTimer) clearTimeout(deadTimer);
    deadTimer = setTimeout(() => {
      // No frame for too long (heartbeats arrive every ~15s): the socket is dead.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      handleEnd(ws, 0);
    }, DEAD_AFTER_MS);
  };

  const onFrame = (obj: unknown, ready: () => void): void => {
    if (isEventLine(obj)) {
      // `boot` and `seq` belong to the frame, not to the stored event.
      const { type: _type, boot: _boot, seq: _seq, ...event } = obj as typeof obj & { boot?: unknown; seq?: unknown };
      onEvent(event);
      return;
    }
    const type = isRecord(obj) ? obj.type : undefined;
    if (type === 'ready') {
      ready();
      return;
    }
    if ((type === 'message' || type === 'message_update') && isRecord(obj) && hasIds(obj.message, false)) {
      try {
        const message = checkMessage(obj.message, '"message"');
        if (type === 'message') opts.onMessage?.(message);
        else opts.onMessageUpdate?.(message);
        return;
      } catch (err) {
        if (!(err instanceof ShapeMismatch)) throw err;
      }
    }
    if (type === 'run_update' && isRecord(obj) && hasIds(obj.run, true)) {
      try {
        opts.onRunUpdate?.(checkRun(obj.run, '"run"'));
        return;
      } catch (err) {
        if (!(err instanceof ShapeMismatch)) throw err;
      }
    }
    if (type === 'action_update' && isRecord(obj)) {
      try {
        opts.onActionUpdate?.(checkAction(obj.action, '"action"'));
        return;
      } catch (err) {
        if (!(err instanceof ShapeMismatch)) throw err;
      }
    }
    if (type === 'routine_update' && isRecord(obj)) {
      try {
        opts.onRoutineUpdate?.(checkRoutine(obj.routine, '"routine"'));
        return;
      } catch (err) {
        if (!(err instanceof ShapeMismatch)) throw err;
      }
    }
    if (type === 'routine_deleted' && isRecord(obj) && typeof obj.id === 'string' && obj.id) {
      opts.onRoutineDeleted?.(obj.id);
      return;
    }
    if (typeof type !== 'string' || !IGNORED_FRAME_TYPES.has(type)) {
      if (!warned) {
        warned = true;
        console.warn('agents socket: frame fora do contrato ignorado', type ?? describe(obj));
      }
    }
  };

  function connect(): void {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    current = ws;
    let isReady = false;
    let lastSeq: number | null = null;

    /** Frames without `seq` / `boot` (an older backend) change nothing: tracking stays off for them. */
    const track = (obj: unknown): void => {
      if (!isRecord(obj)) return;
      if (typeof obj.boot === 'string' && obj.boot) {
        const changed = lastBoot !== null && obj.boot !== lastBoot;
        lastBoot = obj.boot;
        if (changed) opts.onBootChange?.();
      }
      const { seq } = obj;
      if (typeof seq === 'number' && Number.isInteger(seq)) {
        // The first frame of a connection is only the baseline: whatever came before `ready` is covered by the resync of the reconnection.
        const gap = lastSeq !== null && seq !== lastSeq + 1;
        lastSeq = seq;
        if (gap) opts.onGap?.();
      }
    };

    ws.onopen = () => {
      if (stopped || ws !== current) return;
      armDeadTimer(ws);
      pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send('{"type":"ping"}');
      }, PING_EVERY_MS);
      ensureToken().then(
        (t) => {
          if (stopped || ws !== current) return;
          ws.send(JSON.stringify({ type: 'auth', token: t }));
        },
        () => {
          // Bootstrap failed: the harness is off or unreachable.
          if (stopped || ws !== current) return;
          halt();
          opts.onDisabled?.();
        },
      );
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (stopped || ws !== current) return;
      armDeadTimer(ws);
      if (typeof ev.data !== 'string') return;
      let obj: unknown;
      try {
        obj = JSON.parse(ev.data);
      } catch {
        return;
      }
      track(obj);
      onFrame(obj, () => {
        if (isReady) return;
        isReady = true;
        delay = minDelay;
        retriedAfter401 = false;
        opts.onStatus?.(true);
      });
    };

    ws.onclose = (ev: CloseEvent) => handleEnd(ws, ev.code);
    // `error` is always followed by `close`, which does the work.
    ws.onerror = () => undefined;
  }

  connect();
  return halt;
}
