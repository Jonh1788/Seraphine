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

describe('updateTask', () => {
  it('PATCHes only the keys it was given', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await api.updateTask(TASK, { title: 'Pagar o aluguel' });
    const { url, init } = lastCall();
    expect(url).toMatch(/\/tasks\/7$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Pagar o aluguel' });
  });

  it('carries the current category along when the patch touches tags', async () => {
    // THE ONE THIS FUNCTION EXISTS FOR. `update_task` (service.py:846) ends with
    // `elif tags is not None: category = _derive_task_category(tags_json, None)`
    // — a tags-only patch REWRITES the category from the tags. The task is
    // filed under `contas`; adding the tag "trabalho" would silently refile it
    // while the screen keeps showing `contas`.
    mockFetch(jsonResponse({ ok: true }));
    await api.updateTask(TASK, { tags: ['trabalho'] });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      tags: ['trabalho'],
      category: 'contas',
    });
  });

  it('does NOT invent a category when the task has none — the backend derives', async () => {
    // The guard preserves a CHOICE; it does not veto the feature. With nothing
    // chosen, sending `''` would order a clear and kill the derivation.
    mockFetch(jsonResponse({ ok: true }), jsonResponse({ ok: true }));
    await api.updateTask({ id: 7, category: null }, { tags: ['casa'] });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ tags: ['casa'] });
    await api.updateTask({ id: 7, category: '' }, { tags: ['casa'] });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ tags: ['casa'] });
  });

  it('never overrides a category the caller stated — including an explicit clear', async () => {
    mockFetch(jsonResponse({ ok: true }), jsonResponse({ ok: true }));
    await api.updateTask(TASK, { tags: ['x'], category: 'moradia' });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      tags: ['x'],
      category: 'moradia',
    });
    // `null` is "clear it", not "I said nothing": it survives JSON.stringify
    // and the backend reads it as an order.
    await api.updateTask(TASK, { tags: ['x'], category: null });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ tags: ['x'], category: null });
  });

  it('protects the category even when the key is present but undefined', async () => {
    // The case that separates `body.category === undefined` from
    // `'category' in body`: JSON.stringify DROPS an undefined value, so this
    // reaches the backend as a tags-only patch — exactly the one that derives
    // the category away. `in` would have called it "stated" and stood down.
    mockFetch(jsonResponse({ ok: true }));
    await api.updateTask(TASK, { tags: ['x'], category: undefined });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ tags: ['x'], category: 'contas' });
  });

  it('the same reading applies to tags: an undefined tags key is not a tags patch', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await api.updateTask(TASK, { title: 'x', tags: undefined });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ title: 'x' });
  });

  it('leaves a patch without tags alone, category or not', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await api.updateTask(TASK, { status: 'completed', priority: '' });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      status: 'completed',
      priority: '',
    });
  });

  it('refuses the empty patch without touching the network', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await expect(api.updateTask(TASK, {})).rejects.toThrow(/sem nenhum campo/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects with the backend detail on HTTP 422', async () => {
    mockFetch(jsonResponse({ detail: 'priority must be one of [...]' }, 422));
    await expect(api.updateTask(TASK, { priority: 'urgentissima' })).rejects.toThrow(
      'priority must be one of [...]',
    );
  });
});

describe('deleteTask', () => {
  it('DELETEs /tasks/{id}', async () => {
    mockFetch(jsonResponse({ ok: true }));
    await api.deleteTask(7);
    const { url, init } = lastCall();
    expect(url).toMatch(/\/tasks\/7$/);
    expect(init?.method).toBe('DELETE');
  });

  it('rejects with the backend detail when the row is already gone', async () => {
    mockFetch(jsonResponse({ detail: 'task not found' }, 404));
    await expect(api.deleteTask(9999)).rejects.toThrow('task not found');
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
