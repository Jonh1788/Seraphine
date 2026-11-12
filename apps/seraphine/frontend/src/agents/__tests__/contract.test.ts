/**
 * Contract tests: replay REAL backend responses (`backend-samples.json`, captured
 * from routes.py + service.py) through the api client and the pure reducers.
 * If the backend shape drifts again, regenerate the samples and these fail loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { buildSteps, eventText, reduceEvent, statusFromEvent } from '../lib';
import type { EventSlice } from '../lib';
import type { Agent, Approval, HarnessEvent, Message, Run, StreamLine } from '../types';
import { FakeWebSocket } from './fakeSocket';
import samplesJson from './backend-samples.json';

type Samples = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const S = samplesJson as unknown as Samples;

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

/** Answer the bootstrap, then every call with `answer`; remember what was sent. */
function serve(answer: unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/agents/bootstrap')) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      seen.push({
        method: init?.method ?? 'GET',
        url: url.replace(/^.*\/agents/, ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
  return seen;
}

/** The recorded samples predate steps 1a and 1b: the client fills the new run fields with their neutral defaults. */
const NEW_RUN_DEFAULTS = {
  recoveries: 0,
  can_continue: false,
  continued_from: null,
  continued_by: null,
  wait_kind: null,
  wait_until: null,
  wait_since: null,
  wait_attempts: 0,
  wait_detail: null,
  wait_exact: false,
  inbox_count: 0,
  actions_count: 0,
  question: null,
  session_mode: 'fresh',
  session_from: null,
  routine_id: null,
  routine_title: null,
};
const asParsedRun = (run: object): Run => ({ ...NEW_RUN_DEFAULTS, ...run }) as Run;
/** Agents recorded before step 3b have no `grants`: the client reads them as `{}`. */
const asParsedAgent = (agent: object): Agent =>
  ({ grants: {}, description: '', suggestions: [], home_project_id: null, origin: 'manual', version: 0, archived: false, archived_at: null, ...agent }) as unknown as Agent;
/** Projects and providers from before phase 6a: the client reads them as plain projects, with an empty `how`. */
const asParsedProject = (p: object): object => ({ kind: 'project', agent_id: null, ...p });
const asParsedProvider = (p: object): object => ({ how: '', ...p });
/** Messages recorded before step 1c have no `delivery`: the client reads it as null. */
const asParsedMessage = (message: object): Message => ({ delivery: null, routine_id: null, ...message }) as Message;

beforeEach(() => api.resetToken());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api client over real backend responses', () => {
  it('overview, engines and projects', async () => {
    let seen = serve(S['GET /overview']);
    const overview = await api.getOverview();
    expect(overview).toEqual({ ...S['GET /overview'], routines_active: 0, active_runs: S['GET /overview'].active_runs.map(asParsedRun) });
    expect(overview.spend_today[0]).toMatchObject({ agent_id: 'forja', name: 'Forja', spent_usd: 0.5, daily_budget_usd: 2 });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/overview' });

    serve(S['GET /engines']);
    const engines = await api.getEngines();
    expect(engines).toEqual(S['GET /engines'].engines);
    expect(engines.map((e) => Object.keys(e).sort())[0]).toEqual(['available', 'can_act', 'name', 'reason']);

    serve(S['GET /providers']);
    const providers = await api.getProviders();
    expect(providers).toEqual(S['GET /providers'].providers.map(asParsedProvider));
    expect(Object.keys(providers[0]).filter((k) => k !== 'how').sort()).toEqual(
      ['configured', 'default_model', 'id', 'kind', 'label', 'notes', 'reason', 'runtimes'],
    );
    expect(JSON.stringify(providers)).not.toMatch(/https?:\/\/|api[_-]?key=|sk-/i);

    serve(S['GET /projects']);
    await expect(api.listProjects()).resolves.toEqual(S['GET /projects'].projects.map(asParsedProject));
    seen = serve(S['POST /projects']);
    await expect(api.createProject({ name: 'Loja', path: 'C:\\Projetos\\loja' })).resolves.toEqual(asParsedProject(S['POST /projects'].project));
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/projects' });
    serve(S['PATCH /projects/{id}']);
    await expect(api.updateProject('loja', { description: 'x' })).resolves.toEqual(asParsedProject(S['PATCH /projects/{id}'].project));
    seen = serve(S['DELETE /projects/{id}']);
    await expect(api.archiveProject('loja')).resolves.toMatchObject({ archived: true });
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/projects/loja' });
  });

  it('agents (defs), tasks and messages', async () => {
    serve(S['GET /defs']);
    const defs = await api.listAgents();
    expect(defs).toEqual(S['GET /defs'].defs.map(asParsedAgent));
    expect(defs.every((d) => Object.keys(d.grants).length === 0)).toBe(true);
    expect(typeof defs[0].enabled).toBe('boolean');
    expect(Array.isArray(defs[0].project_ids)).toBe(true);
    expect(Object.keys(defs[0])).toEqual(
      expect.arrayContaining(['engine', 'provider', 'model', 'reasoning_effort', 'fallback_engine', 'fallback_provider', 'fallback_model']),
    );
    serve(S['POST /defs']);
    await expect(api.createAgent(defs[0])).resolves.toEqual(asParsedAgent(S['POST /defs'].def));
    serve(S['PATCH /defs/{id}']);
    await expect(api.updateAgent('forja', { color: '#f2a65a' })).resolves.toEqual(asParsedAgent(S['PATCH /defs/{id}'].def));
    serve(S['DELETE /defs/{id}']);
    await expect(api.deleteAgent('forja')).resolves.toBeUndefined();

    serve(S['GET /tasks']);
    const tasks = await api.listTasks();
    expect(tasks).toEqual(S['GET /tasks'].tasks);
    expect(tasks[0].acceptance).toEqual([{ text: 'Reproduzir a falha', done: false }]);
    serve(S['POST /tasks']);
    await expect(api.createTask({ project_id: 'loja', title: 'Corrigir cupom' })).resolves.toEqual(S['POST /tasks'].task);
    serve(S['GET /tasks/{id}']);
    await expect(api.getTask('t')).resolves.toEqual(S['GET /tasks/{id}'].task);
    serve(S['PATCH /tasks/{id}']);
    await expect(api.updateTask('t', { priority: 'high' })).resolves.toEqual(S['PATCH /tasks/{id}'].task);
    serve(S['GET /tasks/{id}/messages']);
    await expect(api.listTaskMessages('t')).resolves.toEqual(S['GET /tasks/{id}/messages'].messages.map(asParsedMessage));

    serve(S['GET /projects/{id}/messages']);
    await expect(api.listMessages('loja')).resolves.toEqual(S['GET /projects/{id}/messages'].messages.map(asParsedMessage));
    const seen = serve(S['GET /projects/{id}/messages?after']);
    await api.listMessages('loja', { after: 'a-message-id', limit: 50 });
    expect(seen[0].url).toBe('/projects/loja/messages?after=a-message-id&limit=50');
  });

  it('sending a message: stored + run, and stored + routing error with detail', async () => {
    serve(S['POST /projects/{id}/messages']);
    const ok = await api.sendMessage('loja', { body: 'oi', agent_id: 'auto' });
    expect(ok.error).toBeNull();
    expect(ok.run?.status).toBeTruthy();
    expect(ok.agent_id).toBe(ok.run?.agent_id);

    serve(S['POST /projects/{id}/messages (agent_not_available)']);
    const failed = await api.sendMessage('loja', { body: 'oi', agent_id: 'ghost' });
    expect(failed.run).toBeNull();
    expect(failed.error).toBe('agent_not_available');
    expect(failed.detail).toBeTruthy();
  });

  it('runs, events, approvals', async () => {
    serve(S['POST /tasks/{id}/run']);
    await expect(api.runTask('t', 'forja')).resolves.toEqual(asParsedRun(S['POST /tasks/{id}/run'].run));
    serve(S['POST /runs']);
    await expect(api.createRun({ agent_id: 'forja', project_id: 'loja', goal: 'g' })).resolves.toEqual(asParsedRun(S['POST /runs'].run));
    serve(S['GET /runs']);
    await expect(api.listRuns()).resolves.toEqual(S['GET /runs'].runs.map(asParsedRun));
    serve(S['GET /runs/{id}']);
    const run = await api.getRun('r');
    expect(run).toEqual(asParsedRun(S['GET /runs/{id}'].run));
    expect(Object.keys(run).sort()).toEqual(
      [
        'agent_id', 'approvals_used', 'cost_usd', 'created_at', 'engine', 'error', 'exit_code', 'finished_at', 'goal', 'id', 'model',
        'project_id', 'provider', 'reasoning_effort', 'requested_by', 'result_summary', 'session_ref', 'started_at', 'status',
        'task_id', 'tokens_in', 'tokens_out', 'recoveries', 'can_continue', 'continued_from', 'continued_by',
        'wait_kind', 'wait_until', 'wait_since', 'wait_attempts', 'wait_detail', 'wait_exact', 'inbox_count', 'actions_count', 'question',
        'session_mode', 'session_from', 'routine_id', 'routine_title',
      ].sort(),
    );
    serve(S['POST /runs/{id}/cancel']);
    await expect(api.cancelRun('r')).resolves.toMatchObject({ status: 'cancelled' });

    const seen = serve(S['GET /runs/{id}/events']);
    const events = await api.listRunEvents('r', 7);
    expect(events).toEqual(S['GET /runs/{id}/events'].events);
    expect(typeof events[0].id).toBe('number');
    expect(seen[0].url).toBe('/runs/r/events?after=7');

    serve(S['GET /approvals']);
    await expect(api.listApprovals()).resolves.toEqual(S['GET /approvals'].approvals);
    const approval = S['GET /approvals'].approvals[0];
    expect(Object.keys(approval)).toEqual(
      expect.arrayContaining(['risk_level', 'risk_reasons', 'command_digest', 'expires_at', 'decided_by', 'decision_note']),
    );
    expect(approval.command_digest).toMatch(/^[0-9a-f]{64}$/);
    const decide = serve(S['POST /approvals/{id}/decide']);
    await expect(api.decideApproval('a', 'approve', { digest: approval.command_digest })).resolves.toMatchObject({ status: 'approved' });
    expect(decide[0].body).toEqual({ decision: 'approve', digest: approval.command_digest });
    const high = serve(S['POST /approvals/{id}/decide']);
    await api.decideApproval('a', 'approve', { digest: 'x', confirmHighRisk: true });
    expect(high[0].body).toEqual({ decision: 'approve', digest: 'x', confirm_high_risk: true });
    const deny = serve(S['POST /approvals/{id}/decide']);
    await api.decideApproval('a', 'deny', { note: 'Não agora' });
    expect(deny[0].body).toEqual({ decision: 'deny', note: 'Não agora' });
  });

  it('rejects approvals that miss a field of approvals v2, like any other unexpected shape', async () => {
    const approval = S['GET /approvals'].approvals[0];
    for (const field of ['risk_level', 'risk_reasons', 'command_digest', 'expires_at', 'decided_by', 'decision_note']) {
      const { [field]: _gone, ...old } = approval;
      serve({ approvals: [old] });
      await expect(api.listApprovals(), field).rejects.toThrow(/Resposta inesperada/);
      serve({ approval: old });
      await expect(api.decideApproval('a', 'approve', { digest: 'x' }), field).rejects.toThrow(/Resposta inesperada/);
    }
    serve({ approvals: [{ ...approval, risk_level: 'extreme' }] });
    await expect(api.listApprovals()).rejects.toThrow(/Resposta inesperada/);
    serve({ ...S['GET /overview'], pending_approvals: [{ ...approval, risk_reasons: 'x' }] });
    await expect(api.getOverview()).rejects.toThrow(/Resposta inesperada/);
    serve({ approvals: [{ ...approval, status: 'expired', decided_by: 'harness', decision_note: null }] });
    await expect(api.listApprovals('expired')).resolves.toHaveLength(1);
  });

  it('stream lines: events are delivered without `type`, everything else is accepted silently', async () => {
    const lines = S['GET /stream (lines captured while the above ran)'] as StreamLine[];
    expect(new Set(lines.map((l) => l.type))).toEqual(new Set(['event', 'run_update', 'message', 'heartbeat']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: 't' }))),
    );
    api.resetToken();
    const got: HarnessEvent[] = [];
    FakeWebSocket.reset();
    const stop = api.openGlobalSocket((e) => got.push(e), { minDelayMs: 5, maxDelayMs: 10 });
    const ws = FakeWebSocket.last;
    ws.open();
    ws.receive({ type: 'ready' });
    for (const l of lines) ws.receive(l);
    stop();
    const expected = lines.filter((l) => l.type === 'event').length;
    expect(got).toHaveLength(expected);
    expect(got.every((e) => typeof e.id === 'number' && !('type' in e))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the run stream ends with an `end` line and the 405/404/422 error bodies have a detail', () => {
    const stream = S['GET /runs/{id}/stream'] as StreamLine[];
    expect(stream[stream.length - 1]).toMatchObject({ type: 'end', status: 'done' });
    expect(S['GET /bootstrap']).toMatchObject({ status: 405 });
    expect(typeof S['error 404'].body.detail).toBe('string');
    expect(typeof S['error 422 harness'].body.detail).toBe('string');
    expect(Array.isArray(S['error 422 validation'].body.detail)).toBe(true);
  });
});

