import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import type { Task } from '../types';

/* Real `Response` objects (Node 22 global) so the api layer sees the same
   surface it gets in the browser — status/statusText/headers/json/text. A
   hand-rolled `{ ok, json }` literal would silently skip whatever the layer
   reads off the response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(...responses: Response[]): void {
  const fn = vi.fn();
  for (const res of responses) fn.mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', fn);
}

function lastCall(): { url: string; init: RequestInit | undefined } {
  const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const c = calls[calls.length - 1];
  return { url: String(c[0]), init: c[1] as RequestInit | undefined };
}

const TASK: Task = {
  id: 7,
  type: 'generic',
  status: 'pending',
  title: 'Pagar o boleto',
  description: 'vence sexta',
  source: 'chat',
  payload: {},
  created_at: '2026-07-30T10:00:00',
  due_date: '2026-08-01',
  category: 'contas',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('listTasks', () => {
  it('unwraps the { tasks } envelope of GET /tasks', async () => {
    mockFetch(jsonResponse({ tasks: [TASK] }));
    const tasks = await api.listTasks();
    expect(tasks).toEqual([TASK]);
    expect(lastCall().url).toMatch(/\/tasks$/);
  });

  it('forwards the limit as a query param', async () => {
    mockFetch(jsonResponse({ tasks: [] }));
    await api.listTasks({ limit: 200 });
    expect(lastCall().url).toContain('/tasks?limit=200');
  });

  it('returns [] when the envelope has no tasks array', async () => {
    mockFetch(jsonResponse({}));
    await expect(api.listTasks()).resolves.toEqual([]);
  });

  it('rejects on HTTP 500, surfacing the backend detail', async () => {
    mockFetch(jsonResponse({ detail: 'db offline' }, 500));
    await expect(api.listTasks()).rejects.toThrow('db offline');
  });

  it('rejects on HTTP 500 with a generic message when there is no detail', async () => {
    mockFetch(jsonResponse({}, 500));
    await expect(api.listTasks()).rejects.toThrow('Falha HTTP 500');
  });
});

describe('updateTaskStatus', () => {
  it('PATCHes /tasks/{id} with the status in the body', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await api.updateTaskStatus(7, 'completed');
    const { url, init } = lastCall();
    expect(url).toMatch(/\/tasks\/7$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'completed' });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('accepts the kanban statuses the desktop board uses', async () => {
    mockFetch(jsonResponse({ ok: true }), jsonResponse({ ok: true }));
    await api.updateTaskStatus(1, 'approved');
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ status: 'approved' });
    await api.updateTaskStatus(1, 'rejected');
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ status: 'rejected' });
  });

  it('rejects with the backend detail on HTTP 404', async () => {
    mockFetch(jsonResponse({ detail: 'task not found' }, 404));
    await expect(api.updateTaskStatus(9999, 'completed')).rejects.toThrow('task not found');
  });

  it('rejects with a generic message when the error body is not JSON', async () => {
    mockFetch(new Response('<html>502</html>', { status: 502 }));
    await expect(api.updateTaskStatus(7, 'pending')).rejects.toThrow('Falha HTTP 502');
  });
});

describe('createTask', () => {
  it('POSTs the payload to /tasks and returns the new id', async () => {
    mockFetch(jsonResponse({ id: 42, ok: true }));
    const created = await api.createTask({
      type: 'generic',
      title: 'Comprar cafe',
      description: '',
      source: 'chat',
      payload: { due_date: '2026-08-02' },
      due_date: '2026-08-02',
    });
    expect(created).toEqual({ id: 42, ok: true });
    const { url, init } = lastCall();
    expect(url).toMatch(/\/tasks$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'generic',
      title: 'Comprar cafe',
      description: '',
      source: 'chat',
      payload: { due_date: '2026-08-02' },
      due_date: '2026-08-02',
    });
  });

  it('rejects with the validation detail on HTTP 422', async () => {
    mockFetch(jsonResponse({ detail: 'type must be one of [...]' }, 422));
    await expect(
      api.createTask({ type: 'nope', title: 'x' }),
    ).rejects.toThrow('type must be one of [...]');
  });

  it('rejects when the response carries no id', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await expect(api.createTask({ type: 'generic', title: 'x' })).rejects.toThrow(
      /POST \/tasks/,
    );
  });
});
