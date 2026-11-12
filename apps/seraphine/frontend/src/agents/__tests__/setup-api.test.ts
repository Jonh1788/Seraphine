/** Phase 6a: the validators of the new shapes and the new calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDraft, makePack, makeSetup, makeTeamResult } from './setup-fixtures';
import { makeAgent, makeProject } from './fixtures';
import * as api from '../api';

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

beforeEach(() => {
  api.resetToken();
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('setup', () => {
  it('reads the whole setup and sends a partial PUT', async () => {
    serve({ setup: makeSetup({ areas: ['casa'], default_engine: { engine: 'claude_code', provider: 'anthropic', model: null } }) });
    const setup = await api.getSetup();
    expect(setup.areas).toEqual(['casa']);
    expect(setup.default_engine).toEqual({ engine: 'claude_code', provider: 'anthropic', model: null });
    expect(calls[0].url).toMatch(/\/agents\/setup$/);
    await api.putSetup({ areas_skipped: true });
    expect(calls[1].init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ areas_skipped: true });
  });

  it('rejects a setup with a missing or mistyped field', () => {
    expect(() => api.checkSetup({ ...makeSetup(), dismissed: 'no' })).toThrow();
    expect(() => api.checkSetup({ ...makeSetup(), steps: [{ id: 'bogus', done: true }] })).toThrow();
    const { home_dir: _gone, ...noHome } = makeSetup();
    expect(() => api.checkSetup(noHome)).toThrow();
    expect(() => api.checkSetup({ ...makeSetup(), default_engine: { engine: 'x', provider: 3, model: null } })).toThrow();
  });
});

describe('packs, proposal and team', () => {
  it('parses packs and drafts, and refuses a draft without instructions', async () => {
    serve({ packs: [makePack()] });
    const packs = await api.getPacks();
    expect(packs[0].agents).toHaveLength(2);
    expect(() => api.checkDraft({ ...makeDraft(), instructions: 4 }, 'x')).toThrow();
    expect(() => api.checkDraft({ ...makeDraft(), suggestions: 'oi' }, 'x')).toThrow();
    serve({ packs: [{ ...makePack(), agents: [{ name: 'só nome' }] }] });
    await expect(api.getPacks()).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('sends the proposal request as the contract says and parses the answer', async () => {
    serve({ proposal: { say: 'Montei dois agentes.', agents: [makeDraft()] } });
    const proposal = await api.proposeTeam({ text: 'contas da casa', previous: { agents: [makeDraft()] }, areas: ['casa'] });
    expect(proposal.say).toBe('Montei dois agentes.');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'contas da casa', previous: { agents: [makeDraft()] }, areas: ['casa'] });
    serve({ proposal: { agents: [] } });
    await expect(api.proposeTeam({ text: 'x' })).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('keeps the code of a 503 and a 409 from the guide', async () => {
    serve({ detail: 'Não consegui montar o time.', code: 'guide_unavailable' }, 503);
    await expect(api.proposeTeam({ text: 'x' })).rejects.toMatchObject({ status: 503, code: 'guide_unavailable' });
    serve({ detail: 'Já há uma proposta.', code: 'guide_busy' }, 409);
    await expect(api.proposeTeam({ text: 'x' })).rejects.toMatchObject({ status: 409, code: 'guide_busy' });
  });

  it('parses created, failed and lowered', async () => {
    serve({
      ...makeTeamResult({
        failed: [{ name: 'Nara', detail: 'Já existe um agente com esse nome.' }],
        lowered: [{ name: 'Lia', group: 'memory', asked: 'read', got: 'none' }],
      }),
    });
    const res = await api.createTeam({ origin: 'pack:dia_em_ordem', agents: [makeDraft()] });
    expect(res.created[0].home.kind).toBe('home');
    expect(res.failed[0].detail).toBe('Já existe um agente com esse nome.');
    expect(res.lowered[0]).toEqual({ name: 'Lia', group: 'memory', asked: 'read', got: 'none' });
    expect(JSON.parse(String(calls[0].init?.body)).origin).toBe('pack:dia_em_ordem');
    serve({ created: [], failed: [], lowered: [{ name: 'x', group: 'memory', asked: 'huge', got: 'none' }] });
    await expect(api.createTeam({ origin: 'guide', agents: [] })).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('ensures an agent home with POST and returns the project', async () => {
    serve({ project: makeProject({ id: 'home-lia', kind: 'home', agent_id: 'lia' }) });
    const home = await api.ensureAgentHome('lia');
    expect(home.kind).toBe('home');
    expect(calls[0].url).toMatch(/\/agents\/defs\/lia\/home$/);
    expect(calls[0].init?.method).toBe('POST');
  });
});

describe('new always-present fields', () => {
  it('parses the agent fields and defaults them (only) when an older backend omits them', () => {
    const full = api.checkAgent({ ...makeAgent(), description: 'Faz coisas', suggestions: ['a'], home_project_id: 'h1', origin: 'guide' }, 'x');
    expect(full).toMatchObject({ description: 'Faz coisas', suggestions: ['a'], home_project_id: 'h1', origin: 'guide' });
    const { description: _d, suggestions: _s, home_project_id: _h, origin: _o, ...old } = makeAgent();
    expect(api.checkAgent(old, 'x')).toMatchObject({ description: '', suggestions: [], home_project_id: null, origin: 'manual' });
    expect(() => api.checkAgent({ ...makeAgent(), suggestions: 'oi' }, 'x')).toThrow();
    expect(() => api.checkAgent({ ...makeAgent(), origin: 3 }, 'x')).toThrow();
  });

  it('parses project kind and agent_id, and the provider how', () => {
    expect(api.checkProject(makeProject({ kind: 'home', agent_id: 'lia' }), 'x')).toMatchObject({ kind: 'home', agent_id: 'lia' });
    const { kind: _k, agent_id: _a, ...old } = makeProject();
    expect(api.checkProject(old, 'x')).toMatchObject({ kind: 'project', agent_id: null });
    expect(() => api.checkProject({ ...makeProject(), kind: 'other' }, 'x')).toThrow();
    expect(api.checkProvider({ id: 'a', how: 'Abra o Ollama neste PC.' }, 'x').how).toBe('Abra o Ollama neste PC.');
    expect(api.checkProvider({ id: 'a' }, 'x').how).toBe('');
    expect(() => api.checkProvider({ id: 'a', how: 4 }, 'x')).toThrow();
  });
});
