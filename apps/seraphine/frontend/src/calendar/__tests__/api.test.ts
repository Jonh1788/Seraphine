import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';

/** A realistic ok Response stub (headers included — the code may read them). */
function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, statusText = 'Server Error') {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: async () => ({}),
    text: async () => 'boom',
  };
}

const DAY = {
  date: '2026-07-01',
  tasks: [{ id: 1, title: 'pagar conta', status: 'done' }],
  habits: [{ habit_id: 'h1', name: 'ler', completed: true }],
  health: { steps: 9000, sleep_minutes: 430, sleep_hours: 7.2, calories: 500, resting_hr: 58 },
  water: { intake_ml: 2000, goal_ml: 2500 },
  mood: { avg_valence: 0.7, predominant_label: 'feliz' },
  focus: { total_min: 90, sessions_count: 3 },
  journal: { count: 1 },
  events: [{ title: 'reuniao', start: '2026-07-01T10:00:00Z', end: '2026-07-01T11:00:00Z' }],
  score: 6,
};

const TASK = {
  id: 42,
  type: 'todo',
  status: 'pending',
  title: 'comprar pao',
  description: '',
  source: 'manual',
  payload: '{}',
  created_at: '2026-07-01T09:00:00Z',
  due_date: '2026-07-03',
};

function lastUrl(): string {
  const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls[calls.length - 1][0]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAggregate', () => {
  it('hits /calendar/aggregate with the start and end range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ days: [DAY] })));
    await api.fetchAggregate('2026-07-01', '2026-07-31');
    const url = lastUrl();
    expect(url).toContain('/calendar/aggregate');
    expect(url).toContain('start=2026-07-01');
    expect(url).toContain('end=2026-07-31');
  });

  it('unwraps the days array from the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ days: [DAY] })));
    const days = await api.fetchAggregate('2026-07-01', '2026-07-31');
    expect(days).toEqual([DAY]);
    expect(days[0].mood).toEqual({ avg_valence: 0.7, predominant_label: 'feliz' });
    expect(days[0].score).toBe(6);
  });

  it('returns an empty list when the envelope has no days array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})));
    await expect(api.fetchAggregate('2026-07-01', '2026-07-31')).resolves.toEqual([]);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500)));
    await expect(api.fetchAggregate('2026-07-01', '2026-07-31')).rejects.toThrow('HTTP 500');
  });
});

describe('fetchTasksByRange', () => {
  it('hits /tasks/by-date-range with the start and end range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ tasks: [TASK] })));
    await api.fetchTasksByRange('2026-07-01', '2026-07-31');
    const url = lastUrl();
    expect(url).toContain('/tasks/by-date-range');
    expect(url).toContain('start=2026-07-01');
    expect(url).toContain('end=2026-07-31');
  });

  it('unwraps the tasks array from the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ tasks: [TASK] })));
    const tasks = await api.fetchTasksByRange('2026-07-01', '2026-07-31');
    expect(tasks).toEqual([TASK]);
  });

  it('returns an empty list when the envelope has no tasks array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})));
    await expect(api.fetchTasksByRange('2026-07-01', '2026-07-31')).resolves.toEqual([]);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(422, 'Unprocessable Entity')));
    await expect(api.fetchTasksByRange('2026-07-01', '2026-07-31')).rejects.toThrow('HTTP 422');
  });
});
