/**
 * Wire types for the agents harness (`/agents/*`). Everything the backend
 * sends is described here and nowhere else, so reconciling the contract is a
 * single-file change. The backend (`backend/seraphine/agents/routes.py` +
 * `service.py`) is the source of truth; `api.ts` throws an `ApiError` when a
 * response does not have the shape below.
 *
 * CONTRACT (all routes except bootstrap need header `X-Seraphine-Agents-Token`;
 * booleans are real JSON booleans; `acceptance` is a parsed JSON array;
 * timestamps are ISO-8601 UTC strings):
 *
 *   POST   /agents/bootstrap (no body)          -> {token: string}            403 unless loopback + allowed Origin, 503 token not ready, GET = 405
 *   GET    /agents/overview                     -> {pending_approvals: Approval[], active_runs: Run[], spend_today: SpendRow[]}
 *   GET    /agents/engines                      -> {engines: EngineInfo[]}    runtimes: codex | claude_code | chat ("ollama" = legacy alias of chat); can_act false for chat
 *   GET    /agents/providers                    -> {providers: ProviderInfo[]}  catalog + `configured`/`reason`; never carries keys or URLs
 *   WS     /agents/ws                           -> live channel for browsers (see below)
 *   GET    /agents/stream                       -> NDJSON, one StreamLine per line (non-browser clients only; the UI never opens it)
 *   GET    /agents/projects[?include_archived]  -> {projects: Project[]}
 *   POST   /agents/projects                     -> {project: Project}
 *   PATCH  /agents/projects/{id}                -> {project: Project}
 *   DELETE /agents/projects/{id}                -> {project: Project}         (archives: archived=true)
 *   GET    /agents/projects/{id}/messages       -> {messages: Message[]}      ?after=<message id (uuid)>&limit
 *   POST   /agents/projects/{id}/messages       -> SendMessageResult          body {body, agent_id?, task_id?, mode?: 'join'|'interrupt'} (mode only sent when not 'join'); 200 even when routing/starting failed: see error/detail; 409 `inbox_full` (20 messages already wait for that agent's run)
 *   Phase 6a (docs/agent-harness/contratos/fase-6a-primeiros-passos-e-times.md):
 *   GET    /agents/setup                        -> {setup: Setup}             PUT same path, partial body {areas?, areas_skipped?, default_engine?, dismissed?} -> {setup}
 *   GET    /agents/packs                        -> {packs: Pack[]}
 *   POST   /agents/guide/propose                -> {proposal: Proposal}       body {text, previous?: {agents}, areas?}; 503 `guide_unavailable`, 409 `guide_busy`, 422
 *   POST   /agents/team                         -> TeamResult                 body {origin: 'pack:<id>'|'guide', agents: AgentDraft[]}; 200 even when some (or all) failed
 *   POST   /agents/defs/{id}/home               -> {project: Project}         ensures the agent's home conversation; 404, 422 `home_unavailable`
 *   Phase 6b (docs/agent-harness/contratos/fase-6b-rotinas.md): agent routines.
 *   GET    /agents/routines[?agent_id]          -> {routines: Routine[]}          404 = an older backend: every routines feature hides
 *   POST   /agents/routines                     -> {routine: Routine}             body {agent_id, title, prompt, schedule, report?, enabled?}; 404, 422, 409 `routine_limit`
 *   PATCH  /agents/routines/{id}                -> {routine: Routine}             partial body {title?, prompt?, schedule?, report?, enabled?}; 409 `routine_limit` when turning on
 *   DELETE /agents/routines/{id}                -> {ok: true}
 *   POST   /agents/routines/{id}/run            -> {routine, run}                 "Rodar agora"; 409 `routine_running`
 *   POST   /agents/routines/{id}/copy           -> {routine}                      born turned off, origin `copy`
 *   GET    /agents/routines/{id}/runs[?limit]   -> {runs: RoutineRun[]}           the ledger, newest first
 *   POST   /agents/routines/draft               -> {draft, say}                   body {text, agent_id?}; nothing is created; 503 `guide_unavailable`, 409 `guide_busy`
 *   Phase 6c part 1 (docs/agent-harness/contratos/fase-6c1-conversa-com-a-seraphine.md): the conversation with the Seraphine and agent history.
 *   GET    /agents/guide/messages[?limit]       -> {messages: GuideMessage[], proposals: GuideProposal[]}   404 = an older backend: the conversation hides
 *   POST   /agents/guide/messages               -> {message, reply, proposals}    body {body, about?: {agent_id?, routine_id?}}; 503 `guide_unavailable` (the message stays stored), 409 `guide_busy`, 422
 *   DELETE /agents/guide/messages               -> {ok: true}
 *   POST   /agents/guide/proposals/{id}/apply   -> {proposal, agents, routines}   409 `proposal_not_pending` | `proposal_stale` | `routine_limit`, 422, 404
 *   POST   /agents/guide/proposals/{id}/dismiss -> {proposal}                     409 `proposal_not_pending`
 *   GET    /agents/defs/{id}/versions           -> {versions: AgentVersion[]}     newest first, 404 = an older backend: the history hides
 *   POST   /agents/defs/{id}/versions/{n}/restore -> {def, version}               404, 409 `version_current`
 *   Agent has `version` (number).
 *   Phase 6c part 2 (docs/agent-harness/contratos/fase-6c2-pagina-do-agente-e-ajustes.md): the agent page, pause and archive, usage, undo of a team.
 *   Agent has `archived` (boolean) and `archived_at` (string | null), always present after parsing (false / null for a backend that does not send them).
 *   POST   /agents/defs/{id}/archive            -> {def}                          409 `agent_busy` while a run is in progress; calling it again changes nothing
 *   POST   /agents/defs/{id}/unarchive          -> {def}                          restores the agent and its home
 *   GET    /agents/defs[?include_archived=true] -> {defs}                         archived agents only come with the flag
 *   GET    /agents/defs/{id}/page               -> AgentPage                      404 = an older backend: the "Sobre" tab and the checklist hide
 *   PUT    /agents/defs/{id}/checklist          -> {checklist}                    partial body {access_ok?, routine_skipped?, dismissed?}
 *   GET    /agents/usage?days=7|30|90           -> Usage                          404 = an older backend: the usage block hides
 *   POST   /agents/team                         -> TeamResult also has `batch: {id, undo_until} | null` (`null`/missing = nothing to undo); a proposal's `result.batch` too
 *   GET    /agents/team/batches/{id}            -> {batch: TeamBatch}             404 = an older backend (or an unknown batch): undo hides
 *   POST   /agents/team/batches/{id}/undo       -> TeamUndoResult                 404; 409 `undo_expired` | `already_undone`
 *   A message to an archived agent answers `error: 'agent_archived'`; PATCH of an archived agent and "Rodar agora" of its routines are 409 `agent_archived`.
 *   Run has `routine_id`/`routine_title`, Message has `routine_id` (all `null` when the backend does not send them), the overview has
 *   `routines_active`, an agent draft has `routines`, `POST /agents/team` answers `routines`. Live frames `routine_update` {routine}
 *   and `routine_deleted` {id}.
 *   Project has `kind` ('project'|'home') and `agent_id`; Agent has `description`, `suggestions`, `home_project_id`, `origin`;
 *   ProviderInfo has `how`. A home answers 409 `home_managed` to a rename, a path change, an archive or a delete.
 *   GET    /agents/defs                         -> {defs: Agent[]}
 *   POST   /agents/defs                         -> {def: Agent}
 *   GET    /agents/defs/{id}                    -> {def: Agent}
 *   PATCH  /agents/defs/{id}                    -> {def: Agent}
 *   DELETE /agents/defs/{id}                    -> {ok: true}                 409 while the agent has active runs
 *   GET    /agents/tools                        -> {groups: ToolGroup[]}      step 3b: catalogue of the Seraphine's tools (read-only), by group
 *   GET    /agents/defs/{id}/grants             -> {grants: Grants}           every group, defaults applied
 *   PUT    /agents/defs/{id}/grants             -> {grants: Grants}           body {grants: {<group>: 'none'|'read'|'write'}} (partial ok); 422 unknown group / invalid level
 *   GET    /agents/actions?run_id=              -> {actions: AgentAction[]}   step 3c: the writes a run made (receipts)
 *   POST   /agents/actions/{id}/undo            -> {action: AgentAction}      no body. 409 codes: undo_expired | already_undone | undo_conflict; 404 unknown action
 *   GET    /agents/bridge/status                -> {engines: BridgeEngineStatus[]}
 *   POST   /agents/bridge/test                  -> BridgeTestResult           body {engine}; uses a little of the owner's plan; 409 `test_running`
 *   GET    /agents/tasks[?project_id&status]    -> {tasks: Task[]}
 *   POST   /agents/tasks                        -> {task: Task}
 *   GET    /agents/tasks/{id}                   -> {task: Task}
 *   PATCH  /agents/tasks/{id}                   -> {task: Task}
 *   GET    /agents/tasks/{id}/messages          -> {messages: Message[]}
 *   POST   /agents/tasks/{id}/run               -> {run: Run}
 *   POST   /agents/runs                         -> {run: Run}
 *   GET    /agents/runs[?project_id&status&limit] -> {runs: Run[]}
 *   GET    /agents/runs/{id}                    -> {run: Run}
 *   POST   /agents/runs/{id}/cancel             -> {run: Run}
 *   POST   /agents/runs/{id}/continue           -> {run: Run}                 no body; creates a NEW run that continues the old one. 409 codes: continue_not_allowed | already_continued | <agent busy>; 404 unknown run
 *   POST   /agents/runs/{id}/wake               -> {run: Run}                 no body; takes a parked run out of parking and queues it now. 404 unknown run; 409 `not_parked`
 *   GET    /agents/runs/{id}/events             -> {events: HarnessEvent[]}   ?after=<event id (integer)>&limit
 *   GET    /agents/runs/{id}/stream             -> NDJSON of StreamLine, ends with {type:'end'}   ?after=<event id (integer)>  (non-browser clients only)
 *   GET    /agents/approvals[?status=pending]   -> {approvals: Approval[]}    status: pending | approved | denied | expired
 *   POST   /agents/approvals/{id}/decide        -> {approval: Approval}       body {decision, digest, confirm_high_risk?, note?}; 409 codes: digest_mismatch | high_risk_unconfirmed | approval_expired | already_decided | run_not_waiting
 *
 *   WS /agents/ws (a long-lived HTTP fetch leaks a connection per reload; WebSockets are not subject to the
 *   6-per-host HTTP limit). The token is NEVER in the URL. Handshake is accepted first, then:
 *     harness off -> close 4404;  Origin present and not allowed -> close 4403;
 *     client's FIRST frame within 5s must be {"type":"auth","token":"<token>"}, else close 4401;
 *     server answers {"type":"ready"}, then sends one JSON text frame per StreamLine
 *     (event | message | run_update | heartbeat, same shapes as the ndjson stream; never `end`).
 *     Client may send {"type":"ping"} -> {"type":"pong"}; every other client frame is ignored.
 *   The client (api.ts `openGlobalSocket`) is "connected" only after `ready`, reconnects with backoff 1s..15s,
 *   pings every 25s and drops a socket silent for 60s. 4401 -> new bootstrap, 4404 -> disabled, 4403 -> stop.
 *
 *   Agent = RUNTIME (`engine`: who runs the loop) + PROVIDER (`provider`: which LLM/plan/key it thinks with)
 *   + `model` (free text, null = provider default) + `reasoning_effort` (null | low | medium | high; codex and
 *   claude_code only) + optional fallback (`fallback_engine`/`fallback_provider`/`fallback_model`, all nullable).
 *   POST/PATCH /agents/defs accept the same fields; `provider: null` = the runtime's default provider (codex ->
 *   openai, claude_code -> anthropic, chat -> ollama). A runtime/provider pair the catalog does not allow is
 *   422 {detail: <pt-BR text>}. API keys live only in the backend environment: they are never sent here.
 *   A Run records the engine/provider/model/reasoning_effort it actually used (the fallback, when it kicked in).
 *   Run failure codes (Run.error): 'engine_auth' (login not fixed within a day of parking), 'engine_unavailable',
 *   'provider_unavailable' (outage lasted a day), 'plan_limit' (limit did not come back in time), ...
 *
 *   Step 1c: a message to an agent that has an active run in the same project joins that run's inbox (`joined`), read at the
 *   agent's next pause; `mode: 'interrupt'` ("Parar e mandar", only while `running`) ends the current turn and delivers it now
 *   (`interrupted`). `Message.delivery` tells the owner whether the agent read it; `Run.inbox_count` how many wait.
 *
 *   Errors: {detail: string}; a request-body validation error is 422 with
 *   {detail: [{loc, msg, type}]}. Harness switched off: 404 {detail: 'agents harness disabled'}.
 *
 * Event payloads (`HarnessEvent.payload`, by `kind`):
 *   status            {status: RunStatus, error?: string, note?: string, reason?: string, recoveries?: number}
 *                     (`reason: 'recovered'` + `status: 'queued'`: resumed by itself after a restart; `recoveries` = how many times so far)
 *                     {status: 'parked', wait_kind, wait_until, wait_attempts} on every parking;
 *                     {status: 'queued', reason: 'woke', by: 'timer'|'owner'} on every return from parking
 *   step              {type: 'note'|'reasoning', text} | {type: 'file_change', changes: {path, kind}[]}
 *                     (a `note` may carry `reason: 'recovered'|'parked'|'woke'|'inbox'|'interrupted_by_owner'`: a system line, not the agent's voice;
 *                     `inbox` also carries `count`: how many messages the agent just read)
 *                     | {type: 'web_search', query} | {type: 'tool_use', tool, target} | {type: 'tool_call', tool}
 *                     | {type: 'command', command}
 *                     An ACTION (everything but note/reasoning) carries `phase` ('started' | 'completed') and `call_id`:
 *                     started + completed with the same call_id are one action; a lone completed is also valid. The
 *                     harness' own approved command is `{type:'command', phase:'started', call_id:<approval id>}` and
 *                     its `command` event (with `approval_id`) is the end.
 *   message           {text: string}
 *   command           {command: string, exit_code: number | null, output: string, by: 'agent'|'harness', approval_id?: string, timed_out?: boolean}
 *   approval_request  {approval_id, title, command, reason, risk_level, risk_reasons: string[], digest, expires_at}  (events recorded before approvals v2 lack the last four)
 *   approval_result   {approval_id, decision: 'approved'|'denied'|'expired', title, decided_by?: 'owner'|'harness', note?: string | null}
 *   error             {message: string}
 *   Step 1d: a `step` note may also carry `reason: 'limit_warning'` (2 actions before the cap) or `reason: 'limit_stop'`
 *   (+ `limit`: the RunLimit that ended the turn); both are system lines with the note's own `text`.
 *   Step 3b: a tool call is an action `{type:'seraphine_tool', phase, call_id, tool, group, label, read_only}`; its `completed`
 *   also carries `ok`, `summary` (<= 400 chars) and, when it failed, `error`. A `note` with `reason: 'tool_denied'`
 *   (+ `tool`, `group`) or `reason: 'bridge_unavailable'` is a system line with the note's own `text`.
 *   Step 3c: a tool that writes completes with `read_only: false`, `action_id` and `undo_until`; a `note` with
 *   `reason: 'action_undone'` (+ `action_id`) or `reason: 'asked_owner'` is a system line. `status` `parked` may carry
 *   `wait_kind: 'owner_input'`: the agent asked the owner something (`Run.question`) and waits for the answer. The live channel
 *   also sends `{type: 'action_update', action}` whenever an action changes (undone here or on another screen).
 *   Continuity: a Run carries `session_mode` and `session_from`; a `note` with `reason: 'session'` (+ `mode`) is a system line with
 *   the note's own `text`. The message post takes an optional `fresh: true` ("Começar do zero"), sent only when true.
 *   Step 1d: every WS frame carries `boot` (string, the backend process) and `seq` (integer, +1 per frame on a connection,
 *   1 = `ready`, heartbeats and pongs included). A jump in `seq` or a new `boot` means frames were lost: resync.
 *   Older backends send neither: the page then tracks nothing.
 *
 * Stream lines (`type`): 'event' (a HarnessEvent plus type), 'message' {message}, 'message_update' {message} (its `delivery` changed),
 * 'run_update' {run}, 'action_update' {action}, 'routine_update' {routine}, 'routine_deleted' {id}, 'heartbeat' {ts}, 'end' {run_id, status} (run stream only).
 */