describe('runs with the step 1a fields', () => {
  const run = S['GET /runs/{id}'].run as Record<string, unknown>;
  const withFields = { ...run, recoveries: 2, can_continue: true, continued_from: 'r0', continued_by: 'r9' };

  it('passes the four new fields through untouched when the backend sends them', async () => {
    const parsed = { ...withFields, wait_kind: null, wait_until: null, wait_since: null, wait_attempts: 0, wait_detail: null, wait_exact: false, inbox_count: 0, actions_count: 0, question: null, session_mode: 'fresh', session_from: null, routine_id: null, routine_title: null }; // 1b, 1c, 1d, 3c and continuity defaults
    serve({ run: withFields });
    await expect(api.getRun('r')).resolves.toEqual(parsed);
    serve({ runs: [withFields] });
    await expect(api.listRuns()).resolves.toEqual([parsed]);
    serve({ ...S['GET /overview'], active_runs: [withFields] });
    expect((await api.getOverview()).active_runs).toEqual([parsed]);
  });

  it('defaults runs recorded before step 1a instead of failing the whole screen', async () => {
    serve({ run });
    await expect(api.getRun('r')).resolves.toMatchObject({ recoveries: 0, can_continue: false, continued_from: null, continued_by: null });
    // a partial run still takes the defaults for what is missing and keeps what is there
    serve({ run: { ...run, can_continue: true } });
    await expect(api.getRun('r')).resolves.toMatchObject({ recoveries: 0, can_continue: true, continued_by: null });
  });

  it.each([
    ['recoveries', 'dois'],
    ['recoveries', -1],
    ['recoveries', 1.5],
    ['can_continue', 'sim'],
    ['can_continue', null],
    ['continued_from', 7],
    ['continued_by', false],
  ])('rejects a mistyped %s (%j) like any other unexpected shape', async (field, value) => {
    serve({ run: { ...run, [field]: value } });
    await expect(api.getRun('r')).rejects.toThrow(/Resposta inesperada.*"/);
    serve({ runs: [{ ...run, [field]: value }] });
    await expect(api.listRuns()).rejects.toThrow(/Resposta inesperada/);
    serve({ ...S['GET /overview'], active_runs: [{ ...run, [field]: value }] });
    await expect(api.getOverview()).rejects.toThrow(/Resposta inesperada/);
  });

  it('continueRun posts without a body to /runs/{id}/continue and returns the new run', async () => {
    const seen = serve({ run: { ...withFields, id: 'r9', continued_from: 'r', continued_by: null, can_continue: false } });
    await expect(api.continueRun('r')).resolves.toMatchObject({ id: 'r9', continued_from: 'r' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/runs/r/continue' });
    expect(seen[0].body).toBeUndefined();
  });
});

describe('runs with the step 1b (parking) fields', () => {
  const run = S['GET /runs/{id}'].run as Record<string, unknown>;
  const parked = {
    ...run,
    status: 'parked',
    wait_kind: 'plan_limit',
    wait_until: '2026-01-01T14:30:00Z',
    wait_since: '2026-01-01T10:00:00Z',
    wait_attempts: 2,
    wait_detail: 'Limite semanal do plano.',
    wait_exact: true,
  };

  it('passes the four parking fields through untouched when the backend sends them (and `auth` has no wait_until)', async () => {
    serve({ run: parked });
    await expect(api.getRun('r')).resolves.toMatchObject(parked);
    serve({ runs: [parked] });
    await expect(api.listRuns()).resolves.toMatchObject([parked]);
    serve({ ...S['GET /overview'], active_runs: [parked] });
    expect((await api.getOverview()).active_runs).toMatchObject([parked]);
    const auth = { ...parked, wait_kind: 'auth', wait_until: null };
    serve({ run: auth });
    await expect(api.getRun('r')).resolves.toMatchObject({ status: 'parked', wait_kind: 'auth', wait_until: null, wait_attempts: 2 });
  });

  it('defaults the parking fields on runs that lack them, keeping the ones that are there', async () => {
    serve({ run });
    await expect(api.getRun('r')).resolves.toMatchObject({
      wait_kind: null, wait_until: null, wait_since: null, wait_attempts: 0, wait_detail: null, wait_exact: false,
    });
    serve({ run: { ...run, wait_detail: 'Falta a chave.', wait_exact: true } });
    await expect(api.getRun('r')).resolves.toMatchObject({ wait_detail: 'Falta a chave.', wait_exact: true });
    serve({ run: { ...run, wait_kind: 'outage' } });
    await expect(api.getRun('r')).resolves.toMatchObject({ wait_kind: 'outage', wait_until: null, wait_attempts: 0 });
  });

  it.each([
    ['wait_kind', 'clima'],
    ['wait_kind', 3],
    ['wait_until', 12],
    ['wait_since', false],
    ['wait_attempts', 'duas'],
    ['wait_attempts', -1],
    ['wait_attempts', 1.5],
    ['wait_attempts', null],
    ['wait_detail', 7],
    ['wait_exact', 'sim'],
    ['wait_exact', null],
  ])('rejects a mistyped %s (%j) like any other unexpected shape', async (field, value) => {
    serve({ run: { ...run, [field]: value } });
    await expect(api.getRun('r')).rejects.toThrow(/Resposta inesperada.*"/);
    serve({ runs: [{ ...run, [field]: value }] });
    await expect(api.listRuns()).rejects.toThrow(/Resposta inesperada/);
    serve({ ...S['GET /overview'], active_runs: [{ ...run, [field]: value }] });
    await expect(api.getOverview()).rejects.toThrow(/Resposta inesperada/);
  });

  it('wakeRun posts without a body to /runs/{id}/wake and returns the run', async () => {
    const seen = serve({ run: { ...run, status: 'queued' } });
    await expect(api.wakeRun('r')).resolves.toMatchObject({ status: 'queued', wait_kind: null });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/runs/r/wake' });
    expect(seen[0].body).toBeUndefined();
  });

  it('wakeRun keeps the code of a 409 on the ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/agents/bootstrap')
          ? new Response(JSON.stringify({ token: 't' }), { status: 200 })
          : new Response(JSON.stringify({ detail: 'not parked', code: 'not_parked' }), { status: 409 }),
      ),
    );
    await expect(api.wakeRun('r')).rejects.toMatchObject({ status: 409, code: 'not_parked' });
  });
});

