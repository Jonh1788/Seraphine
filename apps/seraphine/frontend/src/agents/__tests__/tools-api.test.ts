/** Step 3b (wire): the catalogue of tools, the grants of an agent and the `grants` field of agents. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TOKEN_HEADER, createAgent, getAgentGrants, getAgentTools, listAgents, resetToken, setAgentGrants, updateAgent } from '../api';
import { makeAgent, makeToolGroups } from './fixtures';

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

/** The agent as the backend sends it: no client-only defaults filled in. */
const wireAgent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...makeAgent(), ...over });

beforeEach(() => resetToken());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /agents/tools', () => {
  it('parses the catalogue: groups with their fields and the tools they contain', async () => {
    const seen = serve({ groups: makeToolGroups() });
    const groups = await getAgentTools();
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/tools', token: 'tok' });
    expect(groups).toEqual(makeToolGroups());
    expect(groups.map((g) => [g.id, g.default, g.sensitive])).toEqual([
      ['notes', 'read', false],
      ['wiki', 'read', false],
      ['memory', 'none', true],
    ]);
    expect(groups[1].tools.map((t) => t.read_only)).toEqual([true, true, true]);
  });

  it('accepts an empty catalogue', async () => {
    serve({ groups: [] });
    await expect(getAgentTools()).resolves.toEqual([]);
  });

  const broken: [string, (g: Record<string, any>[]) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['a group without id', (g) => delete g[0].id],
    ['a group without label', (g) => delete g[0].label],
    ['a group without description', (g) => delete g[0].description],
    ['a default that is not a level', (g) => (g[0].default = 'maybe')],
    ['a group without sensitive', (g) => delete g[2].sensitive],
    ['sensitive as text', (g) => (g[2].sensitive = 'yes')],
    ['a group without tools', (g) => delete g[0].tools],
    ['a tool without name', (g) => delete g[0].tools[0].name],
    ['a tool without label', (g) => delete g[0].tools[0].label],
    ['a tool without description', (g) => delete g[0].tools[0].description],
    ['a tool without read_only', (g) => delete g[0].tools[0].read_only],
  ];
  it.each(broken)('is strict: %s is a contract break', async (_name, damage) => {
    const groups = JSON.parse(JSON.stringify(makeToolGroups()));
    damage(groups);
    serve({ groups });
    const err = await getAgentTools().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toMatch(/Resposta inesperada do servidor em GET \/agents\/tools/);
  });

  it('rejects an answer that is not {"groups": [...]}', async () => {
    serve({ tools: [] });
    await expect(getAgentTools()).rejects.toBeInstanceOf(ApiError);
    serve({ groups: {} });
    await expect(getAgentTools()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('grants of an agent', () => {
  it('GET reads {grants} and PUT sends only what it is given', async () => {
    let seen = serve({ grants: { notes: 'read', wiki: 'read', memory: 'none' } });
    await expect(getAgentGrants('ag 1')).resolves.toEqual({ notes: 'read', wiki: 'read', memory: 'none' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/defs/ag%201/grants' });

    seen = serve({ grants: { notes: 'read', wiki: 'read', memory: 'read' } });
    await expect(setAgentGrants('ag1', { memory: 'read' })).resolves.toEqual({ notes: 'read', wiki: 'read', memory: 'read' });
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/defs/ag1/grants', body: { grants: { memory: 'read' } } });
  });

  it('rejects a level that is not none, read or write', async () => {
    serve({ grants: { notes: 'admin' } });
    await expect(getAgentGrants('ag1')).rejects.toBeInstanceOf(ApiError);
    serve({ grants: { notes: true } });
    await expect(getAgentGrants('ag1')).rejects.toBeInstanceOf(ApiError);
    serve({ grants: ['notes'] });
    await expect(getAgentGrants('ag1')).rejects.toBeInstanceOf(ApiError);
    serve({});
    await expect(getAgentGrants('ag1')).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps the status of a refusal (422) on the error', async () => {
    serve({ detail: 'Grupo desconhecido' }, 422);
    const err = await setAgentGrants('ag1', { nada: 'read' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
  });
});

describe('agents with and without the `grants` field', () => {
  it('keeps the grants an agent comes with, `write` included (step 3c)', async () => {
    serve({ defs: [wireAgent({ grants: { notes: 'read', wiki: 'none', memory: 'write' } })] });
    const [a] = await listAgents();
    expect(a.grants).toEqual({ notes: 'read', wiki: 'none', memory: 'write' });
  });

  it('defaults to an empty object when an older answer does not carry it', async () => {
    const old = wireAgent();
    delete old.grants;
    serve({ defs: [old] });
    const [a] = await listAgents();
    expect(a.grants).toEqual({});
    expect(a.name).toBe('Forja');
    serve({ def: old });
    await expect(createAgent(makeAgent())).resolves.toMatchObject({ grants: {} });
    serve({ def: old });
    await expect(updateAgent('ag1', { name: 'x' })).resolves.toMatchObject({ grants: {} });
  });

  it('rejects an agent whose grants hold anything but none, read or write', async () => {
    serve({ defs: [wireAgent({ grants: { notes: 'root' } })] });
    const err = await listAgents().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toMatch(/defs\[0\]/);
    serve({ defs: [wireAgent({ grants: 'read' })] });
    await expect(listAgents()).rejects.toBeInstanceOf(ApiError);
    serve({ def: wireAgent({ grants: { wiki: 1 } }) });
    await expect(updateAgent('ag1', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('does not send grants with the agent itself (they have their own route)', async () => {
    const seen = serve({ def: wireAgent() });
    const { id: _id, created_at: _c, updated_at: _u, grants: _g, ...input } = makeAgent();
    await createAgent(input);
    expect(seen[0].body).not.toHaveProperty('grants');
  });
});
