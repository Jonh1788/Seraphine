/**
 * Zustand store for the agents space: route inside the space, entities,
 * live events per run and pending approvals. `init()` bootstraps the token,
 * loads the overview and opens the live WebSocket.
 */
import { create } from 'zustand';
import * as api from './api';
import { ApiError, HarnessDisabledError } from './api';
import {
  BRIDGE_TEST_FAILED_MESSAGE,
  BRIDGE_TEST_RUNNING_MESSAGE,
  UNDO_FINAL_CODES,
  approvalErrorMessage,
  bridgeTestLine,
  continueErrorMessage,
  grantsErrorMessage,
  inboxFullMessage,
  mergeEvents,
  reduceEvent,
  undoErrorMessage,
  wakeErrorMessage,
} from './lib';
import { GUIDE_BUSY_MESSAGE, GUIDE_UNAVAILABLE_MESSAGE, proposalErrorMessage, versionErrorMessage } from './guide';
import { routineErrorMessage } from './routines';
import { agentActionError, archivedSendSentence, undoErrorSentence } from './agentPage';
import type {
  Agent,
  AgentAction,
  AgentDraft,
  AgentInput,
  AgentPage,
  AgentVersion,
  Approval,
  BridgeEngineStatus,
  ChecklistPatch,
  Decision,
  EngineInfo,
  Grants,
  GuideAbout,
  GuideMessage,
  GuideProposal,
  HarnessEvent,
  Message,
  Project,
  ProviderInfo,
  ProjectInput,
  Routine,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  Run,
  SendMode,
  Setup,
  SetupPatch,
  SpendRow,
  Task,
  TaskPatch,
  TeamResult,
  TeamUndoResult,
  ToolGroup,
  Usage,
} from './types';
import { ACTIVE_RUN_STATUSES } from './types';

export type HarnessState = 'loading' | 'ready' | 'disabled' | 'error';

/** The three sections of the settings screen. */
export type SettingsTab = 'ai' | 'access' | 'space';

/** What the undo of a team left behind, by batch id: the outcome, or the reason it can no longer be done. */
export type TeamUndoEntry =
  | ({ phase: 'done' } & TeamUndoResult)
  | { phase: 'closed'; code: 'undo_expired' | 'already_undone'; text: string };

export interface AgentsRoute {
  screen: 'home' | 'project' | 'roster' | 'task' | 'setup' | 'routines' | 'guide' | 'settings';
  projectId?: string;
  /** Project (an agent's home) only: open this tab instead of the conversation. */
  tab?: 'routines' | 'about';
  /** Settings only (phase 6c part 2): the section to open; `agentId` then marks the row to highlight in the access table. */
  settingsTab?: SettingsTab;
  taskId?: string;
  agentId?: string;
  /** Roster only: open the agent's form already at this section ("Dar acesso" on a denied tool, "Ver o histórico" on an applied proposal). */
  section?: 'tools' | 'history';
  /** Roster only: open the form blank, to create an agent from scratch. */
  newAgent?: boolean;
  /** Guide only (phase 6c): text to put in the composer when the screen opens ("Sobre Bia: "). */
  prefill?: string;
  /** Guide only: what the first message is about (sent with that message only). */
  about?: GuideAbout;
}

/** A message of the owner that is on its way (or did not get an answer): it shows in the conversation until the exchange is stored. */
export interface GuideOutbox {
  text: string;
  about?: GuideAbout;
  /** `failed`: the Seraphine could not answer (503); the message is stored on the backend and "Tentar de novo" sends the same text again. */
  phase: 'sending' | 'failed';
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Machine code of a refused decision (`digest_mismatch`, `already_decided`, ...), when the backend sent one. */
  code?: string;
}

export interface DecideExtras {
  /** Second, explicit click on a high-risk request. */
  confirmHighRisk?: boolean;
  /** Reason for a denial (max 500 characters). */
  note?: string;
}

/** What the "Ferramentas da Seraphine nos agentes" panel knows. `unavailable`: a backend without that route (the panel hides). */
export interface BridgePanelState {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  engines: BridgeEngineStatus[];
}

/** The sentence a finished test leaves in its engine's row. */
export interface BridgeTestOutcome {
  ok: boolean;
  text: string;
}

interface AgentsState {
  harnessState: HarnessState;
  error: string | null;
  route: AgentsRoute;
  projects: Project[];
  agents: Agent[];
  engines: EngineInfo[];
  providers: ProviderInfo[];
  /** Catalogue of the Seraphine's tools by group (step 3b); loaded at init and on resync. */
  tools: ToolGroup[];
  /** `loading` until the first answer; `error` keeps the last known list. */
  toolsState: 'loading' | 'ready' | 'error';
  runs: Record<string, Run>;
  approvals: Record<string, Approval>;
  eventsByRun: Record<string, HarnessEvent[]>;
  messagesByProject: Record<string, Message[]>;
  messagesByTask: Record<string, Message[]>;
  tasksByProject: Record<string, Task[]>;
  tasksById: Record<string, Task>;
  spendToday: SpendRow[];
  streamConnected: boolean;
  /** A resync is in flight: what is shown stays until the fresh data lands. */
  resyncing: boolean;
  /** The writes agents made (receipts), by action id; fed by `GET /actions`, undo answers and `action_update` frames. */
  actionsById: Record<string, AgentAction>;
  /** Runs whose actions were already asked for. */
  actionsLoadedRuns: Record<string, true>;
  /** Undo requests in flight, by action id (every button of the same action shows the progress). */
  undoingIds: Record<string, true>;
  /** The last refusal of an undo, by action id. */
  undoErrors: Record<string, { text: string; code: string }>;
  bridge: BridgePanelState;
  /** Engine whose test is running, and what the last test of each engine said. */
  bridgeRunning: string | null;
  bridgeResults: Record<string, BridgeTestOutcome>;
  /** Phase 6a: the first-steps answers and steps. `unavailable`: a backend without the route (the features hide). */
  setup: Setup | null;
  setupState: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  /** The first-steps screen opens by itself at most once per page load. */
  setupAutoOpened: boolean;
  /** The "Seus agentes" dialog is open. */
  builderOpen: boolean;
  /** Why an agent's conversation could not be opened (sidebar click). */
  homeError: string | null;
  /** Phase 6b: routines by id. `unavailable`: a backend without the route (every routines feature hides). */
  routines: Record<string, Routine>;
  routinesState: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  /** Ledger lines by routine id, once asked for ("Ver execuções", the failure-pause reason). */
  routineRuns: Record<string, RoutineRun[]>;
  /** Phase 6c: the conversation with the Seraphine, oldest first, and its proposals by id. `unavailable`: a backend without it (the entries hide). */
  guideMessages: GuideMessage[];
  guideProposals: Record<string, GuideProposal>;
  guideState: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  guideOutbox: GuideOutbox | null;
  /** The backend answered 404 to the history route: the "Histórico" section hides. */
  versionsUnavailable: boolean;
  /** Phase 6c part 2: archived agents (flagged `archived: true`); `agents` only holds the live ones. Loaded when the roster asks for them and kept up to date by archive, restore and undo. */
  archivedAgents: Agent[];
  archivedState: 'idle' | 'loading' | 'ready' | 'error';
  /** The page of each agent (the "Sobre" tab and the checklist read it). `pagesUnavailable`: a backend without the route (both hide). */
  agentPages: Record<string, AgentPage>;
  pagesUnavailable: boolean;
  /** Usage of the window `usageDays`; `unavailable`: a backend without the route (the block hides). */
  usage: Usage | null;
  usageState: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  usageDays: number;
  /** Undo of a team, by batch id. */
  teamUndo: Record<string, TeamUndoEntry>;
}

export interface VersionsResult extends ActionResult {
  versions?: AgentVersion[];
}