/** Who runs the agent loop. `ollama` is the legacy name of `chat` (the API still accepts it). */
export type RuntimeName = 'codex' | 'claude_code' | 'chat';
export type EngineName = RuntimeName | 'ollama';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ProviderKind = 'plan' | 'api_key' | 'local';

/** One entry of `GET /agents/providers`. */
export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Runtimes that can use this provider. */
  runtimes: string[];
  /** Usable right now (key present / CLI logged in / local server answering). */
  configured: boolean;
  /** Why it is not configured (pt-BR; empty when it is). */
  reason: string;
  default_model: string | null;
  notes: string;
  /** Phase 6a: pt-BR sentence saying what the owner does to make this provider ready (never asks for a secret); `""` when it is ready. */
  how: string;
}

export interface EngineInfo {
  name: EngineName | string;
  available: boolean;
  /** Why it is unavailable (empty when it is available). */
  reason: string;
  /** False for conversation-only engines (no files, no commands). */
  can_act: boolean;
}

/** `home`: the private conversation of one agent (phase 6a); it never shows in a PROJETOS list. */
export type ProjectKind = 'project' | 'home';

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string;
  archived: boolean;
  created_at: string;
  /** Phase 6a: always present after parsing (`project` for a backend that does not send it yet). */
  kind: ProjectKind;
  /** Owner agent of a home; null for a plain project. */
  agent_id: string | null;
}

