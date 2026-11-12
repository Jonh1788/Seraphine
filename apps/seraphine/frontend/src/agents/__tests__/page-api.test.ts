/** Phase 6c part 2: validators and calls of the agent page, checklist, usage, batches, the archived fields and the tolerance for an older backend. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { makeAgent } from './fixtures';
import { checklistWithDone, makeAgentPage, makeBatch, makeChecklist, makeUndoResult, makeUsage, wirePage } from './page-fixtures';
import { makeProposal, wireProposal } from './guide-fixtures';
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

describe('archived fields of an agent', () => {
  it('reads `archived` and `archived_at` when they are there', () => {
    const a = api.checkAgent({ ...makeAgent(), archived: true, archived_at: '2026-11-12T10:00:00Z' }, 'x');
    expect(a.archived).toBe(true);
    expect(a.archived_at).toBe('2026-11-12T10:00:00Z');
  });

  it('an older backend sends neither: the agent reads as not archived', () => {
    const { archived: _a, archived_at: _b, ...old } = makeAgent();
    const a = api.checkAgent(old, 'x');
    expect(a.archived).toBe(false);
    expect(a.archived_at).toBeNull();
  });

  it('refuses a mistyped value', () => {
    expect(() => api.checkAgent({ ...makeAgent(), archived: 'sim' }, 'x')).toThrow();
    expect(() => api.checkAgent({ ...makeAgent(), archived_at: 5 }, 'x')).toThrow();
  });

  it('listAgents asks for the archived ones only when told to', async () => {
    serve({ defs: [makeAgent({ archived: true, archived_at: '2026-11-12T10:00:00Z' })] });
    const list = await api.listAgents({ includeArchived: true });
    expect(calls[0].url).toMatch(/\/agents\/defs\?include_archived=true$/);
    expect(list[0].archived).toBe(true);
    serve({ defs: [] });
    await api.listAgents();
    expect(calls[1].url).toMatch(/\/agents\/defs$/);
  });

  it('archiveAgent and unarchiveAgent POST to their routes and read {def}', async () => {
    serve({ def: makeAgent({ id: 'bia', archived: true, archived_at: '2026-11-12T10:00:00Z' }) });
    const archived = await api.archiveAgent('bia');
    expect(calls[0].url).toMatch(/\/agents\/defs\/bia\/archive$/);
    expect(calls[0].init?.method).toBe('POST');
    expect(archived.archived).toBe(true);
    serve({ def: makeAgent({ id: 'bia' }) });
    const back = await api.unarchiveAgent('bia');
    expect(calls[1].url).toMatch(/\/agents\/defs\/bia\/unarchive$/);
    expect(back.archived).toBe(false);
  });

  it('a 409 `agent_busy` keeps its code', async () => {
    serve({ detail: 'ocupado', code: 'agent_busy' }, 409);
    await expect(api.archiveAgent('bia')).rejects.toMatchObject({ status: 409, code: 'agent_busy' });
  });
});

describe('batch on a team result and in a proposal', () => {
  const team = (extra: Record<string, unknown>): Record<string, unknown> => {
    const { batch: _gone, ...rest } = makeTeamResult();
    return { ...rest, ...extra };
  };

  it('POST /team keeps `batch` when it is there', async () => {
    serve(team({ batch: { id: 'b1', undo_until: '2026-11-13T10:00:00Z' } }));
    const res = await api.createTeam({ origin: 'guide', agents: [] });
    expect(res.batch).toEqual({ id: 'b1', undo_until: '2026-11-13T10:00:00Z' });
  });

  it('`batch: null` and a missing `batch` both read as null', async () => {
    serve(team({ batch: null }));
    expect((await api.createTeam({ origin: 'guide', agents: [] })).batch).toBeNull();
    serve(team({}));
    expect((await api.createTeam({ origin: 'guide', agents: [] })).batch).toBeNull();
  });

  it('refuses a batch of the wrong shape', () => {
    expect(() => api.checkBatchRef({ id: 'b1' }, 'x')).toThrow();
    expect(() => api.checkBatchRef({ undo_until: 'x' }, 'x')).toThrow();
    expect(() => api.checkBatchRef('b1', 'x')).toThrow();
    expect(api.checkBatchRef(undefined, 'x')).toBeNull();
  });

  it('a proposal result carries `batch` through the validator; without it the result has none', () => {
    const wired = wireProposal('create_agents', { status: 'applied', result: { agent_ids: ['bia'], batch: { id: 'b1', undo_until: '2026-11-13T10:00:00Z' } } });
    expect(api.checkProposal(wired, 'x').result?.batch).toEqual({ id: 'b1', undo_until: '2026-11-13T10:00:00Z' });
    expect(makeProposal('create_agents', { status: 'applied', result: { agent_ids: ['bia'], batch: null } }).result?.batch).toBeNull();
    expect(makeProposal('create_agents', { status: 'applied', result: { agent_ids: ['bia'] } }).result?.batch).toBeUndefined();
    expect(() => api.checkProposal(wireProposal('create_agents', { status: 'applied', result: { batch: { id: 3 } } }), 'x')).toThrow();
  });
});

describe('the agent page', () => {
  it('reads every block of the contract', () => {
    const page = makeAgentPage();
    expect(api.checkAgentPage(wirePage(page))).toEqual(page);
  });

  it('accepts a page with no home and a never-run agent', () => {
    const page = makeAgentPage({ home: null, routines: { total: 0, active: 0, next_run_at: null }, activity: { runs: 0, last_run_at: null, tokens_in: 0, tokens_out: 0 } });
    expect(api.checkAgentPage(wirePage(page)).home).toBeNull();
  });

  it('refuses a missing block or a mistyped field (the route is new: no tolerance)', () => {
    const w = wirePage();
    for (const key of ['def', 'engine', 'access', 'routines', 'activity', 'checklist']) {
      const { [key]: _gone, ...rest } = w;
      expect(() => api.checkAgentPage(rest), key).toThrow();
    }
    expect(() => api.checkAgentPage({ ...w, engine: { ready: 'sim', label: 'x', how: '' } })).toThrow();
    expect(() => api.checkAgentPage({ ...w, access: [{ group: 'notes', label: 'Notas', level: 'admin' }] })).toThrow();
    expect(() => api.checkAgentPage({ ...w, routines: { total: -1, active: 0, next_run_at: null } })).toThrow();
    expect(() => api.checkAgentPage({ ...w, activity: { runs: 1, last_run_at: 4, tokens_in: 0, tokens_out: 0 } })).toThrow();
    expect(() => api.checkAgentPage('x')).toThrow();
  });

  it('getAgentPage GETs /defs/{id}/page', async () => {
    serve(wirePage());
    const page = await api.getAgentPage('lia');
    expect(calls[0].url).toMatch(/\/agents\/defs\/lia\/page$/);
    expect(page.def.id).toBe('lia');
  });

  it('a 404 is an ApiError the store reads as "an older backend"', async () => {
    serve({ detail: 'Not Found' }, 404);
    await expect(api.getAgentPage('lia')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the checklist', () => {
  it('reads items, counts and the dismissed flag', () => {
    const c = checklistWithDone(['engine', 'access']);
    expect(api.checkChecklist(c)).toEqual(c);
  });

  it('refuses a wrong item or count', () => {
    const c = makeChecklist();
    expect(() => api.checkChecklist({ ...c, items: [{ id: 'engine', done: 'sim', optional: false }] })).toThrow();
    expect(() => api.checkChecklist({ ...c, items: [{ id: 'engine', done: true }] })).toThrow();
    expect(() => api.checkChecklist({ ...c, dismissed: undefined })).toThrow();
    expect(() => api.checkChecklist({ ...c, done: 1.5 })).toThrow();
    expect(() => api.checkChecklist({ ...c, items: 'x' })).toThrow();
  });

  it('putAgentChecklist PUTs the partial body and reads {checklist}', async () => {
    serve({ checklist: checklistWithDone(['engine', 'access']) });
    const out = await api.putAgentChecklist('lia', { access_ok: true });
    expect(calls[0].url).toMatch(/\/agents\/defs\/lia\/checklist$/);
    expect(calls[0].init?.method).toBe('PUT');
    expect(body(0)).toEqual({ access_ok: true });
    expect(out.done).toBe(2);
    serve({ checklist: null });
    await expect(api.putAgentChecklist('lia', { dismissed: true })).rejects.toBeInstanceOf(api.ApiError);
  });
});

describe('usage', () => {
  it('reads totals, the agents and every day', () => {
    const u = makeUsage();
    expect(api.checkUsage(u)).toEqual(u);
  });

  it('refuses a missing or mistyped field', () => {
    const u = makeUsage();
    expect(() => api.checkUsage({ ...u, totals: { ...u.totals, runs: '40' } })).toThrow();
    expect(() => api.checkUsage({ ...u, agents: [{ ...u.agents[0], cost_known: 'não' }] })).toThrow();
    expect(() => api.checkUsage({ ...u, agents: [{ ...u.agents[0], archived: undefined }] })).toThrow();
    expect(() => api.checkUsage({ ...u, by_day: [{ ...u.by_day[0], date: '12/11' }] })).toThrow();
    expect(() => api.checkUsage({ ...u, by_day: undefined })).toThrow();
    expect(() => api.checkUsage({ ...u, totals: undefined })).toThrow();
  });

  it('getUsage sends the period', async () => {
    serve(makeUsage({ days: 7 }));
    const out = await api.getUsage(7);
    expect(calls[0].url).toMatch(/\/agents\/usage\?days=7$/);
    expect(out.days).toBe(7);
  });
});

describe('batches', () => {
  it('getTeamBatch reads {batch}', async () => {
    serve({ batch: makeBatch() });
    const b = await api.getTeamBatch('b1');
    expect(calls[0].url).toMatch(/\/agents\/team\/batches\/b1$/);
    expect(b.can_undo).toBe(true);
    expect(b.agents.map((a) => a.agent_id)).toEqual(['lia', 'nara']);
  });

  it('refuses a batch whose agents are malformed', () => {
    expect(() => api.checkTeamBatch({ ...makeBatch(), agents: [{ agent_id: 'lia', name: 'Lia' }] })).toThrow();
    expect(() => api.checkTeamBatch({ ...makeBatch(), can_undo: 'sim' })).toThrow();
  });

  it('undoTeamBatch POSTs and reads the three lists', async () => {
    const result = makeUndoResult({ kept: [{ agent_id: 'x', name: 'Ivo', detail: 'Está trabalhando agora.' }] });
    serve(result);
    expect(await api.undoTeamBatch('b1')).toEqual(result);
    expect(calls[0].url).toMatch(/\/agents\/team\/batches\/b1\/undo$/);
    expect(calls[0].init?.method).toBe('POST');
    expect(() => api.checkTeamUndoResult({ removed: [], archived: [] })).toThrow();
    expect(() => api.checkTeamUndoResult({ removed: [], archived: [], kept: [{ agent_id: 'x', name: 'Ivo' }] })).toThrow();
  });

  it('the two refusals keep their codes', async () => {
    serve({ detail: 'x', code: 'undo_expired' }, 409);
    await expect(api.undoTeamBatch('b1')).rejects.toMatchObject({ status: 409, code: 'undo_expired' });
    serve({ detail: 'x', code: 'already_undone' }, 409);
    await expect(api.undoTeamBatch('b1')).rejects.toMatchObject({ status: 409, code: 'already_undone' });
  });
});
