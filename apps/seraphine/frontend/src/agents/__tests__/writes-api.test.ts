/** Step 3c (wire): the catalogue's levels, the actions and their routes, the run's question, the bridge routes and the `action_update` frame. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  TOKEN_HEADER,
  getAgentTools,
  getBridgeStatus,
  getRun,
  listRunActions,
  listRuns,
  openGlobalSocket,
  resetToken,
  testBridge,
  undoAction,
} from '../api';
import { FakeWebSocket } from './fakeSocket';
import { makeAction, makeBridgeStatus, makeQuestion, makeRun, makeToolGroups, makeWriteToolGroups } from './fixtures';

interface Seen {
  method: string;
  url: string;
  body: unknown;
  token: string | undefined;
}

/** Answer the bootstrap, then every call with `answer` (and `status`); remember what was sent. */
function serve(answer: unknown, status = 200): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/agents/bootstrap')) return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
      seen.push({
        method: init?.method ?? 'GET',
        url: url.replace(/^.*\/agents/, ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        token: (init?.headers as Record<string, string> | undefined)?.[TOKEN_HEADER],
      });
      return new Response(JSON.stringify(answer), { status });
    }),
  );
  return seen;
}

beforeEach(() => resetToken());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the catalogue with levels', () => {
  it('parses `level` per tool and `levels` per group', async () => {
    serve({ groups: makeWriteToolGroups() });
    const groups = await getAgentTools();
    expect(groups).toEqual(makeWriteToolGroups());
    const notes = groups[0];
    expect(notes.levels).toEqual(['none', 'read', 'write']);
    expect(notes.tools.map((t) => [t.name, t.level, t.read_only])).toEqual([
      ['search_notes', 'read', true],
      ['list_notes', 'read', true],
      ['create_note', 'write', false],
      ['update_note', 'write', false],
    ]);
    expect(groups.map((g) => [g.id, g.default])).toEqual([
      ['notes', 'read'],
      ['wiki', 'read'],
      ['memory', 'none'],
      ['project_tasks', 'read'],
      ['reminders', 'none'],
    ]);
  });

  it('an older answer without `levels` and `level` still parses: levels are none and read, the level follows read_only', async () => {
    const old = JSON.parse(JSON.stringify(makeToolGroups()));
    for (const g of old) {
      delete g.levels;
      for (const t of g.tools) delete t.level;
    }
    old[0].tools.push({ name: 'x', label: 'Outra', description: 'x', read_only: false });
    serve({ groups: old });
    const groups = await getAgentTools();
    expect(groups.every((g) => g.levels.join() === 'none,read')).toBe(true);
    expect(groups[0].tools.map((t) => t.level)).toEqual(['read', 'read', 'write']);
  });

  const broken: [string, (g: Record<string, any>[]) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['levels that is not a list', (g) => (g[0].levels = 'write')],
    ['an empty levels list', (g) => (g[0].levels = [])],
    ['a level that is not none, read or write', (g) => (g[0].levels = ['none', 'admin'])],
    ['a tool level that is not read or write', (g) => (g[0].tools[0].level = 'none')],
  ];
  it.each(broken)('is strict about what is there: %s', async (_name, damage) => {
    const groups = JSON.parse(JSON.stringify(makeWriteToolGroups()));
    damage(groups);
    serve({ groups });
    const err = await getAgentTools().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toMatch(/Resposta inesperada do servidor em GET \/agents\/tools/);
  });
});

describe('the question of a run', () => {
  const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...makeRun(), ...over });

  it('defaults to null when the backend does not send it, and keeps it when it does', async () => {
    const { question: _q, ...old } = wire();
    serve({ run: old });
    await expect(getRun('r1')).resolves.toMatchObject({ question: null });
    serve({ runs: [wire({ status: 'parked', wait_kind: 'owner_input', question: makeQuestion() })] });
    const [run] = await listRuns();
    expect(run).toMatchObject({ wait_kind: 'owner_input', question: makeQuestion() });
    serve({ run: wire({ question: null }) });
    await expect(getRun('r1')).resolves.toMatchObject({ question: null });
  });

  it('takes a question without options (the agent wants a free answer)', async () => {
    serve({ run: wire({ question: makeQuestion({ options: [] }) }) });
    await expect(getRun('r1')).resolves.toMatchObject({ question: { options: [] } });
  });

  it.each([
    ['a text instead of an object', 'Posso?'],
    ['an array', ['Posso?']],
    ['a text that is not text', { text: 7, options: [], asked_at: 'x' }],
    ['options that is not a list', { text: 'a', options: 'Pode', asked_at: 'x' }],
    ['an option that is not text', { text: 'a', options: ['Pode', 3], asked_at: 'x' }],
    ['no options', { text: 'a', asked_at: 'x' }],
    ['no asked_at', { text: 'a', options: [] }],
  ])('rejects %s like any other unexpected shape', async (_name, question) => {
    serve({ run: wire({ question }) });
    await expect(getRun('r1')).rejects.toThrow(/Resposta inesperada.*question/);
    serve({ runs: [wire({ question })] });
    await expect(listRuns()).rejects.toThrow(/Resposta inesperada/);
  });

  it('accepts owner_input as a wait kind and still rejects an unknown one', async () => {
    serve({ run: wire({ status: 'parked', wait_kind: 'owner_input', wait_until: null, question: makeQuestion() }) });
    await expect(getRun('r1')).resolves.toMatchObject({ wait_kind: 'owner_input', wait_until: null });
    serve({ run: wire({ wait_kind: 'clima' }) });
    await expect(getRun('r1')).rejects.toThrow(/Resposta inesperada/);
  });
});