interface AgentsActions {
  init: () => Promise<void>;
  retry: () => Promise<void>;
  dispose: () => void;
  navigate: (route: AgentsRoute) => void;
  /** Re-check which providers are usable (keys, logins, local servers). */
  refreshProviders: () => Promise<void>;
  /** Load the catalogue of tools (again). A failure keeps the last known list and marks `toolsState: 'error'`. */
  loadTools: () => Promise<void>;
  refreshOverview: () => Promise<void>;
  /**
   * Bring everything the page shows up to date after frames may have been lost (a gap, a new backend boot, a reconnection):
   * overview, the runs of the open projects, the events after the last known id of every run whose events are loaded,
   * and the loaded message lists. Calls made while one is in flight share it. Nothing is cleared while it runs.
   */
  resync: () => Promise<void>;
  handleEvent: (ev: HarnessEvent) => void;
  handleMessage: (message: Message) => void;
  /** The `delivery` of a stored message changed: replace it where it is. */
  handleMessageUpdate: (message: Message) => void;
  handleRunUpdate: (run: Run) => void;
  loadProject: (projectId: string) => Promise<void>;
  refreshMessages: (projectId: string) => Promise<void>;
  loadRunEvents: (runId: string) => Promise<void>;
  sendMessage: (
    projectId: string,
    body: string,
    agentId: string,
    taskId?: string,
    mode?: SendMode,
    /** "Começar do zero": the run this message creates starts a new conversation, with no history. */
    fresh?: boolean,
  ) => Promise<ActionResult>;
  decideApproval: (id: string, decision: Decision, extras?: DecideExtras) => Promise<ActionResult>;
  cancelRun: (id: string) => Promise<ActionResult>;
  /** Continue an interrupted (or stopped) run: adds the new run and links the old one to it. */
  continueRun: (id: string) => Promise<ActionResult>;
  /** Take a parked run out of parking now ("Tentar agora" / "Tentar de novo"). */
  wakeRun: (id: string) => Promise<ActionResult>;
  /** Load the receipts of a run (once, unless `force`). A failure leaves what is known. */
  loadRunActions: (runId: string, force?: boolean) => Promise<void>;
  /** An action changed (live frame). */
  handleActionUpdate: (action: AgentAction) => void;
  /** Undo a write. One request per action at a time; the refusals (409) become sentences in `undoErrors`. */
  undoAction: (id: string) => Promise<ActionResult>;
  loadBridge: () => Promise<void>;
  /** Run a test of the Seraphine's tools in one engine. Only one test at a time. */
  testBridge: (engine: string) => Promise<ActionResult>;
  createProject: (input: ProjectInput) => Promise<ActionResult>;
  archiveProject: (id: string) => Promise<ActionResult>;
  saveAgent: (id: string | null, input: AgentInput) => Promise<ActionResult & { agent?: Agent }>;
  /** Save what the agent may consult; the agent is updated from the answer. A 422 becomes a sentence. */
  saveGrants: (agentId: string, grants: Grants) => Promise<ActionResult>;
  deleteAgent: (id: string) => Promise<ActionResult>;
  loadTask: (taskId: string) => Promise<void>;
  createTask: (projectId: string, title: string, description?: string) => Promise<ActionResult & { task?: Task }>;
  patchTask: (taskId: string, patch: TaskPatch) => Promise<ActionResult>;
  runTask: (taskId: string, agentId: string) => Promise<ActionResult>;
  /** Phase 6a. A failure keeps the last known setup; a backend without the route marks it `unavailable`. */
  loadSetup: () => Promise<void>;
  saveSetup: (patch: SetupPatch) => Promise<ActionResult>;
  markSetupAutoOpened: () => void;
  /** Re-read engines, providers and the setup (after the owner logged in somewhere else). */
  recheckEngines: () => Promise<void>;
  /** Open the "Seus agentes" dialog (a backend without the setup route goes straight to the blank form). */
  openBuilder: () => void;
  closeBuilder: () => void;
  /** Make sure the agent's home exists, then open that conversation (or its "Rotinas" tab). */
  openAgentConversation: (agentId: string, tab?: 'routines') => Promise<ActionResult>;
  /** Phase 6c. A failure keeps what is there; a 404 marks the conversation `unavailable`. */
  loadGuide: () => Promise<void>;
  /** Send a message to the Seraphine. A 503 keeps the message (`guideOutbox.phase: 'failed'`); other refusals give the text back (`ok: false`, `error`). */
  sendGuide: (text: string, about?: GuideAbout) => Promise<ActionResult>;
  /** "Tentar de novo": send the failed message again, same text. */
  retryGuide: () => Promise<ActionResult>;
  clearGuide: () => Promise<ActionResult>;
  /** Apply a proposal: merges the returned agents and routines. A refusal (409, 422) re-reads the conversation so the card shows the real state. */
  applyProposal: (id: string) => Promise<ActionResult>;
  dismissProposal: (id: string) => Promise<ActionResult>;
  /** The versions of an agent (newest first); a 404 hides the history section for good. */
  loadAgentVersions: (agentId: string) => Promise<VersionsResult>;
  /** Back to a version: the agent is replaced by the answer. */
  restoreAgentVersion: (agentId: string, version: number) => Promise<ActionResult & { agent?: Agent }>;
  /** Create a ready or proposed team; adds what was created to the lists. */
  createTeam: (origin: string, agents: AgentDraft[]) => Promise<ActionResult & { result?: TeamResult }>;
  /** Phase 6b. A failure keeps the last known list; a 404 marks the feature `unavailable`. */
  loadRoutines: () => Promise<void>;
  /** The refusals (409 `routine_limit`, 422) come back as pt-BR sentences in `error`. */
  createRoutine: (input: RoutineInput) => Promise<ActionResult & { routine?: Routine }>;
  updateRoutine: (id: string, patch: RoutinePatch) => Promise<ActionResult & { routine?: Routine }>;
  removeRoutine: (id: string) => Promise<ActionResult>;
  /** "Rodar agora": adds the routine and the run it started. */
  runRoutine: (id: string) => Promise<ActionResult>;
  /** The copy is born turned off. */
  copyRoutine: (id: string) => Promise<ActionResult & { routine?: Routine }>;
  /** Load (or reload) the ledger of a routine: the last 20 lines. */
  loadRoutineRuns: (id: string) => Promise<ActionResult>;
  handleRoutineUpdate: (routine: Routine) => void;
  handleRoutineDeleted: (id: string) => void;
  /** Phase 6c part 2. Reads the page of an agent; a 404 marks the feature `pagesUnavailable`. */
  loadAgentPage: (agentId: string) => Promise<ActionResult>;
  /** Partial body; the page's checklist is replaced by the answer. */
  saveChecklist: (agentId: string, patch: ChecklistPatch) => Promise<ActionResult>;
  /** "Pausar" / "Retomar": a PATCH of `enabled`. Refusals become sentences. */
  setAgentPaused: (agentId: string, paused: boolean) => Promise<ActionResult>;
  /** "Arquivar": the agent leaves the lists and its home leaves the projects; 409 `agent_busy` becomes a sentence. */
  archiveAgent: (agentId: string) => Promise<ActionResult>;
  /** "Restaurar": everything comes back as it was. */
  restoreAgent: (agentId: string) => Promise<ActionResult>;
  loadArchivedAgents: () => Promise<void>;
  loadUsage: (days?: number) => Promise<void>;
  /** "Desfazer a criação": updates the lists from the outcome; the refusals (`undo_expired`, `already_undone`) are kept in `teamUndo`. */
  undoTeam: (batchId: string) => Promise<ActionResult>;
}

export type AgentsStore = AgentsState & AgentsActions;

const initialState = (): AgentsState => ({
  harnessState: 'loading',
  error: null,
  route: { screen: 'home' },
  projects: [],
  agents: [],
  engines: [],
  providers: [],
  tools: [],
  toolsState: 'loading',
  runs: {},
  approvals: {},
  eventsByRun: {},
  messagesByProject: {},
  messagesByTask: {},
  tasksByProject: {},
  tasksById: {},
  spendToday: [],
  streamConnected: false,
  resyncing: false,
  actionsById: {},
  actionsLoadedRuns: {},
  undoingIds: {},
  undoErrors: {},
  bridge: { state: 'idle', engines: [] },
  bridgeRunning: null,
  bridgeResults: {},
  setup: null,
  setupState: 'idle',
  setupAutoOpened: false,
  builderOpen: false,
  homeError: null,
  routines: {},
  routinesState: 'idle',
  routineRuns: {},
  guideMessages: [],
  guideProposals: {},
  guideState: 'idle',
  guideOutbox: null,
  versionsUnavailable: false,
  archivedAgents: [],
  archivedState: 'idle',
  agentPages: {},
  pagesUnavailable: false,
  usage: null,
  usageState: 'idle',
  usageDays: 30,
  teamUndo: {},
});

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.detail || e.message;
  if (e instanceof Error) return e.message;
  return 'Algo deu errado. Tente de novo.';
}

export function pendingApprovalsOf(approvals: Record<string, Approval>): Approval[] {
  return Object.values(approvals)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export function countPending(approvals: Record<string, Approval>): number {
  let n = 0;
  for (const a of Object.values(approvals)) if (a.status === 'pending') n += 1;
  return n;
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of list) out[item.id] = item;
  return out;
}

function appendUnique(list: Message[], incoming: Message[]): Message[] {
  const ids = new Set(list.map((m) => m.id));
  const fresh = incoming.filter((m) => !ids.has(m.id));
  return fresh.length ? [...list, ...fresh] : list;
}

/** Prefer the incoming row, unless it would regress a terminal run to an active one. */
function mergeRun(prev: Run | undefined, incoming: Run): Run {
  if (prev && !ACTIVE_RUN_STATUSES.includes(prev.status) && ACTIVE_RUN_STATUSES.includes(incoming.status)) return prev;
  return incoming;
}

