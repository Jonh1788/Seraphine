/** Phase 6b: validators of the routine shapes, the new calls, the tolerance for an older backend and the live frames. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { makeMessage, makeRun } from './fixtures';
import { FakeWebSocket } from './fakeSocket';
import { makeRoutine, makeRoutineDraft, makeRoutineRun, makeDraftResult, draftWithRoutines } from './routines-fixtures';
import { makeTeamResult } from './setup-fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let calls: { url: string; init?: RequestInit }[] = [];
function serve(answer: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/agents/bootstrap')) return jsonResponse({ token: 'tok' });
      calls.push({ url: String(url), init });
      return jsonResponse(answer, status);
    }),
  );
}
const body = (i: number): unknown => JSON.parse(String(calls[i].init?.body));

beforeEach(() => {
  api.resetToken();
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('schedule validator', () => {
  const ok = (v: unknown) => api.checkSchedule(v, 'x');
  it('accepts every kind with exactly its fields', () => {
    expect(ok({ kind: 'daily', time: '08:00' })).toEqual({ kind: 'daily', time: '08:00' });
    expect(ok({ kind: 'weekdays', time: '23:59' })).toEqual({ kind: 'weekdays', time: '23:59' });
    expect(ok({ kind: 'weekly', time: '19:30', days: [0, 3] })).toEqual({ kind: 'weekly', time: '19:30', days: [0, 3] });
    expect(ok({ kind: 'monthly', time: '09:00', day: 'last' })).toEqual({ kind: 'monthly', time: '09:00', day: 'last' });
    expect(ok({ kind: 'monthly', time: '09:00', day: 28 })).toEqual({ kind: 'monthly', time: '09:00', day: 28 });
    expect(ok({ kind: 'interval', every_minutes: 15 })).toEqual({ kind: 'interval', every_minutes: 15 });
    expect(ok({ kind: 'once', at: '2026-11-14T10:00:00Z' })).toEqual({ kind: 'once', at: '2026-11-14T10:00:00Z' });
  });
  it('refuses a wrong kind, hour, day or interval', () => {
    expect(() => ok({ kind: 'yearly', time: '08:00' })).toThrow();
    expect(() => ok({ kind: 'daily', time: '8:00' })).toThrow();
    expect(() => ok({ kind: 'daily', time: '24:00' })).toThrow();
    expect(() => ok({ kind: 'weekly', time: '08:00', days: [] })).toThrow();
    expect(() => ok({ kind: 'weekly', time: '08:00', days: [7] })).toThrow();
    expect(() => ok({ kind: 'weekly', time: '08:00', days: [1, 1] })).toThrow();
    expect(() => ok({ kind: 'monthly', time: '08:00', day: 29 })).toThrow();
    expect(() => ok({ kind: 'monthly', time: '08:00', day: 'first' })).toThrow();
    expect(() => ok({ kind: 'interval', every_minutes: 14 })).toThrow();
    expect(() => ok({ kind: 'interval', every_minutes: 1441 })).toThrow();
    expect(() => ok({ kind: 'once', at: 'amanhã' })).toThrow();
    expect(() => ok('daily')).toThrow();
  });
});

describe('routine validators', () => {
  it('reads a routine of the contract and refuses a missing or mistyped field', () => {
    const r = makeRoutine();
    expect(api.checkRoutine(r, 'x')).toEqual(r);
    expect(() => api.checkRoutine({ ...r, enabled: 'sim' }, 'x')).toThrow();
    expect(() => api.checkRoutine({ ...r, paused_reason: 'tired' }, 'x')).toThrow();
    expect(() => api.checkRoutine({ ...r, week: { ok: 1 } }, 'x')).toThrow();
    expect(() => api.checkRoutine({ ...r, upcoming: 'amanhã' }, 'x')).toThrow();
    expect(() => api.checkRoutine({ ...r, report: 'never' }, 'x')).toThrow();
    expect(() => api.checkRoutine({ ...r, schedule: { kind: 'daily' } }, 'x')).toThrow();
    const { consecutive_failures: _gone, ...noFailures } = r;
    expect(() => api.checkRoutine(noFailures, 'x')).toThrow();
    expect(api.checkRoutine({ ...r, paused_reason: 'failures', enabled: false, next_run_at: null, last_status: 'failed' }, 'x').paused_reason).toBe('failures');
  });

  it('reads a ledger line and refuses an unknown state or trigger', () => {
    const line = makeRoutineRun();
    expect(api.checkRoutineRun(line, 'x')).toEqual(line);
    expect(() => api.checkRoutineRun({ ...line, status: 'sleeping' }, 'x')).toThrow();
    expect(() => api.checkRoutineRun({ ...line, trigger: 'webhook' }, 'x')).toThrow();
    expect(() => api.checkRoutineRun({ ...line, run_id: 3 }, 'x')).toThrow();
    for (const status of ['running', 'reported', 'quiet', 'failed', 'cancelled', 'skipped', 'missed']) {
      expect(api.checkRoutineRun({ ...line, status }, 'x').status).toBe(status);
    }
  });

  it('reads a routine inside an agent draft and keeps `schedule_text` when it is sent', () => {
    const d = api.checkDraft(draftWithRoutines([makeRoutineDraft({ schedule_text: 'Toda sexta às 17:00' }), makeRoutineDraft({ report: undefined })]), 'x');
    expect(d.routines).toHaveLength(2);
    expect(d.routines?.[0].schedule_text).toBe('Toda sexta às 17:00');
    expect(d.routines?.[1].report).toBeUndefined();
    expect(() => api.checkDraft({ ...draftWithRoutines(), routines: 'muitas' }, 'x')).toThrow();
    expect(() => api.checkDraft(draftWithRoutines([makeRoutineDraft({ schedule: { kind: 'interval', every_minutes: 5 } })]), 'x')).toThrow();
  });
});

describe('tolerance for an older backend (one place)', () => {
  it('a run without the routine fields reads them as null; one that has them keeps them', () => {
    const { routine_id: _a, routine_title: _b, ...old } = makeRun();
    expect(api.checkRun(old, 'x')).toMatchObject({ routine_id: null, routine_title: null });
    expect(api.checkRun(makeRun({ routine_id: 'rt1', routine_title: 'Pendências' }), 'x')).toMatchObject({ routine_id: 'rt1', routine_title: 'Pendências' });
    expect(() => api.checkRun({ ...makeRun(), routine_id: 4 }, 'x')).toThrow();
    expect(() => api.checkRun({ ...makeRun(), routine_title: 4 }, 'x')).toThrow();
  });

  it('a message without `routine_id` reads it as null', () => {
    const { routine_id: _a, ...old } = makeMessage();
    expect(api.checkMessage(old, 'x').routine_id).toBeNull();
    expect(api.checkMessage(makeMessage({ routine_id: 'rt1' }), 'x').routine_id).toBe('rt1');
    expect(() => api.checkMessage({ ...makeMessage(), routine_id: 4 }, 'x')).toThrow();
  });

  it('the overview carries `routines_active` (0 when absent)', async () => {
    serve({ pending_approvals: [], active_runs: [], spend_today: [] });
    expect((await api.getOverview()).routines_active).toBe(0);
    serve({ pending_approvals: [], active_runs: [], spend_today: [], routines_active: 3 });
    expect((await api.getOverview()).routines_active).toBe(3);
    serve({ pending_approvals: [], active_runs: [], spend_today: [], routines_active: 'três' });
    await expect(api.getOverview()).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('the team result carries `routines` ([] when absent)', async () => {
    const { routines: _gone, ...old } = makeTeamResult();
    serve(old);
    expect((await api.createTeam({ origin: 'guide', agents: [] })).routines).toEqual([]);
    serve({ ...old, routines: [makeRoutine()] });
    expect((await api.createTeam({ origin: 'guide', agents: [] })).routines).toEqual([makeRoutine()]);
    serve({ ...old, routines: [{ id: 'x' }] });
    await expect(api.createTeam({ origin: 'guide', agents: [] })).rejects.toMatchObject({ name: 'ApiError' });
  });
});

describe('the routine calls', () => {
  it('lists (all, or one agent) and unwraps the envelope', async () => {
    serve({ routines: [makeRoutine()] });
    await expect(api.listRoutines()).resolves.toEqual([makeRoutine()]);
    await api.listRoutines('lia');
    expect(calls[0].url).toMatch(/\/agents\/routines$/);
    expect(calls[1].url).toMatch(/\/agents\/routines\?agent_id=lia$/);
    serve({ routines: [{ id: 'x' }] });
    await expect(api.listRoutines()).rejects.toMatchObject({ name: 'ApiError' });
    serve({ lista: [] });
    await expect(api.listRoutines()).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('a 404 is an ApiError the store reads as "older backend"', async () => {
    serve({ detail: 'Not Found' }, 404);
    await expect(api.listRoutines()).rejects.toMatchObject({ name: 'ApiError', status: 404 });
  });

  it('creates and updates with the contract bodies', async () => {
    serve({ routine: makeRoutine() });
    const schedule = { kind: 'weekdays' as const, time: '08:00' };
    await api.createRoutine({ agent_id: 'lia', title: 'Pendências', prompt: 'Liste.', schedule, report: 'news' });
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/agents\/routines$/);
    expect(body(0)).toEqual({ agent_id: 'lia', title: 'Pendências', prompt: 'Liste.', schedule, report: 'news' });
    await api.updateRoutine('rt1', { enabled: false });
    expect(calls[1].init?.method).toBe('PATCH');
    expect(calls[1].url).toMatch(/\/agents\/routines\/rt1$/);
    expect(body(1)).toEqual({ enabled: false });
  });

  it('deletes, runs now, copies and reads the ledger', async () => {
    serve({ ok: true });
    await expect(api.deleteRoutine('rt1')).resolves.toBeUndefined();
    expect(calls[0].init?.method).toBe('DELETE');
    serve({ ok: false });
    await expect(api.deleteRoutine('rt1')).rejects.toMatchObject({ name: 'ApiError' });

    serve({ routine: makeRoutine({ running: true }), run: makeRun({ routine_id: 'rt1' }) });
    const res = await api.runRoutineNow('rt1');
    expect(res.routine.running).toBe(true);
    expect(res.run.routine_id).toBe('rt1');
    expect(calls[calls.length - 1].init?.method).toBe('POST');
    expect(calls[calls.length - 1].url).toMatch(/\/agents\/routines\/rt1\/run$/);

    serve({ routine: makeRoutine({ id: 'rt2', title: 'Pendências (cópia)', enabled: false, origin: 'copy' }) });
    expect((await api.copyRoutine('rt1')).origin).toBe('copy');
    expect(calls[calls.length - 1].url).toMatch(/\/agents\/routines\/rt1\/copy$/);

    serve({ runs: [makeRoutineRun()] });
    await expect(api.listRoutineRuns('rt1')).resolves.toEqual([makeRoutineRun()]);
    expect(calls[calls.length - 1].url).toMatch(/\/agents\/routines\/rt1\/runs\?limit=20$/);
    await api.listRoutineRuns('rt1', 100);
    expect(calls[calls.length - 1].url).toMatch(/limit=100$/);
  });

  it('carries the machine code of a refusal', async () => {
    serve({ detail: 'Limite.', code: 'routine_limit' }, 409);
    await expect(api.createRoutine({ agent_id: 'lia', title: 't', prompt: 'p', schedule: { kind: 'daily', time: '08:00' } })).rejects.toMatchObject({ status: 409, code: 'routine_limit' });
    serve({ detail: { message: 'Rodando.', code: 'routine_running' } }, 409);
    await expect(api.runRoutineNow('rt1')).rejects.toMatchObject({ status: 409, code: 'routine_running' });
  });

  it('reads one sentence into a draft and validates every field of the answer', async () => {
    serve(makeDraftResult());
    const res = await api.draftRoutine({ text: 'todo dia útil às 8 me mande as pendências', agent_id: 'lia' });
    expect(res.draft.schedule).toEqual({ kind: 'weekdays', time: '08:00' });
    expect(res.say).toMatch(/Entendi/);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/agents\/routines\/draft$/);
    expect(body(0)).toEqual({ text: 'todo dia útil às 8 me mande as pendências', agent_id: 'lia' });
    serve({ ...makeDraftResult(), draft: { ...makeDraftResult().draft, schedule: { kind: 'interval', every_minutes: 3 } } });
    await expect(api.draftRoutine({ text: 'x' })).rejects.toMatchObject({ name: 'ApiError' });
    serve({ say: 'oi' });
    await expect(api.draftRoutine({ text: 'x' })).rejects.toMatchObject({ name: 'ApiError' });
    serve({ draft: { title: 'a', prompt: 'b', schedule_text: 'c', schedule: { kind: 'daily', time: '08:00' }, report: 'news' }, say: 3 });
    await expect(api.draftRoutine({ text: 'x' })).rejects.toMatchObject({ name: 'ApiError' });
  });
});

describe('live frames', () => {
  async function flush(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  }
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ token: 'tok' })));
  });

  it('delivers routine_update and routine_deleted and drops a malformed routine', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onRoutineUpdate = vi.fn();
    const onRoutineDeleted = vi.fn();
    const stop = api.openGlobalSocket(() => undefined, { onRoutineUpdate, onRoutineDeleted });
    const ws = FakeWebSocket.last;
    ws.open();
    await flush();
    ws.receive({ type: 'ready' });
    ws.receive({ type: 'routine_update', routine: makeRoutine() });
    expect(onRoutineUpdate).toHaveBeenCalledWith(makeRoutine());
    ws.receive({ type: 'routine_deleted', id: 'rt1' });
    expect(onRoutineDeleted).toHaveBeenCalledWith('rt1');
    expect(warn).not.toHaveBeenCalled();
    ws.receive({ type: 'routine_update', routine: { ...makeRoutine(), schedule: { kind: 'nope' } } });
    ws.receive({ type: 'routine_deleted' });
    expect(onRoutineUpdate).toHaveBeenCalledTimes(1);
    expect(onRoutineDeleted).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    stop();
    warn.mockRestore();
  });
});