describe('actions and undo', () => {
  it('GET /actions?run_id= reads {actions: [...]} and sends the token', async () => {
    const seen = serve({ actions: [makeAction(), makeAction({ id: 'act2', undone_at: '2026-01-01T10:02:00Z', can_undo: false })] });
    const list = await listRunActions('r 1');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/actions?run_id=r+1', token: 'tok' });
    expect(list.map((a) => [a.id, a.can_undo, a.undone_at])).toEqual([['act1', true, null], ['act2', false, '2026-01-01T10:02:00Z']]);
  });

  it('POST /actions/{id}/undo has no body and answers {action}', async () => {
    const seen = serve({ action: makeAction({ undone_at: '2026-01-01T10:02:00Z', can_undo: false }) });
    await expect(undoAction('a/1')).resolves.toMatchObject({ undone_at: '2026-01-01T10:02:00Z', can_undo: false });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/actions/a%2F1/undo', token: 'tok' });
    expect(seen[0].body).toBeUndefined();
  });

  it.each(['undo_expired', 'already_undone', 'undo_conflict'])('keeps the code %s of a 409 on the error', async (code) => {
    serve({ detail: 'x', code }, 409);
    const err = await undoAction('act1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code });
  });

  it('keeps the 404 of an unknown action', async () => {
    serve({ detail: 'ação não encontrada' }, 404);
    await expect(undoAction('nope')).rejects.toMatchObject({ status: 404 });
  });

  const damaged: [string, (a: Record<string, unknown>) => void][] = [
    ['an action without id', (a) => delete a.id],
    ['an action without label', (a) => delete a.label],
    ['an action without undo_until', (a) => delete a.undo_until],
    ['an action without run_id', (a) => delete a.run_id],
    ['undone_at as a number', (a) => (a.undone_at = 3)],
    ['an action without undone_at', (a) => delete a.undone_at],
    ['can_undo as text', (a) => (a.can_undo = 'sim')],
  ];
  it.each(damaged)('is strict: %s is a contract break', async (_name, damage) => {
    const action = makeAction() as unknown as Record<string, unknown>;
    damage(action);
    serve({ actions: [action] });
    await expect(listRunActions('r1')).rejects.toThrow(/Resposta inesperada do servidor em GET \/agents\/actions/);
    serve({ action });
    await expect(undoAction('act1')).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects an answer that is not {"actions": [...]}', async () => {
    serve({ items: [] });
    await expect(listRunActions('r1')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('the bridge routes', () => {
  it('GET /bridge/status parses every engine, with and without times', async () => {
    const engines = [
      makeBridgeStatus(),
      makeBridgeStatus({ engine: 'claude_code', label: 'Claude Code', state: 'unknown', last_ok_at: null }),
      makeBridgeStatus({ state: 'failed', last_failure_at: '2026-01-01T11:00:00Z', last_failure: 'O motor não respondeu.' }),
    ];
    const seen = serve({ engines });
    await expect(getBridgeStatus()).resolves.toEqual(engines);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/bridge/status', token: 'tok' });
  });

  it.each([
    ['a state outside ok, failed and unknown', { state: 'broken' }],
    ['a label that is not text', { label: 3 }],
    ['last_ok_at as a number', { last_ok_at: 5 }],
    ['last_failure as a list', { last_failure: ['x'] }],
  ])('GET /bridge/status is strict: %s', async (_name, over) => {
    serve({ engines: [makeBridgeStatus(over as never)] });
    await expect(getBridgeStatus()).rejects.toBeInstanceOf(ApiError);
  });

  it('POST /bridge/test sends the engine and reads {ok, detail, took_ms}', async () => {
    const seen = serve({ ok: false, detail: 'O motor não chamou a ferramenta.', took_ms: 61000 });
    await expect(testBridge('claude_code')).resolves.toEqual({ ok: false, detail: 'O motor não chamou a ferramenta.', took_ms: 61000 });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/bridge/test', body: { engine: 'claude_code' }, token: 'tok' });
  });

  it('POST /bridge/test is strict about its answer and keeps test_running on the 409', async () => {
    serve({ ok: 'sim', detail: '', took_ms: 1 });
    await expect(testBridge('codex')).rejects.toBeInstanceOf(ApiError);
    serve({ ok: true, took_ms: 1 });
    await expect(testBridge('codex')).rejects.toBeInstanceOf(ApiError);
    serve({ ok: true, detail: '', took_ms: 'rápido' });
    await expect(testBridge('codex')).rejects.toBeInstanceOf(ApiError);
    serve({ detail: 'x', code: 'test_running' }, 409);
    await expect(testBridge('codex')).rejects.toMatchObject({ status: 409, code: 'test_running' });
  });
});

describe('the action_update frame', () => {
  async function flush(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  }

  it('reaches onActionUpdate with the action, and a malformed one is dropped with a single warning', async () => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tok' }), { status: 200 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onActionUpdate = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onActionUpdate });
    const ws = FakeWebSocket.last;
    ws.open();
    await flush();
    ws.receive({ type: 'ready' });

    const undone = makeAction({ undone_at: '2026-01-01T10:02:00Z', can_undo: false });
    ws.receive({ type: 'action_update', boot: 'b', seq: 2, action: undone });
    expect(onActionUpdate).toHaveBeenCalledWith(undone);
    expect(warn).not.toHaveBeenCalled();

    ws.receive({ type: 'action_update', action: { id: 'act1' } });
    ws.receive({ type: 'action_update' });
    expect(onActionUpdate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });
});
