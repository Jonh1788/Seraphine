/** Step 1d: sequence tracking in the live channel (`seq` + `boot`) and the new run field `actions_count`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { openGlobalSocket, resetToken } from '../api';
import type { HarnessEvent } from '../types';
import { FakeWebSocket } from './fakeSocket';
import samplesJson from './backend-samples.json';

const ev = (id: number): HarnessEvent => ({
  id,
  run_id: 'r1',
  ts: '2026-01-01T10:00:00Z',
  kind: 'step',
  payload: { type: 'reasoning', text: `s${id}` },
});
const evFrame = (id: number) => ({ type: 'event', ...ev(id) });

/** Let the bootstrap promise chain settle (fake timers do not advance microtasks). */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

async function openAndAuth(): Promise<FakeWebSocket> {
  const ws = FakeWebSocket.last;
  ws.open();
  await flush();
  return ws;
}

describe('sequence tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    resetToken();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tk1' }), { status: 200 })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function connect(opts: Parameters<typeof openGlobalSocket>[1] = {}, onEvent: (e: HarnessEvent) => void = () => undefined) {
    const stop = openGlobalSocket(onEvent, opts);
    const ws = await openAndAuth();
    return { stop, ws };
  }

  it('delivers frames that carry seq and boot, and the event handed on keeps neither', async () => {
    const got: HarnessEvent[] = [];
    const { stop, ws } = await connect({}, (e) => got.push(e));
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 });
    ws.receive({ ...evFrame(1), boot: 'b1', seq: 2 });
    expect(got).toEqual([ev(1)]);
    expect('seq' in got[0] || 'boot' in got[0]).toBe(false);
    stop();
  });

  it('reports nothing while seq grows by one, heartbeats and pongs included', async () => {
    const onGap = vi.fn();
    const onBootChange = vi.fn();
    const { stop, ws } = await connect({ onGap, onBootChange });
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 });
    ws.receive({ type: 'heartbeat', ts: 'x', boot: 'b1', seq: 2 });
    ws.receive({ type: 'pong', boot: 'b1', seq: 3 });
    ws.receive({ ...evFrame(1), boot: 'b1', seq: 4 });
    expect(onGap).not.toHaveBeenCalled();
    expect(onBootChange).not.toHaveBeenCalled();
    stop();
  });

  it('reports a gap once, keeps delivering frames, and does not report again for the frames that follow', async () => {
    const onGap = vi.fn();
    const got: HarnessEvent[] = [];
    const { stop, ws } = await connect({ onGap }, (e) => got.push(e));
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 });
    ws.receive({ ...evFrame(1), boot: 'b1', seq: 2 });
    ws.receive({ ...evFrame(2), boot: 'b1', seq: 5 }); // 3 and 4 were dropped
    expect(onGap).toHaveBeenCalledTimes(1);
    expect(got.map((e) => e.id)).toEqual([1, 2]); // the frame after the hole is still processed
    ws.receive({ ...evFrame(3), boot: 'b1', seq: 6 });
    ws.receive({ type: 'heartbeat', ts: 'x', boot: 'b1', seq: 7 });
    expect(onGap).toHaveBeenCalledTimes(1);
    expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
    stop();
  });

  it('a new connection starts counting again from its own ready, with no gap', async () => {
    const onGap = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onGap });
    let ws = await openAndAuth();
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 });
    ws.receive({ type: 'heartbeat', ts: 'x', boot: 'b1', seq: 2 });
    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    ws = await openAndAuth();
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 });
    ws.receive({ type: 'heartbeat', ts: 'x', boot: 'b1', seq: 2 });
    expect(onGap).not.toHaveBeenCalled();
    stop();
  });

  it('reports a changed boot when the new connection says it (the first boot is never a change)', async () => {
    const onBootChange = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onBootChange });
    let ws = await openAndAuth();
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 });
    expect(onBootChange).not.toHaveBeenCalled();
    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    ws = await openAndAuth();
    ws.receive({ type: 'ready', boot: 'b1', seq: 1 }); // same process
    expect(onBootChange).not.toHaveBeenCalled();
    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    ws = await openAndAuth();
    ws.receive({ type: 'ready', boot: 'b2', seq: 1 }); // the backend restarted
    expect(onBootChange).toHaveBeenCalledTimes(1);
    ws.receive({ type: 'heartbeat', ts: 'x', boot: 'b2', seq: 2 });
    expect(onBootChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('an older backend (no seq, no boot) triggers nothing and everything is still delivered', async () => {
    const onGap = vi.fn();
    const onBootChange = vi.fn();
    const got: HarnessEvent[] = [];
    const stop = openGlobalSocket((e) => got.push(e), { onGap, onBootChange });
    let ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    ws.receive(evFrame(1));
    ws.receive({ type: 'heartbeat', ts: 'x' });
    ws.receive(evFrame(2));
    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    ws.receive(evFrame(3));
    expect(onGap).not.toHaveBeenCalled();
    expect(onBootChange).not.toHaveBeenCalled();
    expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
    stop();
  });

  it('ignores a seq or boot of the wrong type instead of reporting', async () => {
    const onGap = vi.fn();
    const onBootChange = vi.fn();
    const { stop, ws } = await connect({ onGap, onBootChange });
    ws.receive({ type: 'ready', boot: 7, seq: '1' });
    ws.receive({ type: 'heartbeat', ts: 'x', boot: null, seq: 2.5 });
    ws.receive({ type: 'heartbeat', ts: 'x', boot: 'b1', seq: 9 });
    expect(onGap).not.toHaveBeenCalled();
    expect(onBootChange).not.toHaveBeenCalled();
    stop();
  });
});