// Module-level handles: only one socket / init flight per page.
let stopSocket: (() => void) | null = null;
let lifecycleBound = false;
let initFlight: Promise<void> | null = null;
let didInit = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const eventsInFlight = new Set<string>();
const runsInFlight = new Set<string>();
let resyncFlight: Promise<void> | null = null;
const undoFlight = new Set<string>();
const actionsInFlight = new Set<string>();
const routineRunsInFlight = new Set<string>();
const proposalsInFlight = new Set<string>();
let guideSendFlight = false;
const undoTeamFlight = new Set<string>();
let usageSeq = 0;

/** Append what is new keeping the order the backend gave (a reply always comes after its message). */
function appendGuideMessages(list: GuideMessage[], incoming: GuideMessage[]): GuideMessage[] {
  const ids = new Set(list.map((m) => m.id));
  const fresh = incoming.filter((m) => !ids.has(m.id));
  return fresh.length ? [...list, ...fresh] : list;
}

/** Replace the agents that came back (by id) and add the new ones; an archived one leaves the live list (`agents` never holds archived agents). */
function mergeAgents(list: Agent[], incoming: Agent[]): Agent[] {
  const live = incoming.filter((a) => !a.archived);
  const archivedIds = new Set(incoming.filter((a) => a.archived).map((a) => a.id));
  const known = new Set(list.map((a) => a.id));
  const next = list.filter((a) => !archivedIds.has(a.id)).map((a) => live.find((i) => i.id === a.id) ?? a);
  return [...next, ...live.filter((i) => !known.has(i.id))];
}

