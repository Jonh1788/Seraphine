import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from '../../api';
import * as api from '../api';

/** Build a realistic Response-like object (headers included — code under test
 *  must never blow up on a missing `headers`, and neither must these mocks). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, status)));
}

function lastUrl(): string {
  const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls[calls.length - 1][0]);
}

const ENTRY = {
  id: 1,
  type: 'expense' as const,
  amount: 42.5,
  category: 'alimentacao',
  description: 'Almoço',
  date: '2026-07-15',
  source: 'chat',
  status: 'confirmed',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('listEntries', () => {
  it('unwraps the { entries } envelope', async () => {
    mockFetch({ entries: [ENTRY] });
    await expect(api.listEntries({})).resolves.toEqual([ENTRY]);
  });

  it('hits /finance/entries with no query when given no params', async () => {
    mockFetch({ entries: [] });
    await api.listEntries({});
    expect(lastUrl()).toBe(`${API_BASE}/finance/entries`);
  });

  it('sends the month exactly as given (1-indexed, no derivation)', async () => {
    mockFetch({ entries: [] });
    await api.listEntries({ month: 7, year: 2026 });
    expect(lastUrl()).toBe(`${API_BASE}/finance/entries?month=7&year=2026`);
  });

  it('forwards status and limit', async () => {
    mockFetch({ entries: [] });
    await api.listEntries({ status: 'pending_review' });
    expect(lastUrl()).toBe(`${API_BASE}/finance/entries?status=pending_review`);

    await api.listEntries({ status: 'confirmed', limit: 100 });
    expect(lastUrl()).toBe(`${API_BASE}/finance/entries?status=confirmed&limit=100`);
  });

  it('returns [] when the envelope has no entries key', async () => {
    mockFetch({});
    await expect(api.listEntries({})).resolves.toEqual([]);
  });

  it('throws HTTP <status> on a non-ok response', async () => {
    mockFetch({ detail: 'boom' }, 500);
    await expect(api.listEntries({})).rejects.toThrow('HTTP 500');
  });
});

describe('fetchSummary', () => {
  it('GETs /finance/summary with a 1-indexed month, verbatim', async () => {
    mockFetch({ income: 0, expenses: 0, balance: 0, by_category: [] });
    // January must be 1 on the wire, not 0 and not 2.
    await api.fetchSummary(1, 2026);
    expect(lastUrl()).toBe(`${API_BASE}/finance/summary?month=1&year=2026`);

    await api.fetchSummary(12, 2026);
    expect(lastUrl()).toBe(`${API_BASE}/finance/summary?month=12&year=2026`);
  });

  it('returns the summary body untouched (signs preserved)', async () => {
    const summary = {
      income: 5000,
      expenses: 5200.75,
      balance: -200.75,
      by_category: [{ category: 'moradia', total: 3000, count: 2 }],
    };
    mockFetch(summary);
    await expect(api.fetchSummary(7, 2026)).resolves.toEqual(summary);
  });

  it('throws HTTP <status> on a non-ok response', async () => {
    mockFetch({ detail: 'nope' }, 503);
    await expect(api.fetchSummary(7, 2026)).rejects.toThrow('HTTP 503');
  });
});

describe('fetchBalance', () => {
  it('GETs /finance/balance and returns the balance', async () => {
    mockFetch({ total_income: 10, total_expenses: 4, adjustment: 0, balance: 6 });
    const res = await api.fetchBalance();
    expect(lastUrl()).toBe(`${API_BASE}/finance/balance`);
    expect(res.balance).toBe(6);
  });

  it('preserves a negative balance', async () => {
    mockFetch({ total_income: 1, total_expenses: 4, adjustment: 0, balance: -3 });
    await expect(api.fetchBalance()).resolves.toMatchObject({ balance: -3 });
  });

  it('throws HTTP <status> on a non-ok response', async () => {
    mockFetch({ detail: 'nope' }, 500);
    await expect(api.fetchBalance()).rejects.toThrow('HTTP 500');
  });
});