// ---------- actions_count ----------

type Samples = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (samplesJson as unknown as Samples)['GET /runs/{id}'].run as Record<string, unknown>;
const overview = (samplesJson as unknown as Samples)['GET /overview'];

function serve(answer: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/agents/bootstrap')
        ? new Response(JSON.stringify({ token: 't' }), { status: 200 })
        : new Response(JSON.stringify(answer), { status: 200 }),
    ),
  );
}

describe('runs with the step 1d field (actions_count)', () => {
  beforeEach(() => api.resetToken());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes actions_count through and defaults it to 0 on runs that lack it', async () => {
    serve({ run: { ...run, actions_count: 12 } });
    await expect(api.getRun('r')).resolves.toMatchObject({ actions_count: 12 });
    serve({ runs: [{ ...run, actions_count: 0 }] });
    await expect(api.listRuns()).resolves.toMatchObject([{ actions_count: 0 }]);
    serve({ run });
    await expect(api.getRun('r')).resolves.toMatchObject({ actions_count: 0 });
  });

  it.each([
    ['actions_count', 'doze'],
    ['actions_count', -1],
    ['actions_count', 1.5],
    ['actions_count', null],
  ])('rejects a mistyped %s (%j) like any other unexpected shape', async (field, value) => {
    serve({ run: { ...run, [field]: value } });
    await expect(api.getRun('r')).rejects.toThrow(/Resposta inesperada.*"actions_count"/);
    serve({ runs: [{ ...run, [field]: value }] });
    await expect(api.listRuns()).rejects.toThrow(/Resposta inesperada/);
    serve({ ...overview, active_runs: [{ ...run, [field]: value }] });
    await expect(api.getOverview()).rejects.toThrow(/Resposta inesperada/);
  });

  it('a run that failed at a limit keeps its error code and can_continue', async () => {
    serve({ run: { ...run, status: 'failed', error: 'stuck_loop', can_continue: true, actions_count: 31 } });
    await expect(api.getRun('r')).resolves.toMatchObject({ status: 'failed', error: 'stuck_loop', can_continue: true, actions_count: 31 });
  });

  it('a run_update frame carries actions_count to the handler, and a mistyped one is dropped', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    FakeWebSocket.reset();
    resetToken();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tk1' }), { status: 200 })));
    const onRunUpdate = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onRunUpdate });
    const ws = await openAndAuth();
    ws.receive({ type: 'ready', boot: 'b', seq: 1 });
    ws.receive({ type: 'run_update', boot: 'b', seq: 2, run: { id: 'r1', project_id: 'p1', status: 'running', actions_count: 7 } });
    expect(onRunUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', actions_count: 7 }));
    ws.receive({ type: 'run_update', boot: 'b', seq: 3, run: { id: 'r1', project_id: 'p1', status: 'running', actions_count: 'sete' } });
    expect(onRunUpdate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
    vi.useRealTimers();
  });
});
