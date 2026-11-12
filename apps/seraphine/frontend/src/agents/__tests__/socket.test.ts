import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openGlobalSocket, resetToken } from '../api';
import type { HarnessEvent } from '../types';
import { FakeWebSocket } from './fakeSocket';

const ev = (id: number): HarnessEvent => ({
  id,
  run_id: 'r1',
  ts: '2026-01-01T10:00:00Z',
  kind: 'step',
  payload: { type: 'reasoning', text: `s${id}` },
});
const evFrame = (id: number) => ({ type: 'event', ...ev(id) });

let bootstraps = 0;
let tokenValue = 'tk1';

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

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  resetToken();
  bootstraps = 0;
  tokenValue = 'tk1';
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      bootstraps += 1;
      return new Response(JSON.stringify({ token: tokenValue }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openGlobalSocket', () => {
  it('connects to /agents/ws on the page host and sends the auth frame on open (token not in the URL)', async () => {
    const stop = openGlobalSocket(() => undefined);
    const ws = await openAndAuth();
    expect(ws.url).toMatch(/^wss?:\/\/.+\/agents\/ws$/);
    expect(ws.url).not.toContain('tk1');
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'auth', token: 'tk1' }]);
    stop();
  });

  it('is connected only after the ready frame, then dispatches events without `type`', async () => {
    const got: HarnessEvent[] = [];
    const status: boolean[] = [];
    const stop = openGlobalSocket((e) => got.push(e), { onStatus: (c) => status.push(c) });
    const ws = await openAndAuth();
    expect(status).toEqual([]);
    ws.receive({ type: 'ready' });
    expect(status).toEqual([true]);
    ws.receive(evFrame(1));
    expect(got).toEqual([ev(1)]);
    expect('type' in got[0]).toBe(false);
    stop();
  });

  it('accepts heartbeat/pong/message/run_update silently and warns once about the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const got: HarnessEvent[] = [];
    const stop = openGlobalSocket((e) => got.push(e));
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    ws.receive({ type: 'heartbeat', ts: 'x' });
    ws.receive({ type: 'pong' });
    ws.receive({ type: 'message', message: { id: 'm', project_id: 'p1' } });
    ws.receive({ type: 'run_update', run: { id: 'r', project_id: 'p1', status: 'done' } });
    ws.receive('not json');
    expect(warn).not.toHaveBeenCalled();
    ws.receive({ type: 'event', ...ev(2), id: '2' }); // string id: outside the contract
    ws.receive({ type: 'mystery' });
    ws.receive(ev(3)); // no type
    expect(warn).toHaveBeenCalledTimes(1);
    expect(got).toEqual([]);
    stop();
  });

  it('reconnects with exponential backoff after a close and resets the delay after ready', async () => {
    const status: boolean[] = [];
    const stop = openGlobalSocket(() => undefined, { onStatus: (c) => status.push(c) });
    let ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    ws.serverClose(1006);
    expect(status).toEqual([true, false]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); // 1s
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.last.serverClose(1006); // never became ready: next wait is 2s
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.last.serverClose(1006); // 4s
    vi.advanceTimersByTime(4000);
    expect(FakeWebSocket.instances).toHaveLength(4);

    ws = await openAndAuth();
    ws.receive({ type: 'ready' }); // resets to 1s
    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(5);
    stop();
  });

  it('caps the backoff at 15s', async () => {
    const stop = openGlobalSocket(() => undefined);
    for (let i = 0; i < 7; i += 1) {
      FakeWebSocket.last.serverClose(1006);
      vi.advanceTimersByTime(15_000);
    }
    const before = FakeWebSocket.instances.length;
    FakeWebSocket.last.serverClose(1006);
    vi.advanceTimersByTime(14_999);
    expect(FakeWebSocket.instances).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
    stop();
  });

  it('close 4401 resets the token and reconnects at once; the second 4401 falls back to backoff', async () => {
    const stop = openGlobalSocket(() => undefined);
    let ws = await openAndAuth();
    expect(bootstraps).toBe(1);
    tokenValue = 'tk2';
    ws.serverClose(4401);
    expect(FakeWebSocket.instances).toHaveLength(2); // immediate retry
    ws = await openAndAuth();
    expect(bootstraps).toBe(2);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'auth', token: 'tk2' });

    ws.serverClose(4401); // still rejected: normal backoff
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    stop();
  });

  it('close 4404 reports disabled and never reconnects', async () => {
    const onDisabled = vi.fn();
    openGlobalSocket(() => undefined, { onDisabled });
    const ws = await openAndAuth();
    ws.serverClose(4404);
    expect(onDisabled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close 4403 stops with status false and no reconnect', async () => {
    const status: boolean[] = [];
    const onDisabled = vi.fn();
    openGlobalSocket(() => undefined, { onStatus: (c) => status.push(c), onDisabled });
    const ws = await openAndAuth();
    ws.serverClose(4403);
    expect(status).toEqual([false]);
    expect(onDisabled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a bootstrap failure means disabled: socket closed, no reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const onDisabled = vi.fn();
    openGlobalSocket(() => undefined, { onDisabled });
    const ws = await openAndAuth();
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(ws.sent).toEqual([]);
    expect(ws.closeCalls).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('pings every 25s while open', async () => {
    const stop = openGlobalSocket(() => undefined);
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    const pings = () => ws.sent.filter((s) => s === '{"type":"ping"}').length;
    vi.advanceTimersByTime(24_999);
    expect(pings()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pings()).toBe(1);
    ws.receive({ type: 'pong' });
    vi.advanceTimersByTime(25_000);
    expect(pings()).toBe(2);
    stop();
  });

  it('treats 60s without any frame as a dead socket: closes it and reconnects', async () => {
    const status: boolean[] = [];
    const stop = openGlobalSocket(() => undefined, { onStatus: (c) => status.push(c) });
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    vi.advanceTimersByTime(59_000);
    ws.receive({ type: 'heartbeat', ts: 'x' }); // any frame re-arms the timer
    vi.advanceTimersByTime(59_000);
    expect(ws.closeCalls).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(ws.closeCalls).toBe(1);
    expect(status).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    stop();
  });

  it('stop() closes the socket, clears timers and prevents reconnects', async () => {
    const status: boolean[] = [];
    const stop = openGlobalSocket(() => undefined, { onStatus: (c) => status.push(c) });
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    stop();
    expect(ws.closeCalls).toBe(1);
    ws.serverClose(1006); // late close event after stop: ignored
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(status).toEqual([true]);
  });

  it('stop() while a reconnect is pending cancels it', async () => {
    const stop = openGlobalSocket(() => undefined);
    FakeWebSocket.last.serverClose(1006);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('dispatches message and run_update frames and warns once about malformed ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onMessage = vi.fn();
    const onRunUpdate = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onMessage, onRunUpdate });
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    const message = { id: 'm1', project_id: 'p1', task_id: null, author: 'user', body: 'oi', run_id: null, created_at: 'x' };
    const run = { id: 'r1', project_id: 'p1', status: 'running' };
    ws.receive({ type: 'message', message });
    ws.receive({ type: 'run_update', run });
    expect(onMessage).toHaveBeenCalledWith({ ...message, delivery: null, routine_id: null });
    expect(onRunUpdate).toHaveBeenCalledWith({
      ...run,
      inbox_count: 0,
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
      actions_count: 0,
      question: null,
      session_mode: 'fresh',
      session_from: null,
      routine_id: null,
      routine_title: null,
    });
    expect(warn).not.toHaveBeenCalled();
    ws.receive({ type: 'message', message: { id: 'm2' } });
    ws.receive({ type: 'run_update', run: { id: 'r1', project_id: 'p1' } });
    ws.receive({ type: 'run_update' });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onRunUpdate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('delivers run_update frames with the step 1a fields and drops one whose fields are mistyped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onRunUpdate = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onRunUpdate });
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    const run = { id: 'r1', project_id: 'p1', status: 'failed', recoveries: 1, can_continue: true, continued_from: null, continued_by: 'r2' };
    ws.receive({ type: 'run_update', run });
    expect(onRunUpdate).toHaveBeenCalledWith({ ...run, wait_kind: null, wait_until: null, wait_since: null, wait_attempts: 0, wait_detail: null, wait_exact: false, inbox_count: 0, actions_count: 0, question: null, session_mode: 'fresh', session_from: null, routine_id: null, routine_title: null });
    expect(warn).not.toHaveBeenCalled();
    ws.receive({ type: 'run_update', run: { ...run, can_continue: 'sim' } });
    expect(onRunUpdate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('delivers run_update frames that carry the parking fields and drops one whose fields are mistyped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onRunUpdate = vi.fn();
    const stop = openGlobalSocket(() => undefined, { onRunUpdate });
    const ws = await openAndAuth();
    ws.receive({ type: 'ready' });
    const run = {
      id: 'r1',
      project_id: 'p1',
      status: 'parked',
      recoveries: 0,
      can_continue: false,
      continued_from: null,
      continued_by: null,
      wait_kind: 'plan_limit',
      wait_until: '2026-01-01T14:30:00Z',
      wait_since: '2026-01-01T10:00:00Z',
      wait_attempts: 2,
      wait_detail: null,
      wait_exact: true,
    };
    ws.receive({ type: 'run_update', run });
    expect(onRunUpdate).toHaveBeenCalledWith({ ...run, inbox_count: 0, actions_count: 0, question: null, session_mode: 'fresh', session_from: null, routine_id: null, routine_title: null });
    ws.receive({ type: 'run_update', run: { ...run, wait_kind: 'clima' } });
    ws.receive({ type: 'run_update', run: { ...run, wait_attempts: 'duas' } });
    expect(onRunUpdate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });
});