export interface ProjectInput {
  name: string;
  path: string;
  description?: string;
}

export type EditPermission = 'free' | 'blocked';
export type CommandPermission = 'ask' | 'blocked';

/**
 * What an agent may do, per group of the Seraphine's own tools: nothing, consult (`read`) or consult and write (`write`, step 3c).
 * A group accepts only the levels it lists in `ToolGroup.levels`.
 */
export type GrantLevel = 'none' | 'read' | 'write';
export const GRANT_LEVELS: readonly GrantLevel[] = ['none', 'read', 'write'];
/** Group id -> level. */
export type Grants = Record<string, GrantLevel>;

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  read_only: boolean;
  /** The level the tool needs (step 3c); read from `read_only` when an older answer lacks it. */
  level: 'read' | 'write';
}

/** One entry of `GET /agents/tools`: a group of tools the owner grants as a whole. */
export interface ToolGroup {
  id: string;
  label: string;
  description: string;
  /** Level an agent has in this group when nothing was recorded for it. */
  default: GrantLevel;
  /** What is read here goes to the agent's AI provider and holds private matters (the personal memory). */
  sensitive: boolean;
  /** Levels this group accepts (step 3c); `['none', 'read']` when an older answer lacks it. */
  levels: GrantLevel[];
  tools: ToolInfo[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  engine: string;
  provider: string | null;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  fallback_engine: string | null;
  fallback_provider: string | null;
  fallback_model: string | null;
  color: string;
  perm_edit: EditPermission;
  perm_commands: CommandPermission;
  daily_budget_usd: number | null;
  enabled: boolean;
  project_ids: string[];
  /** Step 3b: always present after parsing (`{}` for a backend that does not send it yet). */
  grants: Grants;
  /** Phase 6a, always present after parsing: what the agent does, one or two sentences for the owner (max 300). */
  description: string;
  /** Phase 6a: up to 3 example requests for the empty conversation (each max 120). */
  suggestions: string[];
  /** Phase 6a: id of the agent's home conversation, when it exists. */
  home_project_id: string | null;
  /** Phase 6a: `manual`, `pack:<id>` or `guide`. */
  origin: string;
  /** Phase 6c: version of the agent's text in its history; always present after parsing (0 when there is no history yet or the backend does not send it). */
  version: number;
  /** Phase 6c part 2: archived agents leave every list but keep their conversation, routines, history and folder. Always present after parsing. */
  archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields the owner edits; the server owns id, timestamps, `origin`, `version` and `home_project_id`. Grants have their own route (`PUT /defs/{id}/grants`). */
export type AgentInput = Omit<Agent, 'id' | 'created_at' | 'updated_at' | 'grants' | 'home_project_id' | 'origin' | 'version' | 'archived' | 'archived_at' | 'description' | 'suggestions'> &
  Partial<Pick<Agent, 'description' | 'suggestions'>>;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'parked'
  | 'done'
  | 'failed'
  | 'cancelled';

/** `parked` is active: it keeps the agent's slot and comes back by itself or when the owner asks. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_approval', 'parked'];

/**
 * Why a parked run waits: the provider is down, the plan's usage limit ran out, the engine's login expired, or the agent
 * asked the owner a question (`owner_input`, step 3c).
 */
export type WaitKind = 'outage' | 'plan_limit' | 'auth' | 'owner_input';
export const WAIT_KINDS: readonly WaitKind[] = ['outage', 'plan_limit', 'auth', 'owner_input'];

/** What the agent asked the owner (`ask_owner`); only on a run parked with `wait_kind: 'owner_input'`. */
export interface RunQuestion {
  text: string;
  /** Up to 4 suggested answers; empty when the agent wants a free answer. */
  options: string[];
  asked_at: string;
}

export interface Run {
  id: string;
  agent_id: string;
  project_id: string;
  task_id: string | null;
  goal: string;
  status: RunStatus;
  engine: string;
  provider: string | null;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  session_ref: string | null;
  requested_by: string;
  result_summary: string | null;
  /**
   * Failure code ('budget_exceeded', 'engine_error', ...) when status is 'failed'.
   * `interrupted` / `interrupted_mid_action`: the backend restarted while the run was working.
   */
  error: string | null;
  exit_code: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  approvals_used: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Times the run was resumed by itself after a restart. */
  recoveries: number;
  /** `POST /runs/{id}/continue` would be accepted now (agent busy not considered). */
  can_continue: boolean;
  /** Id of the run this one continues. */
  continued_from: string | null;
  /** Id of the run that continued this one. */
  continued_by: string | null;
  /** Why the run is parked; null outside `parked`. */
  wait_kind: WaitKind | null;
  /** Next automatic attempt (ISO 8601 UTC); null for `auth` and outside `parked`. */
  wait_until: string | null;
  /** First parking of this sequence. */
  wait_since: string | null;
  /** How many times the run parked in this sequence (0 outside `parked`). */
  wait_attempts: number;
  /** pt-BR sentence from the backend: what is waited for or what the owner must do (null outside `parked`). */
  wait_detail: string | null;
  /** True when `wait_until` is the return time the provider gave ("volta às…"), not just the next try. */
  wait_exact: boolean;
  /** Owner messages waiting to be delivered to this run (step 1c). */
  inbox_count: number;
  /** How many actions the run has done so far (step 1d); 0 when the backend does not say. */
  actions_count: number;
  /** The open question while the run waits for the owner's answer (step 3c); null otherwise. */
  question: RunQuestion | null;
  /** How the run began (continuity step); `fresh` when the backend does not say. */
  session_mode: SessionMode;
  /** Id of the run whose engine session this one picked up (only with `continued`); null otherwise. */
  session_from: string | null;
  /** Phase 6b: the routine that started this run; null for any other run (and for a backend that does not send it). */
  routine_id: string | null;
  /** Phase 6b: the routine's title at the time of the run. */
  routine_title: string | null;
}

/**
 * How a run started: `continued` resumed the previous conversation, `fresh_with_history` is a new conversation that
 * received the recent history of the place, `fresh` is a new conversation with only the request.
 */
export type SessionMode = 'continued' | 'fresh_with_history' | 'fresh';
export const SESSION_MODES: readonly SessionMode[] = ['continued', 'fresh_with_history', 'fresh'];

/** Run errors that mean "the backend restarted while this run was working". */
export const INTERRUPTED_ERRORS: readonly string[] = ['interrupted', 'interrupted_mid_action'];

/**
 * Step 1d: the harness ended the turn because of a limit. `step_limit`: too many actions; `stuck_loop`: the same step
 * over and over; `engine_silent`: the engine stopped answering; `turn_timeout`: one stretch of work lasted too long.
 * All of them leave the run `failed` with `can_continue: true`.
 */
export type RunLimit = 'step_limit' | 'stuck_loop' | 'engine_silent' | 'turn_timeout';
export const RUN_LIMIT_ERRORS: readonly RunLimit[] = ['step_limit', 'stuck_loop', 'engine_silent', 'turn_timeout'];

export type EventKind =
  | 'status'
  | 'step'
  | 'message'
  | 'command'
  | 'approval_request'
  | 'approval_result'
  | 'error';

/** A persisted run event. `id` is the integer autoincrement id (also the `after` cursor). */
export interface HarnessEvent {
  id: number;
  run_id: string;
  ts: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

/** One NDJSON line of `/agents/stream` / `/agents/runs/{id}/stream`, or one WebSocket frame of `/agents/ws`. */
export type StreamLine =
  | (HarnessEvent & { type: 'event' })
  | { type: 'message'; message: Message }
  | { type: 'message_update'; message: Message }
  | { type: 'run_update'; run: Run }
  | { type: 'action_update'; action: AgentAction }
  | { type: 'routine_update'; routine: Routine }
  | { type: 'routine_deleted'; id: string }
  | { type: 'heartbeat'; ts: string }
  | { type: 'end'; run_id: string; status: RunStatus | 'unknown' };

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type RiskLevel = 'low' | 'medium' | 'high';
export type DecidedBy = 'owner' | 'harness';

export interface Approval {
  id: string;
  run_id: string;
  agent_id: string;
  project_id: string;
  title: string;
  command: string;
  reason: string;
  status: ApprovalStatus;
  output: string | null;
  created_at: string;
  decided_at: string | null;
  risk_level: RiskLevel;
  /** Short pt-BR sentences, one per finding; empty for low risk. */
  risk_reasons: string[];
  /** SHA-256 of the exact command the owner sees; sent back when approving. */
  command_digest: string;
  /** After this instant the request can no longer be approved. Null only for requests rebuilt from pre-v2 events. */
  expires_at: string | null;
  decided_by: DecidedBy | null;
  /** Reason given with a denial, or the harness' automatic reason. */
  decision_note: string | null;
}

/** What happened to an owner message sent while the agent was working: read at the next pause, read, or never read. */
export type MessageDelivery = 'pending' | 'delivered' | 'undelivered';
export const MESSAGE_DELIVERIES: readonly MessageDelivery[] = ['pending', 'delivered', 'undelivered'];

/** `join`: the agent reads it at its next pause. `interrupt` ("Parar e mandar"): stop the current turn and read it now. */
export type SendMode = 'join' | 'interrupt';

export interface Message {
  id: string;
  project_id: string;
  task_id: string | null;
  author: string;
  body: string;
  run_id: string | null;
  created_at: string;
  /** Only for owner messages linked to a run; null otherwise (and for rows from before step 1c). */
  delivery: MessageDelivery | null;
  /** Phase 6b: set on messages published by a routine's run; null otherwise (and for a backend that does not send it). */
  routine_id: string | null;
}

/**
 * The message is always stored. When no run could be started, `run` is null,
 * `error` is a code slug (`no_agent`, `agent_not_available`, `engine_unavailable`,
 * `agent_disabled`, `project_archived`, `no_access`, ...) and `detail` the
 * human-readable text (Portuguese).
 */
export interface SendMessageResult {
  message: Message;
  agent_id: string | null;
  run: Run | null;
  error: string | null;
  detail: string | null;
  /** The message entered the inbox of a run that already existed (`run` is that run, not a new one). */
  joined: boolean;
  /** The turn in progress was ended to deliver the message now. */
  interrupted: boolean;
}

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface AcceptanceItem {
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee_agent_id: string | null;
  priority: TaskPriority;
  due_at: string | null;
  acceptance: AcceptanceItem[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  project_id: string;
  title: string;
  description?: string;
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'assignee_agent_id' | 'priority' | 'due_at' | 'acceptance'>
>;

export interface SpendRow {
  agent_id: string;
  name: string;
  /** Spent today (local day) by this agent across all runs. */
  spent_usd: number;
  daily_budget_usd: number | null;
}

export interface Overview {
  pending_approvals: Approval[];
  active_runs: Run[];
  spend_today: SpendRow[];
  /** Phase 6b: how many routines are turned on (`api.ts` fills 0 when a backend does not send it). */
  routines_active?: number;
}

export type Decision = 'approve' | 'deny';

export interface DecideOptions {
  /** `command_digest` of the approval the owner is looking at (required to approve). */
  digest?: string;
  confirmHighRisk?: boolean;
  note?: string;
}

/** A write an agent made, with what is needed to undo it for a few minutes (step 3c). */
export interface AgentAction {
  id: string;
  run_id: string;
  agent_id: string;
  project_id: string;
  tool: string;
  group: string;
  /** What was done, in pt-BR ("Criou a nota «Compras»"). */
  label: string;
  created_at: string;
  /** Until when it can be undone. */
  undo_until: string;
  undone_at: string | null;
  /** Undoing would be accepted right now. */
  can_undo: boolean;
}

/** Refusals of `POST /actions/{id}/undo` (409 `code`). */
export type UndoErrorCode = 'undo_expired' | 'already_undone' | 'undo_conflict';

export type BridgeEngineName = 'codex' | 'claude_code';
export type BridgeState = 'ok' | 'failed' | 'unknown';

/** One engine in `GET /agents/bridge/status`: whether the Seraphine's tools reached it the last time they were offered. */
export interface BridgeEngineStatus {
  engine: BridgeEngineName | string;
  label: string;
  state: BridgeState;
  last_ok_at: string | null;
  last_failure_at: string | null;
  last_failure: string | null;
}

/** Answer of `POST /agents/bridge/test`. */
export interface BridgeTestResult {
  ok: boolean;
  detail: string;
  took_ms: number;
}

// ---------- phase 6a: first steps, ready teams, guide ----------

/** The seven areas of the first question, in the order the screen shows them. */
export type SetupArea = 'dia_a_dia' | 'estudos' | 'trabalho' | 'programacao' | 'pesquisa_escrita' | 'casa' | 'outra';
export const SETUP_AREAS: readonly SetupArea[] = ['dia_a_dia', 'estudos', 'trabalho', 'programacao', 'pesquisa_escrita', 'casa', 'outra'];

export type SetupStepId = 'areas' | 'engine' | 'agents' | 'first_reply';
export const SETUP_STEP_IDS: readonly SetupStepId[] = ['areas', 'engine', 'agents', 'first_reply'];

export interface SetupEngine {
  engine: string;
  provider: string | null;
  model: string | null;
}

/** `GET/PUT /agents/setup`: what the owner answered plus the steps, computed from real data on every call. */
export interface Setup {
  /** `null` = not answered yet. */
  areas: string[] | null;
  areas_skipped: boolean;
  default_engine: SetupEngine | null;
  dismissed: boolean;
  /** Read-only: where the agents' folders will be created. */
  home_dir: string;
  steps: { id: SetupStepId; done: boolean }[];
  done: number;
  total: number;
}

/** Partial body of `PUT /agents/setup`. */
export interface SetupPatch {
  areas?: string[];
  areas_skipped?: boolean;
  default_engine?: SetupEngine;
  dismissed?: boolean;
}

/** One agent as proposed (ready team, guide) and as sent to `POST /agents/team`. */
export interface AgentDraft {
  name: string;
  role: string;
  description: string;
  instructions: string;
  suggestions: string[];
  color?: string;
  perm_edit?: EditPermission;
  grants?: Grants;
  engine?: string;
  provider?: string;
  model?: string;
  /** Phase 6b: up to 3 routines of the agent (a ready team brings one, a proposal up to 2). Absent for a backend without routines. */
  routines?: RoutineDraft[];
}

/** Limits the backend checks on every create and edit (422 `invalid`). */
export const DRAFT_LIMITS = { name: 80, role: 200, description: 300, instructions: 20000, suggestion: 120 } as const;
export const GUIDE_TEXT_MAX = 2000;
export const TEAM_MAX = 6;

export interface Pack {
  id: string;
  label: string;
  summary: string;
  detail: string;
  areas: string[];
  agents: AgentDraft[];
}

export interface Proposal {
  say: string;
  agents: AgentDraft[];
}

export interface TeamResult {
  created: { def: Agent; home: Project }[];
  failed: { name: string; detail: string }[];
  /** Access that was lowered to the ceiling: what was asked and what the agent got. */
  lowered: { name: string; group: string; asked: GrantLevel; got: GrantLevel }[];
  /** Phase 6b: the routines that were created (turned on); `[]` for a backend that does not send it. */
  routines: Routine[];
  /** Phase 6c part 2: what "Desfazer a criação" undoes; `null` when nothing was created or the backend does not send it. */
  batch: TeamBatchRef | null;
}

/** The part of a team batch that comes with a creation. */
export interface TeamBatchRef {
  id: string;
  /** Until when the creation can be undone (ISO UTC). */
  undo_until: string;
}

// ---------- phase 6b: routines ----------

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'interval' | 'once';
export const SCHEDULE_KINDS: readonly ScheduleKind[] = ['daily', 'weekdays', 'weekly', 'monthly', 'interval', 'once'];

/** The schedule object of the contract (section 1). `time` is `HH:MM` (24 h, local); `days` 0 = Monday ... 6 = Sunday. */
export type Schedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'monthly'; time: string; day: number | 'last' }
  | { kind: 'interval'; every_minutes: number }
  | { kind: 'once'; at: string };

export type RoutineReport = 'news' | 'always';

/** Limits of the contract (section 1 and rule 6). */
export const ROUTINE_LIMITS = { title: 120, prompt: 2000, intervalMin: 15, intervalMax: 1440, maxActive: 20, text: 500 } as const;

export interface Routine {
  id: string;
  agent_id: string;
  /** The agent's home conversation: where it runs and reports. */
  project_id: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  /** pt-BR sentence of the schedule ("Todo dia útil às 08:00"). */
  schedule_text: string;
  report: RoutineReport;
  enabled: boolean;
  /** `failures` when the pause came from consecutive failures. */
  paused_reason: 'failures' | null;
  /** ISO UTC; null when turned off. */
  next_run_at: string | null;
  /** The next 3 times (ISO UTC); empty when turned off. */
  upcoming: string[];
  last_run_at: string | null;
  /** Final state of the last run (a `RoutineRunStatus` word); kept as text so a newer backend never breaks the screen. */
  last_status: string | null;
  consecutive_failures: number;
  /** Last 7 days: how many finished well (`reported` or `quiet`) out of how many had a time. */
  week: { ok: number; total: number };
  /** A run of this routine is in progress. */
  running: boolean;
  /** `manual`, `pack:<id>`, `guide` or `copy`. */
  origin: string;
  created_at: string;
  updated_at: string;
}

/** Body of `POST /agents/routines` (the agent's home is ensured by the backend). */
export interface RoutineInput {
  agent_id: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  report?: RoutineReport;
  enabled?: boolean;
}

export type RoutinePatch = Partial<Pick<Routine, 'title' | 'prompt' | 'schedule' | 'report' | 'enabled'>>;

export type RoutineTrigger = 'schedule' | 'manual' | 'catchup';
export type RoutineRunStatus = 'running' | 'reported' | 'quiet' | 'failed' | 'cancelled' | 'skipped' | 'missed';
export const ROUTINE_RUN_STATUSES: readonly RoutineRunStatus[] = ['running', 'reported', 'quiet', 'failed', 'cancelled', 'skipped', 'missed'];
export const ROUTINE_TRIGGERS: readonly RoutineTrigger[] = ['schedule', 'manual', 'catchup'];

/** One line of the ledger of a routine (contract section 3). */
export interface RoutineRun {
  id: string;
  routine_id: string;
  scheduled_for: string;
  trigger: RoutineTrigger;
  status: RoutineRunStatus;
  run_id: string | null;
  /** pt-BR sentence when the time failed, was skipped or missed. */
  detail: string;
  finished_at: string | null;
}

/** A routine inside an agent draft (ready team or proposal) and in the body of `POST /agents/team`. */
export interface RoutineDraft {
  title: string;
  prompt: string;
  schedule: Schedule;
  report?: RoutineReport;
  /** Not in the contract's draft shape: read when the backend sends it, else the page words the schedule itself. Never sent back. */
  schedule_text?: string;
}

/** Answer of `POST /agents/routines/draft`: nothing was created, the owner reviews and saves. */
export interface RoutineDraftResult {
  draft: { title: string; prompt: string; schedule: Schedule; schedule_text: string; report: RoutineReport };
  say: string;
}

// ---------- phase 6c part 1: conversation with the Seraphine, proposals, history ----------

/** One message of the conversation of the owner with the Seraphine (contract section 1). */
export interface GuideMessage {
  id: string;
  author: 'owner' | 'seraphine';
  body: string;
  /** Proposals that came with this answer (only on `seraphine`). */
  proposal_ids: string[];
  created_at: string;
}

/** What the owner is talking about, sent with the next message only. */
export interface GuideAbout {
  agent_id?: string;
  routine_id?: string;
}

export const GUIDE_BODY_MAX = 2000;

export type ProposalKind = 'create_agents' | 'update_agent' | 'create_routine' | 'update_routine';
export const PROPOSAL_KINDS: readonly ProposalKind[] = ['create_agents', 'update_agent', 'create_routine', 'update_routine'];
export type ProposalStatus = 'pending' | 'applied' | 'dismissed' | 'expired' | 'stale' | 'failed';
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['pending', 'applied', 'dismissed', 'expired', 'stale', 'failed'];

/** The five texts of an agent that a proposal may change and that the history keeps. */
export type AgentTextField = 'name' | 'role' | 'description' | 'instructions' | 'suggestions';
export const AGENT_TEXT_FIELDS: readonly AgentTextField[] = ['name', 'role', 'description', 'instructions', 'suggestions'];
export type AgentTextChanges = Partial<{ name: string; role: string; description: string; instructions: string; suggestions: string[] }>;
export type RoutineProposalChanges = Partial<{ title: string; prompt: string; schedule: Schedule; schedule_text: string; report: RoutineReport; enabled: boolean }>;

export type ProposalPayload =
  | { kind: 'create_agents'; agents: AgentDraft[] }
  | { kind: 'update_agent'; agent_id: string; changes: AgentTextChanges }
  | { kind: 'create_routine'; agent_id: string; routine: RoutineDraft }
  | { kind: 'update_routine'; routine_id: string; changes: RoutineProposalChanges };

/** `before`: the current state of the fields a proposal changes (contract section 2); the schedule keeps both shapes when the backend sends them. */
export type ProposalBefore = AgentTextChanges & RoutineProposalChanges;

export interface ProposalResult {
  agent_ids?: string[];
  routine_ids?: string[];
  failed?: { name: string; detail: string }[];
  /** Phase 6c part 2: only on an applied `create_agents`. */
  batch?: TeamBatchRef | null;
}

/** A proposal card of the Seraphine (contract section 2). `payload` is a discriminated union on `kind` after parsing. */
export interface GuideProposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  payload: ProposalPayload;
  before: ProposalBefore | null;
  target: { agent_id?: string; routine_id?: string };
  result: ProposalResult | null;
  /** pt-BR sentence when `stale`, `failed` or `expired` (and for a proposal replaced by a newer one); '' when the backend sends none. */
  detail: string;
  created_at: string | null;
  expires_at: string | null;
  decided_at: string | null;
}

export type AgentChangedBy = 'owner' | 'guide' | 'pack' | 'restore';
export const AGENT_CHANGED_BY: readonly AgentChangedBy[] = ['owner', 'guide', 'pack', 'restore'];

/** One version of an agent's text (contract section 3). */
export interface AgentVersion {
  version: number;
  name: string;
  role: string;
  description: string;
  instructions: string;
  suggestions: string[];
  changed_by: AgentChangedBy;
  note: string;
  changed_fields: AgentTextField[];
  created_at: string;
}

// ---------- phase 6c part 2: agent page, checklist, usage, undo of a team ----------

export type ChecklistItemId = 'engine' | 'first_talk' | 'access' | 'routine';
export const CHECKLIST_ITEM_IDS: readonly ChecklistItemId[] = ['engine', 'first_talk', 'access', 'routine'];

export interface ChecklistItem {
  /** A known id of the contract (`ChecklistItemId`); a newer backend may send others, which the screen ignores. */
  id: string;
  done: boolean;
  optional: boolean;
}

export interface Checklist {
  items: ChecklistItem[];
  done: number;
  total: number;
  dismissed: boolean;
}

/** Partial body of `PUT /agents/defs/{id}/checklist`. */
export interface ChecklistPatch {
  access_ok?: boolean;
  routine_skipped?: boolean;
  dismissed?: boolean;
}

/** `GET /agents/defs/{id}/page`: everything the "Sobre" tab shows. */
export interface AgentPage {
  def: Agent;
  home: Project | null;
  engine: { ready: boolean; label: string; how: string };
  access: { group: string; label: string; level: GrantLevel }[];
  routines: { total: number; active: number; next_run_at: string | null };
  activity: { runs: number; last_run_at: string | null; tokens_in: number; tokens_out: number };
  checklist: Checklist;
}

export const USAGE_PERIODS: readonly number[] = [7, 30, 90];

export interface UsageAgentRow {
  agent_id: string;
  name: string;
  archived: boolean;
  runs: number;
  routine_runs: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  /** True when some run of the agent in the window reported a cost. */
  cost_known: boolean;
  last_run_at: string | null;
}

export interface UsageDay {
  /** `YYYY-MM-DD`, local day. */
  date: string;
  runs: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/** `GET /agents/usage?days=`. */
export interface Usage {
  days: number;
  totals: { runs: number; routine_runs: number; tokens_in: number; tokens_out: number; cost_usd: number };
  agents: UsageAgentRow[];
  by_day: UsageDay[];
}

/** `GET /agents/team/batches/{id}`. */
export interface TeamBatch {
  id: string;
  undo_until: string;
  undone_at: string | null;
  can_undo: boolean;
  agents: { agent_id: string; name: string; exists: boolean }[];
}

/** `POST /agents/team/batches/{id}/undo`: what happened to each agent of the team. */
export interface TeamUndoResult {
  removed: { agent_id: string; name: string }[];
  archived: { agent_id: string; name: string }[];
  /** An agent with a run in progress stays as it is; `detail` says why. */
  kept: { agent_id: string; name: string; detail: string }[];
}