/** What leaves the store with agents that go away (deleted, archived or undone): their home, their routines, their page. */
function dropAgents(s: AgentsState, ids: Set<string>): Pick<AgentsState, 'projects' | 'routines' | 'agentPages' | 'route'> {
  const homes = new Set(
    [...s.agents, ...s.archivedAgents]
      .filter((a) => ids.has(a.id))
      .map((a) => a.home_project_id)
      .filter((h): h is string => !!h),
  );
  const routines: Record<string, Routine> = {};
  for (const [id, r] of Object.entries(s.routines)) if (!ids.has(r.agent_id)) routines[id] = r;
  const agentPages: Record<string, AgentPage> = {};
  for (const [id, page] of Object.entries(s.agentPages)) if (!ids.has(id)) agentPages[id] = page;
  const onGoneHome = s.route.screen === 'project' && !!s.route.projectId && homes.has(s.route.projectId);
  return {
    projects: s.projects.filter((p) => !homes.has(p.id) && !(p.agent_id && ids.has(p.agent_id))),
    routines,
    agentPages,
    route: onGoneHome ? { screen: 'home' } : s.route,
  };
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** The backend returns at most this many events per call (`limit` default); a full page means there may be more. */
const EVENTS_PAGE = 500;
const MAX_EVENT_PAGES = 20;

/** Insert keeping `created_at` then `id` order; a known id is left alone. */
function insertMessage(list: Message[], m: Message): Message[] {
  if (list.some((x) => x.id === m.id)) return list;
  const next = [...list];
  let i = next.length;
  while (i > 0 && (next[i - 1].created_at > m.created_at || (next[i - 1].created_at === m.created_at && next[i - 1].id > m.id))) i -= 1;
  next.splice(i, 0, m);
  return next;
}

/** Swap the row with the same id in place (no reordering); a message not in the list yet is inserted in order. */
function replaceMessage(list: Message[], m: Message): Message[] {
  const at = list.findIndex((x) => x.id === m.id);
  if (at < 0) return insertMessage(list, m);
  const next = [...list];
  next[at] = m;
  return next;
}

export const useAgentsStore = create<AgentsStore>()((set, get) => {
  const guard = async <T extends ActionResult>(fn: () => Promise<T>): Promise<ActionResult> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HarnessDisabledError) {
        set({ harnessState: 'disabled' });
        return { ok: false, error: 'O harness de agentes está desligado.' };
      }
      return { ok: false, error: errorText(e) };
    }
  };

  /** Routine actions: a refusal becomes the pt-BR sentence of its code (`routine_limit`, `routine_running`, 422 detail). */
  const routineGuard = async <T extends ActionResult>(agentId: string | undefined, fn: () => Promise<T>): Promise<ActionResult> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HarnessDisabledError) {
        set({ harnessState: 'disabled' });
        return { ok: false, error: 'O harness de agentes está desligado.' };
      }
      if (e instanceof ApiError) {
        const name = get().agents.find((a) => a.id === agentId)?.name;
        return { ok: false, error: routineErrorMessage(e.status, e.code, e.detail, name), ...(e.code ? { code: e.code } : {}) };
      }
      return { ok: false, error: errorText(e) };
    }
  };

  /** Pause, archive, restore: a refusal becomes the pt-BR sentence of its code (`agent_busy`, `agent_archived`). */
  const agentGuard = async (agentId: string, fn: () => Promise<ActionResult>): Promise<ActionResult> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HarnessDisabledError) {
        set({ harnessState: 'disabled' });
        return { ok: false, error: 'O harness de agentes está desligado.' };
      }
      if (e instanceof ApiError) {
        const name = [...get().agents, ...get().archivedAgents].find((a) => a.id === agentId)?.name ?? 'O agente';
        return { ok: false, error: agentActionError(e.status, e.code, name, e.detail), ...(e.code ? { code: e.code } : {}) };
      }
      return { ok: false, error: errorText(e) };
    }
  };

  /** Read the live agents and the projects again (another screen changed them). */
  const refreshRoster = async (): Promise<void> => {
    const [agents, projects] = await Promise.all([api.listAgents().catch(() => null), api.listProjects().catch(() => null)]);
    set((s) => ({
      agents: agents ? agents.filter((a) => !a.archived) : s.agents,
      projects: projects ? projects.filter((p) => !p.archived) : s.projects,
      archivedState: 'idle' as const,
    }));
  };

  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refreshOverview();
    }, 300);
  };

  const scheduleMessages = (projectId: string): void => {
    if (messageTimers.has(projectId)) return;
    messageTimers.set(
      projectId,
      setTimeout(() => {
        messageTimers.delete(projectId);
        void get().refreshMessages(projectId);
      }, 300),
    );
  };

  const bindLifecycle = (): void => {
    if (lifecycleBound || typeof window === 'undefined') return;
    lifecycleBound = true;
    // A page that leaves (reload, navigation, back/forward cache) must not keep
    // its stream connection open: a handful of leftover streams exhausts the
    // browser's per-host connection limit and every later request queues forever.
    window.addEventListener('pagehide', () => {
      stopSocket?.();
      stopSocket = null;
    });
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted && get().harnessState === 'ready' && !stopSocket) {
        openSocket();
        void get().resync();
      }
    });
  };

  const openSocket = (): void => {
    bindLifecycle();
    stopSocket?.();
    let hadDrop = false;
    stopSocket = api.openGlobalSocket((ev) => get().handleEvent(ev), {
      onStatus: (connected) => {
        if (!connected) hadDrop = true;
        else if (hadDrop) {
          // Events may have been missed while offline. Started before `streamConnected` flips so the band never
          // sees "connected and not resyncing" in between.
          hadDrop = false;
          void get().resync();
        }
        set({ streamConnected: connected });
      },
      onGap: () => void get().resync(),
      onBootChange: () => void get().resync(),
      onDisabled: () => set({ harnessState: 'disabled', streamConnected: false }),
      onMessage: (m) => get().handleMessage(m),
      onMessageUpdate: (m) => get().handleMessageUpdate(m),
      onRunUpdate: (r) => get().handleRunUpdate(r),
      onActionUpdate: (a) => get().handleActionUpdate(a),
      onRoutineUpdate: (r) => get().handleRoutineUpdate(r),
      onRoutineDeleted: (id) => get().handleRoutineDeleted(id),
    });
  };

  const doInit = async (): Promise<void> => {
    if (get().harnessState !== 'ready') set({ harnessState: 'loading', error: null });
    try {
      await api.ensureToken();
      const [overview, projects, agents, engines, providers, tools] = await Promise.all([
        api.getOverview(),
        api.listProjects(),
        api.listAgents(),
        api.getEngines().catch(() => [] as EngineInfo[]),
        api.getProviders().catch(() => [] as ProviderInfo[]),
        // A backend without step 3b answers 404 here: the page simply has no tools section content.
        Promise.resolve()
          .then(() => api.getAgentTools())
          .then((groups) => (Array.isArray(groups) ? groups : null), () => null),
      ]);
      set((s) => ({
        harnessState: 'ready',
        error: null,
        projects: projects.filter((p) => !p.archived),
        agents: agents.filter((a) => !a.archived),
        engines,
        providers,
        tools: tools ?? s.tools,
        toolsState: tools ? 'ready' : 'error',
        approvals: { ...byId(overview.pending_approvals) },
        runs: { ...s.runs, ...byId(overview.active_runs) },
        spendToday: overview.spend_today,
      }));
      openSocket();
      void get().loadSetup();
      void get().loadRoutines();
      void get().loadGuide();
    } catch (e) {
      if (e instanceof HarnessDisabledError) set({ harnessState: 'disabled', error: null });
      else set({ harnessState: 'error', error: errorText(e) });
    }
  };

  const followUp = (run: Run, ev: HarnessEvent): void => {
    const finished = ev.kind === 'status' && !ACTIVE_RUN_STATUSES.includes(run.status);
    if (finished) {
      void api
        .getRun(run.id)
        .then((fresh) => set((st) => ({ runs: { ...st.runs, [fresh.id]: mergeRun(st.runs[fresh.id], fresh) } })))
        .catch(() => undefined);
    }
    if (ev.kind === 'message' || finished) scheduleMessages(run.project_id);
    if (run.task_id && (ev.kind === 'message' || finished) && get().messagesByTask[run.task_id]) {
      void api
        .listTaskMessages(run.task_id)
        .then((list) => set((st) => ({ messagesByTask: { ...st.messagesByTask, [run.task_id as string]: list } })))
        .catch(() => undefined);
    }
  };

  /** Events after `after`, page by page; null when the call failed (the run keeps what it has). */
  const fetchEventsAfter = async (runId: string, after: number | undefined): Promise<HarnessEvent[] | null> => {
    const all: HarnessEvent[] = [];
    let cursor = after;
    try {
      for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
        const events = await api.listRunEvents(runId, cursor);
        all.push(...events);
        if (events.length < EVENTS_PAGE) break;
        cursor = events[events.length - 1].id;
      }
      return all;
    } catch {
      return all.length ? all : null;
    }
  };

  const runResync = async (): Promise<void> => {
    const start = get();
    const quiet = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

    const projectIds = new Set([...Object.keys(start.messagesByProject), ...(start.route.projectId ? [start.route.projectId] : [])]);
    for (const taskId of Object.keys(start.messagesByTask)) {
      const t = start.tasksById[taskId];
      if (t) projectIds.add(t.project_id);
    }
    const overview = get().refreshOverview();
    const toolsReload = get().loadTools();
    // A `routine_update` or `routine_deleted` may have been lost with the frames.
    const routinesReload = start.routinesState === 'ready' ? get().loadRoutines() : Promise.resolve();
    const runLists = [...projectIds].map((pid) => quiet(api.listRuns({ project_id: pid, limit: 50 })));
    const eventJobs = Object.entries(start.eventsByRun).map(async ([runId, list]) => ({
      runId,
      events: await fetchEventsAfter(runId, list.length ? list[list.length - 1].id : undefined),
    }));
    const projectMsgs = Object.keys(start.messagesByProject).map(async (pid) => ({ pid, list: await quiet(api.listMessages(pid, { limit: 200 })) }));
    const taskMsgs = Object.keys(start.messagesByTask).map(async (tid) => ({ tid, list: await quiet(api.listTaskMessages(tid)) }));

    const [, , , lists, events, pMsgs, tMsgs] = await Promise.all([
      overview,
      toolsReload,
      routinesReload,
      Promise.all(runLists),
      Promise.all(eventJobs),
      Promise.all(projectMsgs),
      Promise.all(taskMsgs),
    ]);

    // Runs whose events are open but that no project list covered (older than the page, another screen): read them one by one.
    const fresh = new Map<string, Run>();
    for (const list of lists) for (const r of list ?? []) fresh.set(r.id, r);
    const stray = Object.keys(start.eventsByRun).filter((id) => get().runs[id] && !fresh.has(id));
    const strays = await Promise.all(stray.map((id) => quiet(api.getRun(id))));
    for (const r of strays) if (r) fresh.set(r.id, r);

    // Everything below is one synchronous merge into what is on screen now: no await, so nothing live can slip in between.
    const now = get();
    let slice = { runs: now.runs, approvals: now.approvals, eventsByRun: now.eventsByRun };
    let refresh = false;
    for (const job of events) {
      for (const ev of job.events ?? []) {
        const res = reduceEvent(slice, ev);
        slice = { ...slice, ...res.patch };
        refresh = refresh || res.refresh;
      }
    }
    const runs = { ...slice.runs };
    for (const r of fresh.values()) runs[r.id] = mergeRun(runs[r.id], r);

    const messagesByProject = { ...now.messagesByProject };
    for (const { pid, list } of pMsgs) {
      if (list && messagesByProject[pid]) messagesByProject[pid] = list.reduce(replaceMessage, messagesByProject[pid]);
    }
    const messagesByTask = { ...now.messagesByTask };
    for (const { tid, list } of tMsgs) {
      if (list && messagesByTask[tid]) messagesByTask[tid] = list.reduce(replaceMessage, messagesByTask[tid]);
    }
    set({ runs, approvals: slice.approvals, eventsByRun: slice.eventsByRun, messagesByProject, messagesByTask });
    if (refresh) scheduleRefresh();
    // An `action_update` may have been lost with the frames: the receipts of the runs on screen are read again.
    for (const [runId, list] of Object.entries(get().eventsByRun)) {
      if (list.some((e) => e.kind === 'step' && typeof e.payload?.action_id === 'string')) void get().loadRunActions(runId, true);
    }
  };

  /** The run an action came from: the action itself knows, else the events that mention it. */
  const runOfAction = (id: string): string | null => {
    const known = get().actionsById[id]?.run_id;
    if (known) return known;
    for (const [runId, list] of Object.entries(get().eventsByRun)) {
      if (list.some((e) => e.payload?.action_id === id)) return runId;
    }
    return null;
  };

  /** One exchange with the Seraphine: the owner's text shows in the conversation (`guideOutbox`) until the stored pair arrives. */
  const deliverGuide = async (body: string, about: GuideAbout | undefined): Promise<ActionResult> => {
    guideSendFlight = true;
    set({ guideOutbox: { text: body, ...(about ? { about } : {}), phase: 'sending' } });
    try {
      const res = await api.sendGuideMessage({ body, ...(about ? { about } : {}) });
      set((s) => ({
        guideOutbox: null,
        guideState: s.guideState === 'unavailable' ? 'ready' : s.guideState,
        guideMessages: appendGuideMessages(s.guideMessages, [res.message, res.reply]),
        guideProposals: { ...s.guideProposals, ...byId(res.proposals) },
      }));
      return { ok: true };
    } catch (e) {
      if (e instanceof HarnessDisabledError) {
        set({ harnessState: 'disabled', guideOutbox: null });
        return { ok: false, error: 'O harness de agentes está desligado.' };
      }
      if (e instanceof ApiError && e.status === 503) {
        // The Seraphine could not answer: the owner's message was stored, so it stays in the conversation with "Tentar de novo".
        const error = e.detail || GUIDE_UNAVAILABLE_MESSAGE;
        set((s) => ({ guideOutbox: { ...(s.guideOutbox ?? { text: body }), text: body, phase: 'failed', error } }));
        return { ok: false, error, code: e.code || 'guide_unavailable' };
      }
      // Anything else: the message was not stored, so the text goes back to the owner.
      set({ guideOutbox: null });
      if (e instanceof ApiError && e.status === 404) {
        set({ guideState: 'unavailable' });
        return { ok: false, error: 'A conversa com a Seraphine não está disponível nesta versão.', code: 'not_found' };
      }
      if (e instanceof ApiError && e.status === 409) return { ok: false, error: GUIDE_BUSY_MESSAGE, code: e.code || 'guide_busy' };
      return { ok: false, error: errorText(e), ...(e instanceof ApiError && e.code ? { code: e.code } : {}) };
    } finally {
      guideSendFlight = false;
    }
  };

  /** Apply or dismiss a proposal. A refusal re-reads the conversation so the card shows the state the server reports. */
  const decideProposal = async (id: string, action: 'apply' | 'dismiss'): Promise<ActionResult> => {
    if (proposalsInFlight.has(id)) return { ok: false };
    proposalsInFlight.add(id);
    try {
      if (action === 'apply') {
        const res = await api.applyProposal(id);
        set((s) => ({
          guideProposals: { ...s.guideProposals, [res.proposal.id]: res.proposal },
          agents: mergeAgents(s.agents, res.agents),
          routines: { ...s.routines, ...byId(res.routines) },
        }));
        // The first steps count agents: read them again when the proposal created some.
        if (res.agents.length > 0) void get().loadSetup();
      } else {
        const proposal = await api.dismissProposal(id);
        set((s) => ({ guideProposals: { ...s.guideProposals, [proposal.id]: proposal } }));
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof HarnessDisabledError) {
        set({ harnessState: 'disabled' });
        return { ok: false, error: 'O harness de agentes está desligado.' };
      }
      if (!(e instanceof ApiError)) return { ok: false, error: errorText(e) };
      const text = proposalErrorMessage(e.status, e.code, e.detail);
      // The answer does not carry the proposal: what the server says now comes from the conversation.
      if (e.status === 409 && e.code === 'proposal_stale') {
        set((s) => (s.guideProposals[id] ? { guideProposals: { ...s.guideProposals, [id]: { ...s.guideProposals[id], status: 'stale', detail: text } } } : {}));
      }
      if (e.status === 404 || e.status === 409 || e.status === 422) await get().loadGuide();
      return { ok: false, error: text, ...(e.code ? { code: e.code } : {}) };
    } finally {
      proposalsInFlight.delete(id);
    }
  };

  return {
    ...initialState(),

    init: () => {
      if (initFlight) return initFlight;
      // Ready, disabled or failed: stay put until the owner presses "Tentar de novo".
      if (didInit) return Promise.resolve();
      didInit = true;
      initFlight = doInit().finally(() => {
        initFlight = null;
      });
      return initFlight;
    },

    retry: () => {
      stopSocket?.();
      stopSocket = null;
      api.resetToken();
      didInit = false;
      set({ harnessState: 'loading', error: null });
      return get().init();
    },

    dispose: () => {
      stopSocket?.();
      stopSocket = null;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      for (const t of messageTimers.values()) clearTimeout(t);
      messageTimers.clear();
      didInit = false;
      set({ streamConnected: false });
    },

    navigate: (route) => set({ route }),

    refreshProviders: async () => {
      try {
        set({ providers: await api.getProviders() });
      } catch {
        /* keep the last known list */
      }
    },

    loadTools: async () => {
      try {
        const tools = await api.getAgentTools();
        if (!Array.isArray(tools)) throw new Error('no catalogue');
        set({ tools, toolsState: 'ready' });
      } catch {
        set({ toolsState: 'error' });
      }
    },

    refreshOverview: async () => {
      try {
        const overview = await api.getOverview();
        set((s) => {
          const decided: Record<string, Approval> = {};
          for (const a of Object.values(s.approvals)) if (a.status !== 'pending') decided[a.id] = a;
          // A run that left the active list has finished: its terminal state
          // arrives via events or getRun; keep what we know until then.
          return {
            approvals: { ...decided, ...byId(overview.pending_approvals) },
            runs: { ...s.runs, ...byId(overview.active_runs) },
            spendToday: overview.spend_today,
          };
        });
        const activeIds = new Set(overview.active_runs.map((r) => r.id));
        for (const r of Object.values(get().runs)) {
          if (ACTIVE_RUN_STATUSES.includes(r.status) && !activeIds.has(r.id)) {
            void api
              .getRun(r.id)
              .then((fresh) => set((s) => ({ runs: { ...s.runs, [fresh.id]: fresh } })))
              .catch(() => undefined);
          }
        }
      } catch (e) {
        if (e instanceof HarnessDisabledError) set({ harnessState: 'disabled' });
      }
    },

    resync: () => {
      if (resyncFlight) return resyncFlight;
      set({ resyncing: true });
      resyncFlight = runResync()
        .catch(() => undefined)
        .finally(() => {
          resyncFlight = null;
          set({ resyncing: false });
        });
      return resyncFlight;
    },

    handleEvent: (ev) => {
      const s = get();
      const { patch, refresh } = reduceEvent(
        { runs: s.runs, approvals: s.approvals, eventsByRun: s.eventsByRun },
        ev,
      );
      if (Object.keys(patch).length) set(patch);
      if (refresh) scheduleRefresh();
      const known = get().runs[ev.run_id];
      if (known) {
        followUp(known, ev);
        return;
      }
      // A run this page did not start (assistant, another device): fetch it once.
      if (runsInFlight.has(ev.run_id)) return;
      runsInFlight.add(ev.run_id);
      void api
        .getRun(ev.run_id)
        .then((fresh) => {
          set((st) => ({ runs: { ...st.runs, [fresh.id]: mergeRun(st.runs[fresh.id], fresh) } }));
          followUp(get().runs[fresh.id] ?? fresh, ev);
        })
        .catch(() => undefined)
        .finally(() => runsInFlight.delete(ev.run_id));
    },

    handleRunUpdate: (incoming) => {
      const prev = get().runs[incoming.id];
      const next = mergeRun(prev, incoming);
      set((st) => ({ runs: { ...st.runs, [incoming.id]: next } }));
      const wasActive = !!prev && ACTIVE_RUN_STATUSES.includes(prev.status);
      const isActive = ACTIVE_RUN_STATUSES.includes(next.status);
      const approvalsChanged = (prev?.status === 'waiting_approval') !== (next.status === 'waiting_approval');
      if (!prev || (wasActive && !isActive) || approvalsChanged) scheduleRefresh();
      if (!isActive && next !== prev && (!prev || wasActive)) scheduleMessages(next.project_id);
    },

    handleMessage: (m) => {
      set((st) => {
        const patch: Partial<AgentsState> = {};
        const proj = st.messagesByProject[m.project_id];
        if (proj) {
          const merged = insertMessage(proj, m);
          if (merged !== proj) patch.messagesByProject = { ...st.messagesByProject, [m.project_id]: merged };
        }
        const task = m.task_id ? st.messagesByTask[m.task_id] : undefined;
        if (m.task_id && task) {
          const merged = insertMessage(task, m);
          if (merged !== task) patch.messagesByTask = { ...st.messagesByTask, [m.task_id]: merged };
        }
        return patch;
      });
    },

    handleMessageUpdate: (m) => {
      set((st) => {
        const patch: Partial<AgentsState> = {};
        const proj = st.messagesByProject[m.project_id];
        if (proj) patch.messagesByProject = { ...st.messagesByProject, [m.project_id]: replaceMessage(proj, m) };
        const task = m.task_id ? st.messagesByTask[m.task_id] : undefined;
        if (m.task_id && task) patch.messagesByTask = { ...st.messagesByTask, [m.task_id]: replaceMessage(task, m) };
        return patch;
      });
    },

    loadProject: async (projectId) => {
      try {
        const [messages, runs, tasks] = await Promise.all([
          api.listMessages(projectId, { limit: 200 }),
          api.listRuns({ project_id: projectId, limit: 50 }),
          api.listTasks({ project_id: projectId }),
        ]);
        set((s) => ({
          // Keep anything sent while this load was in flight.
          messagesByProject: {
            ...s.messagesByProject,
            [projectId]: appendUnique(messages, s.messagesByProject[projectId] ?? []),
          },
          runs: { ...s.runs, ...byId(runs) },
          tasksByProject: { ...s.tasksByProject, [projectId]: tasks },
          tasksById: { ...s.tasksById, ...byId(tasks) },
        }));
      } catch (e) {
        if (e instanceof HarnessDisabledError) set({ harnessState: 'disabled' });
      }
    },

    refreshMessages: async (projectId) => {
      try {
        const known = get().messagesByProject[projectId];
        if (!known) return;
        const last = known.length ? known[known.length - 1].id : undefined;
        const fresh = await api.listMessages(projectId, { after: last, limit: 200 });
        if (fresh.length) {
          set((s) => ({
            messagesByProject: {
              ...s.messagesByProject,
              [projectId]: appendUnique(s.messagesByProject[projectId] ?? [], fresh),
            },
          }));
        }
      } catch {
        /* the next event or visit retries */
      }
    },

    loadRunEvents: async (runId) => {
      if (eventsInFlight.has(runId)) return;
      eventsInFlight.add(runId);
      try {
        const events = await api.listRunEvents(runId);
        set((s) => {
          const prior = s.eventsByRun[runId] ?? [];
          return { eventsByRun: { ...s.eventsByRun, [runId]: mergeEvents(prior, events) } };
        });
      } catch {
        /* steps simply stay empty */
      } finally {
        eventsInFlight.delete(runId);
      }
    },

    sendMessage: (projectId, body, agentId, taskId, mode = 'join', fresh = false) =>
      guard(async () => {
        let res;
        try {
          res = await api.sendMessage(projectId, {
            body,
            agent_id: agentId,
            ...(taskId ? { task_id: taskId } : {}),
            ...(mode !== 'join' ? { mode } : {}),
            ...(fresh ? { fresh: true } : {}),
          });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'inbox_full') throw e;
          const name = get().agents.find((a) => a.id === agentId)?.name;
          return { ok: false, error: inboxFullMessage(name), code: e.code };
        }
        // An archived agent refuses in-band and the backend does not store the message: nothing is added, the text stays with the owner.
        if (res.error === 'agent_archived') {
          const name = get().archivedAgents.find((a) => a.id === agentId)?.name ?? get().agents.find((a) => a.id === agentId)?.name ?? 'O agente';
          return { ok: false, error: res.detail || archivedSendSentence(name), code: 'agent_archived' };
        }
        set((s) => {
          const next: Partial<AgentsState> = {};
          if (res.message) {
            if (taskId) {
              next.messagesByTask = {
                ...s.messagesByTask,
                [taskId]: appendUnique(s.messagesByTask[taskId] ?? [], [res.message]),
              };
            } else {
              next.messagesByProject = {
                ...s.messagesByProject,
                [projectId]: appendUnique(s.messagesByProject[projectId] ?? [], [res.message]),
              };
            }
          }
          // A joined message belongs to a run that already existed (and may be ahead of this answer): merge, do not overwrite.
          if (res.run) next.runs = { ...s.runs, [res.run.id]: res.joined ? mergeRun(s.runs[res.run.id], res.run) : res.run };
          return next;
        });
        // A run created already parked (missing login or key) is not a failure: its card explains it.
        if (res.run?.status === 'parked') return { ok: true };
        // `error` is a code slug; `detail` is the sentence for the owner.
        if (res.error) return { ok: false, error: res.detail || res.error };
        return { ok: true };
      }),

    decideApproval: (id, decision, extras = {}) =>
      guard(async () => {
        let before = get().approvals[id];
        if (!before) return { ok: false, error: 'Esse pedido não existe mais.' };
        // A request rebuilt from an old event has no digest: load the real row first.
        if (!before.command_digest) {
          await get().refreshOverview();
          before = get().approvals[id];
          if (!before?.command_digest) {
            return { ok: false, error: 'Não consegui confirmar este pedido. Recarregue a página e tente de novo.' };
          }
        }
        // No optimistic update: the card shows progress until the backend has answered.
        try {
          const fresh = await api.decideApproval(id, decision, {
            digest: before.command_digest,
            confirmHighRisk: extras.confirmHighRisk,
            note: extras.note?.trim() || undefined,
          });
          set((s) => ({ approvals: { ...s.approvals, [id]: fresh } }));
          return { ok: true };
        } catch (e) {
          const text = e instanceof ApiError && e.status === 409 ? approvalErrorMessage(e.code) : null;
          if (!text || !(e instanceof ApiError)) throw e;
          // The command changed under the owner's eyes: show the current one.
          if (e.code === 'digest_mismatch') await get().refreshOverview();
          return { ok: false, error: text, code: e.code };
        }
      }),

    cancelRun: (id) =>
      guard(async () => {
        const run = await api.cancelRun(id);
        set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
        return { ok: true };
      }),

    continueRun: (id) =>
      guard(async () => {
        try {
          const next = await api.continueRun(id);
          set((s) => {
            const old = s.runs[id];
            return {
              runs: {
                ...s.runs,
                [next.id]: next,
                ...(old ? { [id]: { ...old, continued_by: next.id, can_continue: false } } : {}),
              },
            };
          });
          return { ok: true };
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409) throw e;
          // The run changed under the owner (continued from another screen, state moved on): reload it.
          if (e.code === 'already_continued' || e.code === 'continue_not_allowed') {
            void api
              .getRun(id)
              .then((fresh) => set((s) => ({ runs: { ...s.runs, [id]: fresh } })))
              .catch(() => undefined);
          }
          const agentId = get().runs[id]?.agent_id;
          const agentName = get().agents.find((a) => a.id === agentId)?.name;
          return { ok: false, error: continueErrorMessage(e.code, agentName), code: e.code };
        }
      }),

    wakeRun: (id) =>
      guard(async () => {
        try {
          await api.wakeRun(id);
          // The answer describes the run at the instant it was woken. A run that parks again within
          // milliseconds (the cause is still there) has already told us so over the live channel, and
          // applying the older answer on top left the screen saying "trabalhando". Read the current row.
          const fresh = await api.getRun(id);
          set((s) => ({ runs: { ...s.runs, [fresh.id]: mergeRun(s.runs[fresh.id], fresh) } }));
          return { ok: true };
        } catch (e) {
          if (e instanceof HarnessDisabledError) throw e;
          const status = e instanceof ApiError ? e.status : null;
          const code = e instanceof ApiError ? e.code : '';
          // It already left parking (timer, another screen): reload it so the card goes away.
          if (status === 409 && code === 'not_parked') {
            void api
              .getRun(id)
              .then((fresh) => set((s) => ({ runs: { ...s.runs, [id]: mergeRun(s.runs[id], fresh) } })))
              .catch(() => undefined);
          }
          return { ok: false, error: wakeErrorMessage(status, code), ...(code ? { code } : {}) };
        }
      }),

    loadRunActions: async (runId, force = false) => {
      if (actionsInFlight.has(runId) || (!force && get().actionsLoadedRuns[runId])) return;
      actionsInFlight.add(runId);
      try {
        const list = await api.listRunActions(runId);
        set((s) => ({ actionsById: { ...s.actionsById, ...byId(list) }, actionsLoadedRuns: { ...s.actionsLoadedRuns, [runId]: true } }));
      } catch {
        /* the receipts keep what the events told: the next resync tries again */
      } finally {
        actionsInFlight.delete(runId);
      }
    },

    handleActionUpdate: (action) => {
      set((s) => ({ actionsById: { ...s.actionsById, [action.id]: action }, undoErrors: without(s.undoErrors, action.id) }));
    },

    undoAction: async (id) => {
      // Synchronous guard: a double click (or the same action's second button) never sends a second request.
      if (undoFlight.has(id)) return { ok: false };
      undoFlight.add(id);
      set((s) => ({ undoingIds: { ...s.undoingIds, [id]: true }, undoErrors: without(s.undoErrors, id) }));
      try {
        const action = await api.undoAction(id);
        set((s) => ({ actionsById: { ...s.actionsById, [id]: action }, undoErrors: without(s.undoErrors, id) }));
        return { ok: true };
      } catch (e) {
        if (e instanceof HarnessDisabledError) {
          set({ harnessState: 'disabled' });
          return { ok: false, error: 'O harness de agentes está desligado.' };
        }
        const status = e instanceof ApiError ? e.status : null;
        const code = e instanceof ApiError ? e.code : '';
        const text = undoErrorMessage(status, code);
        set((s) => ({ undoErrors: { ...s.undoErrors, [id]: { text, code } } }));
        // It changed under the owner (undone elsewhere, window over): read the real state so the line follows.
        if (status === 409 && UNDO_FINAL_CODES.includes(code)) {
          const runId = runOfAction(id);
          if (runId) void get().loadRunActions(runId, true);
        }
        return { ok: false, error: text, ...(code ? { code } : {}) };
      } finally {
        undoFlight.delete(id);
        set((s) => ({ undoingIds: without(s.undoingIds, id) }));
      }
    },

    loadBridge: async () => {
      if (get().bridge.state === 'idle') set((s) => ({ bridge: { ...s.bridge, state: 'loading' } }));
      try {
        const engines = await api.getBridgeStatus();
        set({ bridge: { state: 'ready', engines } });
      } catch (e) {
        // A backend from before step 3c has no such route: the panel simply is not there.
        set((s) => ({ bridge: { engines: s.bridge.engines, state: e instanceof ApiError && e.status === 404 ? 'unavailable' : 'error' } }));
      }
    },

    testBridge: async (engine) => {
      if (get().bridgeRunning) return { ok: false };
      set((s) => ({ bridgeRunning: engine, bridgeResults: without(s.bridgeResults, engine) }));
      try {
        const result = await api.testBridge(engine);
        set((s) => ({ bridgeResults: { ...s.bridgeResults, [engine]: { ok: result.ok, text: bridgeTestLine(result) } } }));
        return { ok: result.ok };
      } catch (e) {
        const text =
          e instanceof ApiError && e.status === 409 && e.code === 'test_running'
            ? BRIDGE_TEST_RUNNING_MESSAGE
            : BRIDGE_TEST_FAILED_MESSAGE;
        set((s) => ({ bridgeResults: { ...s.bridgeResults, [engine]: { ok: false, text } } }));
        return { ok: false, error: text };
      } finally {
        set({ bridgeRunning: null });
        void get().loadBridge();
      }
    },

    createProject: (input) =>
      guard(async () => {
        const project = await api.createProject(input);
        set((s) => ({ projects: [...s.projects, project] }));
        return { ok: true };
      }),

    archiveProject: (id) =>
      guard(async () => {
        await api.archiveProject(id);
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          route: s.route.projectId === id ? { screen: 'home' } : s.route,
        }));
        return { ok: true };
      }),

    saveAgent: async (id, input) => {
      let saved: Agent | undefined;
      const res = await guard(async () => {
        saved = id ? await api.updateAgent(id, input) : await api.createAgent(input);
        const agent = saved;
        set((s) => ({
          agents: id ? s.agents.map((a) => (a.id === id ? agent : a)) : [...s.agents, agent],
        }));
        return { ok: true };
      });
      return { ...res, agent: saved };
    },

    saveGrants: (agentId, grants) =>
      guard(async () => {
        try {
          const saved = await api.setAgentGrants(agentId, grants);
          set((s) => ({ agents: s.agents.map((a) => (a.id === agentId ? { ...a, grants: saved } : a)) }));
          return { ok: true };
        } catch (e) {
          const text = e instanceof ApiError ? grantsErrorMessage(e.status) : null;
          if (!text) throw e;
          return { ok: false, error: text };
        }
      }),

    deleteAgent: (id) =>
      guard(async () => {
        await api.deleteAgent(id);
        set((s) => ({
          ...dropAgents(s, new Set([id])),
          agents: s.agents.filter((a) => a.id !== id),
          archivedAgents: s.archivedAgents.filter((a) => a.id !== id),
        }));
        void get().loadSetup();
        return { ok: true };
      }),

    loadTask: async (taskId) => {
      try {
        const [task, messages] = await Promise.all([api.getTask(taskId), api.listTaskMessages(taskId)]);
        set((s) => ({
          tasksById: { ...s.tasksById, [taskId]: task },
          messagesByTask: { ...s.messagesByTask, [taskId]: messages },
        }));
        const runIds = new Set(messages.map((m) => m.run_id).filter((r): r is string => !!r));
        for (const rid of runIds) {
          if (!get().runs[rid]) void api.getRun(rid).then((r) => set((s) => ({ runs: { ...s.runs, [r.id]: r } }))).catch(() => undefined);
        }
      } catch (e) {
        if (e instanceof HarnessDisabledError) set({ harnessState: 'disabled' });
      }
    },

    createTask: async (projectId, title, description) => {
      let created: Task | undefined;
      const res = await guard(async () => {
        const task = await api.createTask({
          project_id: projectId,
          title,
          ...(description ? { description } : {}),
        });
        created = task;
        set((s) => ({
          tasksByProject: { ...s.tasksByProject, [projectId]: [...(s.tasksByProject[projectId] ?? []), task] },
          tasksById: { ...s.tasksById, [task.id]: task },
        }));
        return { ok: true };
      });
      return { ...res, task: created };
    },

    patchTask: (taskId, patch) =>
      guard(async () => {
        const task = await api.updateTask(taskId, patch);
        set((s) => ({
          tasksById: { ...s.tasksById, [taskId]: task },
          tasksByProject: {
            ...s.tasksByProject,
            [task.project_id]: (s.tasksByProject[task.project_id] ?? []).map((t) => (t.id === taskId ? task : t)),
          },
        }));
        return { ok: true };
      }),

    runTask: (taskId, agentId) =>
      guard(async () => {
        const run = await api.runTask(taskId, agentId);
        set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
        void get().loadTask(taskId);
        return { ok: true };
      }),

    loadSetup: async () => {
      if (get().setupState === 'idle') set({ setupState: 'loading' });
      try {
        const setup = await api.getSetup();
        set({ setup, setupState: 'ready' });
      } catch (e) {
        // A backend from before phase 6a has no such route: the first steps simply are not there.
        set((s) => ({ setupState: e instanceof ApiError && e.status === 404 ? 'unavailable' : s.setup ? 'ready' : 'error' }));
      }
    },

    saveSetup: (patch) =>
      guard(async () => {
        const setup = await api.putSetup(patch);
        set({ setup, setupState: 'ready' });
        return { ok: true };
      }),

    markSetupAutoOpened: () => set({ setupAutoOpened: true }),

    recheckEngines: async () => {
      const [engines, providers] = await Promise.all([api.getEngines().catch(() => null), api.getProviders().catch(() => null)]);
      set((s) => ({ engines: engines ?? s.engines, providers: providers ?? s.providers }));
      await get().loadSetup();
    },

    openBuilder: () => {
      if (get().setupState === 'unavailable') {
        set({ route: { screen: 'roster', newAgent: true } });
        return;
      }
      set({ builderOpen: true });
    },

    closeBuilder: () => set({ builderOpen: false }),

    openAgentConversation: (agentId, tab) =>
      guard(async () => {
        set({ homeError: null });
        try {
          const home = await api.ensureAgentHome(agentId);
          set((s) => ({
            projects: s.projects.some((p) => p.id === home.id) ? s.projects.map((p) => (p.id === home.id ? home : p)) : [...s.projects, home],
            agents: s.agents.map((a) => (a.id === agentId && a.home_project_id !== home.id ? { ...a, home_project_id: home.id } : a)),
            route: { screen: 'project', projectId: home.id, ...(tab ? { tab } : {}) },
          }));
          return { ok: true };
        } catch (e) {
          if (e instanceof HarnessDisabledError) throw e;
          const text =
            e instanceof ApiError && e.status === 404
              ? 'Esse agente não existe mais.'
              : e instanceof ApiError && e.detail
                ? e.detail
                : 'Não consegui abrir a conversa agora. Tente de novo.';
          set({ homeError: text });
          return { ok: false, error: text };
        }
      }),

    createTeam: async (origin, agents) => {
      let result: TeamResult | undefined;
      const res = await guard(async () => {
        const team = await api.createTeam({ origin, agents });
        result = team;
        set((s) => {
          const newAgents = team.created.map((c) => c.def).filter((d) => !s.agents.some((a) => a.id === d.id));
          const newHomes = team.created.map((c) => c.home).filter((h) => !s.projects.some((p) => p.id === h.id));
          return { agents: [...s.agents, ...newAgents], projects: [...s.projects, ...newHomes] };
        });
        void get().loadSetup();
        if (team.routines.length > 0) set((s) => ({ routines: { ...s.routines, ...byId(team.routines) } }));
        return { ok: true };
      });
      return { ...res, result };
    },

    loadRoutines: async () => {
      if (get().routinesState === 'idle') set({ routinesState: 'loading' });
      try {
        const list = await api.listRoutines();
        // The backend still lists the routines of archived agents (and does not count them as active): they stay out of every screen.
        const live = new Set(get().agents.map((a) => a.id));
        set({ routines: byId(list.filter((r) => live.size === 0 || live.has(r.agent_id))), routinesState: 'ready' });
      } catch (e) {
        // A backend from before phase 6b has no such route: the routines simply are not there.
        set((s) => ({ routinesState: e instanceof ApiError && e.status === 404 ? 'unavailable' : s.routinesState === 'ready' ? 'ready' : 'error' }));
      }
    },

    createRoutine: async (input) => {
      let routine: Routine | undefined;
      const res = await routineGuard(input.agent_id, async () => {
        routine = await api.createRoutine(input);
        const created = routine;
        set((s) => ({ routines: { ...s.routines, [created.id]: created }, routinesState: s.routinesState === 'unavailable' ? s.routinesState : 'ready' }));
        return { ok: true };
      });
      return { ...res, routine };
    },

    updateRoutine: async (id, patch) => {
      let routine: Routine | undefined;
      const res = await routineGuard(get().routines[id]?.agent_id, async () => {
        routine = await api.updateRoutine(id, patch);
        const saved = routine;
        set((s) => ({ routines: { ...s.routines, [saved.id]: saved } }));
        return { ok: true };
      });
      return { ...res, routine };
    },

    removeRoutine: (id) =>
      routineGuard(get().routines[id]?.agent_id, async () => {
        await api.deleteRoutine(id);
        get().handleRoutineDeleted(id);
        return { ok: true };
      }),

    runRoutine: (id) =>
      routineGuard(get().routines[id]?.agent_id, async () => {
        try {
          const { routine, run } = await api.runRoutineNow(id);
          set((s) => ({ routines: { ...s.routines, [routine.id]: routine }, runs: { ...s.runs, [run.id]: mergeRun(s.runs[run.id], run) } }));
          if (get().routineRuns[id]) void get().loadRoutineRuns(id);
          return { ok: true };
        } catch (e) {
          // It was already running (another screen, the clock): read the real state so the row follows.
          if (e instanceof ApiError && e.status === 409 && e.code === 'routine_running') void get().loadRoutines();
          throw e;
        }
      }),

    copyRoutine: async (id) => {
      let routine: Routine | undefined;
      const res = await routineGuard(get().routines[id]?.agent_id, async () => {
        routine = await api.copyRoutine(id);
        const copy = routine;
        set((s) => ({ routines: { ...s.routines, [copy.id]: copy } }));
        return { ok: true };
      });
      return { ...res, routine };
    },

    loadRoutineRuns: async (id) => {
      // One request per routine at a time (the live frames and the opening of the list can both ask).
      if (routineRunsInFlight.has(id)) return { ok: true };
      routineRunsInFlight.add(id);
      try {
        const list = await api.listRoutineRuns(id, 20);
        set((s) => ({ routineRuns: { ...s.routineRuns, [id]: list } }));
        return { ok: true };
      } catch (e) {
        if (e instanceof HarnessDisabledError) {
          set({ harnessState: 'disabled' });
          return { ok: false, error: 'O harness de agentes está desligado.' };
        }
        return { ok: false, error: e instanceof ApiError ? routineErrorMessage(e.status, e.code, e.detail) : errorText(e) };
      } finally {
        routineRunsInFlight.delete(id);
      }
    },

    handleRoutineUpdate: (routine) => {
      const prev = get().routines[routine.id];
      set((s) => ({
        routines: { ...s.routines, [routine.id]: routine },
        routinesState: s.routinesState === 'idle' || s.routinesState === 'loading' || s.routinesState === 'error' ? 'ready' : s.routinesState,
      }));
      // A ledger that is on screen follows the routine: a time ran, ended or was skipped.
      if (prev && get().routineRuns[routine.id] && (prev.last_run_at !== routine.last_run_at || prev.running !== routine.running || prev.last_status !== routine.last_status)) {
        void get().loadRoutineRuns(routine.id);
      }
    },

    handleRoutineDeleted: (id) => {
      set((s) => ({ routines: without(s.routines, id), routineRuns: without(s.routineRuns, id) }));
    },

    loadGuide: async () => {
      if (get().guideState === 'idle') set({ guideState: 'loading' });
      try {
        const { messages, proposals } = await api.listGuideMessages(200);
        set({ guideMessages: messages, guideProposals: byId(proposals), guideState: 'ready' });
      } catch (e) {
        // A backend from before phase 6c has no such route: the conversation simply is not there.
        set((s) => ({ guideState: e instanceof ApiError && e.status === 404 ? 'unavailable' : s.guideState === 'ready' ? 'ready' : 'error' }));
      }
    },

    sendGuide: (text, about) => {
      const body = text.trim();
      if (!body || guideSendFlight) return Promise.resolve({ ok: false });
      return deliverGuide(body, about);
    },

    retryGuide: () => {
      const outbox = get().guideOutbox;
      if (!outbox || outbox.phase !== 'failed' || guideSendFlight) return Promise.resolve({ ok: false });
      return deliverGuide(outbox.text, outbox.about);
    },

    clearGuide: () =>
      guard(async () => {
        await api.clearGuideConversation();
        // What was not applied goes away with the conversation; what was applied lives on in the agents' history.
        set({ guideMessages: [], guideProposals: {}, guideOutbox: null });
        return { ok: true };
      }),

    applyProposal: (id) => decideProposal(id, 'apply'),
    dismissProposal: (id) => decideProposal(id, 'dismiss'),

    loadAgentVersions: async (agentId) => {
      try {
        const versions = await api.listAgentVersions(agentId);
        return { ok: true, versions };
      } catch (e) {
        if (e instanceof HarnessDisabledError) {
          set({ harnessState: 'disabled' });
          return { ok: false, error: 'O harness de agentes está desligado.' };
        }
        // A backend from before phase 6c has no such route: the history simply is not there.
        if (e instanceof ApiError && e.status === 404) {
          set({ versionsUnavailable: true });
          return { ok: false, code: 'not_found' };
        }
        return { ok: false, error: 'Não consegui carregar o histórico agora.' };
      }
    },

    loadAgentPage: async (agentId) => {
      try {
        const page = await api.getAgentPage(agentId);
        set((s) => ({
          agentPages: { ...s.agentPages, [agentId]: page },
          agents: s.agents.some((a) => a.id === agentId) ? mergeAgents(s.agents, [page.def]) : s.agents,
        }));
        return { ok: true };
      } catch (e) {
        if (e instanceof HarnessDisabledError) {
          set({ harnessState: 'disabled' });
          return { ok: false, error: 'O harness de agentes está desligado.' };
        }
        // A backend from before this step has no such route: the "Sobre" tab and the checklist simply are not there.
        if (e instanceof ApiError && e.status === 404 && get().agents.some((a) => a.id === agentId)) {
          set({ pagesUnavailable: true });
          return { ok: false, code: 'not_found' };
        }
        return { ok: false, error: 'Não consegui carregar a página do agente agora.' };
      }
    },

    saveChecklist: (agentId, patch) =>
      agentGuard(agentId, async () => {
        const checklist = await api.putAgentChecklist(agentId, patch);
        set((s) => {
          const page = s.agentPages[agentId];
          return page ? { agentPages: { ...s.agentPages, [agentId]: { ...page, checklist } } } : {};
        });
        return { ok: true };
      }),

    setAgentPaused: (agentId, paused) =>
      agentGuard(agentId, async () => {
        const def = await api.updateAgent(agentId, { enabled: !paused });
        set((s) => ({ agents: mergeAgents(s.agents, [def]) }));
        if (get().agentPages[agentId]) void get().loadAgentPage(agentId);
        return { ok: true };
      }),

    archiveAgent: (agentId) =>
      agentGuard(agentId, async () => {
        const def = await api.archiveAgent(agentId);
        set((s) => {
          const flagged: Agent = { ...def, archived: true, archived_at: def.archived_at ?? new Date().toISOString() };
          return {
            ...dropAgents(s, new Set([agentId])),
            agents: s.agents.filter((a) => a.id !== agentId),
            archivedAgents: [...s.archivedAgents.filter((a) => a.id !== agentId), flagged],
          };
        });
        void get().loadSetup();
        return { ok: true };
      }),

    restoreAgent: (agentId) =>
      agentGuard(agentId, async () => {
        const def = await api.unarchiveAgent(agentId);
        const back: Agent = { ...def, archived: false, archived_at: null };
        set((s) => ({
          agents: [...s.agents.filter((a) => a.id !== agentId), back],
          archivedAgents: s.archivedAgents.filter((a) => a.id !== agentId),
        }));
        // The home and the routines come back with the agent: read them again.
        void api
          .listProjects()
          .then((list) => set({ projects: list.filter((p) => !p.archived) }))
          .catch(() => undefined);
        void get().loadRoutines();
        void get().loadSetup();
        return { ok: true };
      }),

    loadArchivedAgents: async () => {
      if (get().archivedState !== 'ready') set({ archivedState: 'loading' });
      try {
        const list = await api.listAgents({ includeArchived: true });
        set({ archivedAgents: list.filter((a) => a.archived), archivedState: 'ready' });
      } catch (e) {
        if (e instanceof HarnessDisabledError) set({ harnessState: 'disabled' });
        else set({ archivedState: 'error' });
      }
    },

    loadUsage: async (days) => {
      const window = days ?? get().usageDays;
      const seq = ++usageSeq;
      set({ usageDays: window, usageState: 'loading' });
      try {
        const usage = await api.getUsage(window);
        // A slower answer of an earlier period never overwrites the one the owner asked for last.
        if (seq === usageSeq) set({ usage, usageState: 'ready' });
      } catch (e) {
        if (seq !== usageSeq) return;
        if (e instanceof HarnessDisabledError) set({ harnessState: 'disabled' });
        // A backend from before this step has no such route: the usage block simply is not there.
        else set({ usageState: e instanceof ApiError && e.status === 404 ? 'unavailable' : 'error' });
      }
    },

    undoTeam: async (batchId) => {
      if (undoTeamFlight.has(batchId)) return { ok: false };
      undoTeamFlight.add(batchId);
      try {
        const res = await api.undoTeamBatch(batchId);
        set((s) => {
          const gone = new Set(res.removed.map((a) => a.agent_id));
          const toArchive = new Set(res.archived.map((a) => a.agent_id));
          const stamp = new Date().toISOString();
          const flagged = s.agents.filter((a) => toArchive.has(a.id)).map((a) => ({ ...a, archived: true, archived_at: stamp }));
          return {
            ...dropAgents(s, new Set([...gone, ...toArchive])),
            agents: s.agents.filter((a) => !gone.has(a.id) && !toArchive.has(a.id)),
            archivedAgents: [...s.archivedAgents.filter((a) => !gone.has(a.id) && !toArchive.has(a.id)), ...flagged],
            teamUndo: { ...s.teamUndo, [batchId]: { phase: 'done' as const, ...res } },
          };
        });
        void get().loadSetup();
        return { ok: true };
      } catch (e) {
        if (e instanceof HarnessDisabledError) {
          set({ harnessState: 'disabled' });
          return { ok: false, error: 'O harness de agentes está desligado.' };
        }
        const status = e instanceof ApiError ? e.status : null;
        const code = e instanceof ApiError ? e.code : '';
        const text = undoErrorSentence(status, code);
        if (status === 409 && (code === 'undo_expired' || code === 'already_undone')) {
          set((s) => ({ teamUndo: { ...s.teamUndo, [batchId]: { phase: 'closed' as const, code, text } } }));
          // Another screen may have done it: read what exists now.
          if (code === 'already_undone') void refreshRoster();
        }
        return { ok: false, error: text, ...(code ? { code } : {}) };
      } finally {
        undoTeamFlight.delete(batchId);
      }
    },

    restoreAgentVersion: async (agentId, version) => {
      let agent: Agent | undefined;
      const res = await guard(async () => {
        try {
          const { def } = await api.restoreAgentVersion(agentId, version);
          agent = def;
          set((s) => ({ agents: mergeAgents(s.agents, [def]) }));
          return { ok: true };
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          return { ok: false, error: versionErrorMessage(e.status, e.code, e.detail), ...(e.code ? { code: e.code } : {}) };
        }
      });
      return { ...res, agent };
    },
  };
});

/** Test helper: back to a pristine store with no stream or timers. */
export function resetAgentsStore(): void {
  runsInFlight.clear();
  resyncFlight = null;
  stopSocket?.();
  stopSocket = null;
  initFlight = null;
  didInit = false;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  for (const t of messageTimers.values()) clearTimeout(t);
  messageTimers.clear();
  eventsInFlight.clear();
  undoFlight.clear();
  actionsInFlight.clear();
  routineRunsInFlight.clear();
  proposalsInFlight.clear();
  guideSendFlight = false;
  undoTeamFlight.clear();
  usageSeq = 0;
  useAgentsStore.setState(initialState());
}