describe('reducers over the real event sequence', () => {
  const run = S['GET /runs/{id}'].run as Run;
  const events = S['GET /runs/{id}/events (after approval)'].events as HarnessEvent[];

  it('folds statuses, the approval request and its result into runs/approvals', () => {
    let slice: EventSlice = { runs: { [run.id]: { ...run, status: 'queued', finished_at: null } }, approvals: {}, eventsByRun: {} };
    let refreshes = 0;
    for (const ev of events) {
      const { patch, refresh } = reduceEvent(slice, ev);
      slice = { ...slice, ...patch };
      if (refresh) refreshes += 1;
      if (ev.kind === 'approval_request') {
        const a = slice.approvals[ev.payload.approval_id as string] as Approval;
        expect(a).toMatchObject({ status: 'pending', agent_id: run.agent_id, project_id: run.project_id, run_id: run.id });
        expect(a.command).toBe(S['GET /approvals'].approvals[0].command);
      }
    }
    expect(refreshes).toBe(0);
    const approvalId = S['GET /approvals'].approvals[0].id as string;
    expect(slice.approvals[approvalId].status).toBe('approved');
    expect(slice.runs[run.id].status).toBe('done');
    expect(slice.eventsByRun[run.id].map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('reads the status of every status event and a readable text for every step, command and message', () => {
    const statuses = events.filter((e) => e.kind === 'status').map((e) => statusFromEvent(e));
    expect(statuses.every((s) => s !== null)).toBe(true);
    for (const ev of events.filter((e) => ['step', 'command', 'message', 'approval_request', 'error'].includes(e.kind))) {
      expect(eventText(ev), `${ev.kind} ${JSON.stringify(ev.payload)}`).not.toBe('');
    }
    const steps = buildSteps(events);
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['step', 'command', 'message', 'approval']));
    // the raw approval-request fence never shows up as a step
    expect(steps.some((s) => s.text.includes('approval-request'))).toBe(false);
  });
});

describe('step 3b: tools and grants as the contract words them', () => {
  const ev = (id: number, payload: Record<string, unknown>): HarnessEvent => ({ id, run_id: 'r1', ts: `2026-01-01T10:00:0${id}Z`, kind: 'step', payload });

  it('GET /tools, GET and PUT /defs/{id}/grants, and the `grants` of an agent', async () => {
    const catalogue = {
      groups: [
        {
          id: 'memory',
          label: 'Memória pessoal',
          description: 'O que a Seraphine guarda sobre você.',
          default: 'none',
          sensitive: true,
          levels: ['none', 'read'],
          tools: [{ name: 'memory_search', label: 'Buscar na memória', description: 'Procura.', read_only: true, level: 'read' }],
        },
      ],
    };
    let seen = serve(catalogue);
    await expect(api.getAgentTools()).resolves.toEqual(catalogue.groups);
    // an older sample (step 3b) has neither `level` nor `levels`: they are derived
    const old = { groups: [{ ...catalogue.groups[0], levels: undefined, tools: [{ ...catalogue.groups[0].tools[0], level: undefined }] }] };
    serve(old);
    await expect(api.getAgentTools()).resolves.toEqual(catalogue.groups);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/tools' });

    const grants = { notes: 'read', wiki: 'read', memory: 'none' };
    seen = serve({ grants });
    await expect(api.getAgentGrants('forja')).resolves.toEqual(grants);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/defs/forja/grants' });
    seen = serve({ grants: { ...grants, memory: 'read' } });
    await expect(api.setAgentGrants('forja', { memory: 'read' })).resolves.toEqual({ ...grants, memory: 'read' });
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/defs/forja/grants', body: { grants: { memory: 'read' } } });

    serve({ defs: [{ ...S['GET /defs'].defs[0], grants }] });
    await expect(api.listAgents()).resolves.toMatchObject([{ id: 'forja', grants }]);
  });

  it('a tool call is one line from `started` to `completed` (same call_id), and the unfinished one is told apart', () => {
    const base = { type: 'seraphine_tool', call_id: 'c1', tool: 'wiki_search', group: 'wiki', label: 'Buscou na wiki: contrato', read_only: true };
    const done = buildSteps([
      ev(1, { ...base, phase: 'started' }),
      ev(2, { ...base, phase: 'completed', ok: true, summary: '2 páginas' }),
    ]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ kind: 'step', state: 'done', text: 'Buscou na wiki: contrato', group: 'wiki', summary: '2 páginas' });
    expect(done[0].failed).toBeUndefined();

    const failed = buildSteps([ev(1, { ...base, phase: 'started' }), ev(2, { ...base, phase: 'completed', ok: false, summary: '', error: 'Demorou demais.' })]);
    expect(failed[0]).toMatchObject({ state: 'done', failed: true, error: 'Demorou demais.' });

    expect(buildSteps([ev(1, { ...base, phase: 'started' })], { runEnded: true })[0].state).toBe('unfinished');
    expect(buildSteps([ev(1, { ...base, phase: 'started' })])[0].state).toBe('running');
  });

  it('the denied-access and bridge-unavailable notes are system lines carrying their own text', () => {
    const steps = buildSteps([
      ev(1, { type: 'note', reason: 'tool_denied', tool: 'memory_search', group: 'memory', text: 'Sem acesso à memória.' }),
      ev(2, { type: 'note', reason: 'bridge_unavailable', text: 'As ferramentas não subiram.' }),
    ]);
    expect(steps.map((s) => [s.kind, s.reason, s.text])).toEqual([
      ['system', 'tool_denied', 'Sem acesso à memória.'],
      ['system', 'bridge_unavailable', 'As ferramentas não subiram.'],
    ]);
  });
});

