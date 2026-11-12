import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  HarnessDisabledError,
  TOKEN_HEADER,
  decideApproval,
  deleteAgent,
  getEngines,
  getOverview,
  getRun,
  listAgents,
  listProjects,
  listRunEvents,
  createProject,
  updateAgent,
  cancelRun,
  resetToken,
  runTask,
} from '../api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}


beforeEach(() => {
  resetToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bootstrap + header injection', () => {
  it('bootstraps once, sends the token on every other call and never stores it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/agents/bootstrap')) return jsonResponse({ token: 'secret-token' });
      if (url.endsWith('/agents/overview')) {
        return jsonResponse({ pending_approvals: [], active_runs: [], spend_today: [] });
      }
      if (url.endsWith('/agents/engines')) {
        return jsonResponse({ engines: [{ name: 'codex', available: true, reason: 'ok', can_act: true }] });
      }
      return jsonResponse({ projects: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await getOverview();
    await getEngines();
    await listProjects();

    const bootstraps = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/agents/bootstrap'));
    expect(bootstraps).toHaveLength(1);
    const bootstrapInit = (bootstraps[0] as unknown[])[1] as RequestInit | undefined;
    // POST (a browser sends no Origin on a same-origin GET); no token yet.
    expect(bootstrapInit?.method).toBe('POST');
    expect(JSON.stringify(bootstrapInit?.headers ?? {})).not.toContain(TOKEN_HEADER);

    const others = fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/agents/bootstrap'));
    expect(others).toHaveLength(3);
    for (const call of others) {
      expect(((call as unknown[])[1] as RequestInit).headers).toMatchObject({ [TOKEN_HEADER]: 'secret-token' });
    }

    expect(JSON.stringify({ ...localStorage })).not.toContain('secret-token');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('secret-token');
  });

  it('treats a failed bootstrap as the disabled state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'nope' }, 404)));
    await expect(getOverview()).rejects.toBeInstanceOf(HarnessDisabledError);
  });

  it('treats an unreachable bootstrap as the disabled state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await expect(getOverview()).rejects.toBeInstanceOf(HarnessDisabledError);
  });

  it('maps 404 "agents harness disabled" on any call to the disabled state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/bootstrap')
          ? jsonResponse({ token: 't' })
          : jsonResponse({ detail: 'agents harness disabled' }, 404),
      ),
    );
    await expect(listProjects()).rejects.toBeInstanceOf(HarnessDisabledError);
  });

  it('surfaces other errors with the backend detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/bootstrap') ? jsonResponse({ token: 't' }) : jsonResponse({ detail: 'pasta inválida' }, 422),
      ),
    );
    const err = await listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toBe('pasta inválida');
    expect((err as ApiError).status).toBe(422);
  });

  it('bootstraps again once when the token is rejected', async () => {
    let issued = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/bootstrap')) {
        issued += 1;
        return jsonResponse({ token: `t${issued}` });
      }
      const sent = (init?.headers as Record<string, string>)[TOKEN_HEADER];
      return sent === 't2' ? jsonResponse({ projects: [] }) : jsonResponse({ detail: 'bad token' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(listProjects()).resolves.toEqual([]);
    expect(issued).toBe(2);
  });
});

describe('response shape checks', () => {
  function serve(path: string, body: unknown, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/bootstrap') ? jsonResponse({ token: 't' }) : url.includes(path) ? jsonResponse(body, status) : jsonResponse({}, 500),
      ),
    );
  }

  it('throws a clear ApiError for a bare array where an envelope is expected (no silent empty list)', async () => {
    serve('/agents/projects', [{ id: 'p1' }]);
    const err = await listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toContain('GET /agents/projects');
    expect((err as ApiError).detail).toContain('"projects"');
  });

  it('throws when the envelope key is missing or has the wrong type', async () => {
    serve('/agents/defs', { agents: [] });
    await expect(listAgents()).rejects.toBeInstanceOf(ApiError);
    serve('/agents/engines', { engines: {} });
    await expect(getEngines()).rejects.toBeInstanceOf(ApiError);
    serve('/agents/runs/r1', { run: null });
    await expect(getRun('r1')).rejects.toBeInstanceOf(ApiError);
    serve('/agents/runs/r1/events', null);
    await expect(listRunEvents('r1')).rejects.toBeInstanceOf(ApiError);
  });

  it('requires every overview list, and an ok marker on delete', async () => {
    serve('/agents/overview', { pending_approvals: [], active_runs: [] });
    const err = await getOverview().catch((e: unknown) => e);
    expect((err as ApiError).detail).toContain('spend_today');
    serve('/agents/defs/ag1', {});
    await expect(deleteAgent('ag1')).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a non-JSON 200 as an unexpected response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/bootstrap') ? jsonResponse({ token: 't' }) : new Response('<html>', { status: 200 }))),
    );
    const err = await listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(200);
  });

  it('unwraps the envelopes', async () => {
    serve('/agents/projects', { projects: [{ id: 'p1' }] });
    await expect(listProjects()).resolves.toEqual([{ id: 'p1', kind: 'project', agent_id: null }]);
    serve('/agents/tasks/t1/run', { run: { id: 'r1' } });
    await expect(runTask('t1', 'ag1')).resolves.toEqual({
      id: 'r1',
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
    });
  });
});

describe('HTTP cache', () => {
  it('passes cache: no-store on the bootstrap and on every request (GET, POST, PATCH, DELETE)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/agents/bootstrap')) return jsonResponse({ token: 't' });
      if (url.endsWith('/agents/overview')) return jsonResponse({ pending_approvals: [], active_runs: [], spend_today: [] });
      if (url.endsWith('/agents/projects')) return jsonResponse({ project: {}, projects: [] });
      if (url.includes('/agents/defs/')) return jsonResponse(url.endsWith('x') ? { def: {}, ok: true } : { def: {}, ok: true });
      if (url.endsWith('/cancel')) return jsonResponse({ run: {} });
      if (url.includes('/events')) return jsonResponse({ events: [] });
      return jsonResponse({ ok: true, def: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    await getOverview();
    await listProjects();
    await createProject({ name: 'a', path: 'b', description: '' });
    await updateAgent('x', { name: 'n' });
    await deleteAgent('x');
    await cancelRun('r1');
    await listRunEvents('r1');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(8);
    for (const call of fetchMock.mock.calls) {
      expect(((call as unknown[])[1] as RequestInit).cache, String(call[0])).toBe('no-store');
    }
  });
});

describe('decide errors', () => {
  async function failWith(body: unknown): Promise<ApiError> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/agents/bootstrap') ? jsonResponse({ token: 't' }) : jsonResponse(body, 409),
      ),
    );
    return (await decideApproval('a1', 'approve', { digest: 'x' }).catch((e: unknown) => e)) as ApiError;
  }

  it('reads the machine code beside the text or inside it', async () => {
    const beside = await failWith({ detail: 'O pedido mudou', code: 'digest_mismatch' });
    expect(beside).toMatchObject({ status: 409, detail: 'O pedido mudou', code: 'digest_mismatch' });
    const inside = await failWith({ detail: { message: 'Expirou', code: 'approval_expired' } });
    expect(inside).toMatchObject({ status: 409, detail: 'Expirou', code: 'approval_expired' });
    const none = await failWith({ detail: 'aprovação já decidida' });
    expect(none).toMatchObject({ detail: 'aprovação já decidida', code: '' });
  });
});
