/** Step 1c, wire side: `delivery`, `inbox_count`, the send mode and its flags, the `message_update` frame. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { FakeWebSocket } from './fakeSocket';
import { makeMessage, makeRun } from './fixtures';

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function serve(answer: unknown, status = 200): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/agents/bootstrap')) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      seen.push({ method: init?.method ?? 'GET', url: url.replace(/^.*\/agents/, ''), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer), { status });
    }),
  );
  return seen;
}

beforeEach(() => api.resetToken());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delivery on messages', () => {
  const { delivery: _d, ...legacy } = makeMessage();

  it('defaults to null when missing and keeps the three known values', async () => {
    serve({ messages: [legacy, { ...legacy, id: 'm2', delivery: 'pending' }, { ...legacy, id: 'm3', delivery: 'delivered' }, { ...legacy, id: 'm4', delivery: 'undelivered' }] });
    const list = await api.listMessages('p1');
    expect(list.map((m) => m.delivery)).toEqual([null, 'pending', 'delivered', 'undelivered']);
    serve({ messages: [legacy] });
    expect((await api.listTaskMessages('t1'))[0].delivery).toBeNull();
  });

  it.each(['lida', 3, false])('rejects a mistyped delivery (%j)', async (value) => {
    serve({ messages: [{ ...legacy, delivery: value }] });
    await expect(api.listMessages('p1')).rejects.toThrow(/Resposta inesperada.*delivery/);
    serve({ message: { ...legacy, delivery: value }, run: null, agent_id: null, error: null, detail: null });
    await expect(api.sendMessage('p1', { body: 'oi' })).rejects.toThrow(/Resposta inesperada/);
  });
});

describe('inbox_count on runs', () => {
  const { inbox_count: _i, ...legacy } = makeRun();

  it('defaults to 0 and keeps a valid count', async () => {
    serve({ run: legacy });
    expect((await api.getRun('r1')).inbox_count).toBe(0);
    serve({ run: { ...legacy, inbox_count: 3 } });
    expect((await api.getRun('r1')).inbox_count).toBe(3);
  });

  it.each(['dois', -1, 1.5, null])('rejects a mistyped inbox_count (%j)', async (value) => {
    serve({ run: { ...legacy, inbox_count: value } });
    await expect(api.getRun('r1')).rejects.toThrow(/Resposta inesperada.*inbox_count/);
    serve({ runs: [{ ...legacy, inbox_count: value }] });
    await expect(api.listRuns()).rejects.toThrow(/Resposta inesperada/);
  });
});

describe('sending with a mode', () => {
  const answer = { message: makeMessage(), agent_id: 'ag1', run: makeRun(), error: null, detail: null };

  it('sends mode only when it is not join, and reads joined/interrupted (default false)', async () => {
    let seen = serve(answer);
    const plain = await api.sendMessage('p1', { body: 'oi', agent_id: 'ag1', mode: 'join' });
    expect(seen[0].body).toEqual({ body: 'oi', agent_id: 'ag1' });
    expect(plain).toMatchObject({ joined: false, interrupted: false });
    seen = serve({ ...answer, joined: true, interrupted: true });
    const res = await api.sendMessage('p1', { body: 'oi', agent_id: 'ag1', mode: 'interrupt' });
    expect(seen[0].body).toEqual({ body: 'oi', agent_id: 'ag1', mode: 'interrupt' });
    expect(res).toMatchObject({ joined: true, interrupted: true });
  });

  it('rejects non-boolean flags', async () => {
    serve({ ...answer, joined: 'sim' });
    await expect(api.sendMessage('p1', { body: 'oi' })).rejects.toThrow(/Resposta inesperada.*joined/);
  });

  it('keeps the inbox_full code of a 409', async () => {
    serve({ detail: 'inbox full', code: 'inbox_full' }, 409);
    await expect(api.sendMessage('p1', { body: 'oi' })).rejects.toMatchObject({ status: 409, code: 'inbox_full' });
  });
});

describe('message_update frame', () => {
  function open(opts: api.StreamOptions): { ws: FakeWebSocket; stop: () => void } {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 't' }))));
    api.resetToken();
    FakeWebSocket.reset();
    const stop = api.openGlobalSocket(() => undefined, opts);
    const ws = FakeWebSocket.last;
    ws.open();
    ws.receive({ type: 'ready' });
    return { ws, stop };
  }

  it('is parsed like a message (delivery defaulted); a malformed one is dropped with the single warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onMessage = vi.fn();
    const onMessageUpdate = vi.fn();
    const { ws, stop } = open({ onMessage, onMessageUpdate });
    const { delivery: _d, ...legacy } = makeMessage();
    ws.receive({ type: 'message_update', message: { ...legacy, delivery: 'delivered' } });
    ws.receive({ type: 'message_update', message: legacy });
    expect(onMessageUpdate.mock.calls.map((c) => c[0].delivery)).toEqual(['delivered', null]);
    expect(onMessage).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    ws.receive({ type: 'message_update', message: { ...legacy, delivery: 'lida' } });
    ws.receive({ type: 'message_update', message: { id: 'x' } });
    ws.receive({ type: 'message_update' });
    expect(onMessageUpdate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });
});