describe('step 3c: writes, receipts, the question and the bridge as the contract words them', () => {
  const ev = (id: number, payload: Record<string, unknown>): HarnessEvent => ({ id, run_id: 'r1', ts: `2026-01-01T10:00:0${id}Z`, kind: 'step', payload });
  const action = {
    id: 'act1',
    run_id: 'r1',
    agent_id: 'forja',
    project_id: 'loja',
    tool: 'create_note',
    group: 'notes',
    label: 'Criou a nota «Compras»',
    created_at: '2026-01-01T10:00:00Z',
    undo_until: '2026-01-01T10:05:00Z',
    undone_at: null,
    can_undo: true,
  };

  it('GET /tools with the level of every tool and the levels of every group', async () => {
    const groups = [
      {
        id: 'notes',
        label: 'Notas',
        description: 'As notas.',
        default: 'read',
        sensitive: false,
        levels: ['none', 'read', 'write'],
        tools: [
          { name: 'list_notes', label: 'Ver as notas', description: 'Lista.', read_only: true, level: 'read' },
          { name: 'create_note', label: 'Criar uma nota', description: 'Cria.', read_only: false, level: 'write' },
        ],
      },
    ];
    serve({ groups });
    const [notes] = await api.getAgentTools();
    expect(notes.levels).toEqual(['none', 'read', 'write']);
    expect(notes.tools.map((t) => [t.level, t.read_only])).toEqual([['read', true], ['write', false]]);
  });

  it('GET /actions?run_id= and POST /actions/{id}/undo', async () => {
    let seen = serve({ actions: [action] });
    await expect(api.listRunActions('r1')).resolves.toEqual([action]);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/actions?run_id=r1' });
    seen = serve({ action: { ...action, undone_at: '2026-01-01T10:02:00Z', can_undo: false } });
    await expect(api.undoAction('act1')).resolves.toMatchObject({ id: 'act1', undone_at: '2026-01-01T10:02:00Z', can_undo: false });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/actions/act1/undo' });
    expect(seen[0].body).toBeUndefined();
  });

  it('GET and POST on the bridge', async () => {
    const engines = [
      { engine: 'codex', label: 'Codex', state: 'ok', last_ok_at: '2026-01-01T10:00:00Z', last_failure_at: null, last_failure: null },
      { engine: 'claude_code', label: 'Claude Code', state: 'unknown', last_ok_at: null, last_failure_at: null, last_failure: null },
    ];
    let seen = serve({ engines });
    await expect(api.getBridgeStatus()).resolves.toEqual(engines);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/bridge/status' });
    seen = serve({ ok: true, detail: 'A ferramenta respondeu.', took_ms: 3200 });
    await expect(api.testBridge('codex')).resolves.toEqual({ ok: true, detail: 'A ferramenta respondeu.', took_ms: 3200 });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/bridge/test', body: { engine: 'codex' } });
  });

  it('a run waiting for an answer carries its question', async () => {
    const run = S['GET /runs/{id}'].run as Record<string, unknown>;
    const question = { text: 'Posso apagar?', options: ['Pode', 'Não'], asked_at: '2026-01-01T10:00:00Z' };
    serve({ run: { ...run, status: 'parked', wait_kind: 'owner_input', wait_until: null, question } });
    await expect(api.getRun('r')).resolves.toMatchObject({ status: 'parked', wait_kind: 'owner_input', wait_until: null, question });
  });

  it('a write completes with its receipt and the note of an undo closes it', () => {
    const base = { type: 'seraphine_tool', call_id: 'c1', tool: 'create_note', group: 'notes', label: 'Criou a nota «Compras»' };
    const steps = buildSteps([
      ev(1, { ...base, phase: 'started', read_only: false }),
      ev(2, { ...base, phase: 'completed', read_only: false, ok: true, summary: '', action_id: 'act1', undo_until: '2026-01-01T10:05:00Z' }),
      ev(3, { type: 'note', reason: 'action_undone', action_id: 'act1', text: 'Você desfez: criou a nota «Compras».' }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ receipt: true, actionId: 'act1', undoUntil: '2026-01-01T10:05:00Z', undone: true, text: 'Criou a nota «Compras»' });
    expect(steps[1]).toMatchObject({ kind: 'system', reason: 'action_undone', text: 'Você desfez: criou a nota «Compras».' });
  });
});
