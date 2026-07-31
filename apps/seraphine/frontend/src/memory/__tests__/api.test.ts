import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProfile, listFacts } from '../api';

/**
 * Build a realistic Response double. Real fetch responses always carry
 * `headers`, `status` and `text()` — a bare `{ ok, json }` stub can make an
 * implementation look like it works while it silently lands in the error path.
 */
function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): Response {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? (status >= 200 && status < 300);
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

function mockFetch(res: Response): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => res);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function calledUrl(spy: ReturnType<typeof vi.fn>, i = 0): string {
  return String(spy.mock.calls[i][0]);
}

const FACT = {
  id: 'f-1',
  text: 'Mora em São Paulo',
  source: 'reflection',
  confidence: 0.92,
  created_at: '2026-07-01T10:00:00Z',
  superseded_by: null,
  last_used_at: null,
  category: 'LOCAL',
  pinned: 1,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('listFacts', () => {
  it('GETs /memory/facts and returns the parsed facts', async () => {
    const spy = mockFetch(jsonResponse([FACT]));

    const facts = await listFacts();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calledUrl(spy)).toContain('/memory/facts');
    expect(facts).toEqual([FACT]);
    // id is a backend uuid string, not a number.
    expect(typeof facts[0].id).toBe('string');
    expect(facts[0].category).toBe('LOCAL');
    expect(facts[0].confidence).toBe(0.92);
  });

  it('sends limit as a query param when given (and omits it otherwise)', async () => {
    const withLimit = mockFetch(jsonResponse([]));
    await listFacts({ limit: 100 });
    expect(calledUrl(withLimit)).toContain('/memory/facts?limit=100');

    const noLimit = mockFetch(jsonResponse([]));
    await listFacts();
    expect(calledUrl(noLimit)).not.toContain('?');
  });

  it('filters by q client-side, case-insensitively', async () => {
    const other = { ...FACT, id: 'f-2', text: 'Prefere café sem açúcar' };
    mockFetch(jsonResponse([FACT, other]));

    const facts = await listFacts({ q: 'CAFÉ' });

    expect(facts.map((f) => f.id)).toEqual(['f-2']);
  });

  it('ignores a blank q', async () => {
    mockFetch(jsonResponse([FACT]));
    expect(await listFacts({ q: '   ' })).toHaveLength(1);
  });

  it('rejects with the HTTP status when the backend fails', async () => {
    mockFetch(jsonResponse({ detail: 'boom' }, { status: 500 }));

    await expect(listFacts()).rejects.toThrow('HTTP 500');
  });
});

describe('fetchProfile', () => {
  it('GETs /memory/profile and unwraps the profile envelope', async () => {
    const profile = { identity: { nome: 'Jonathan' }, goals: ['lançar a Seraphine'] };
    const spy = mockFetch(jsonResponse({ profile }));

    const result = await fetchProfile();

    expect(calledUrl(spy)).toContain('/memory/profile');
    expect(result).toEqual(profile);
  });

  it('returns null when the profile has not been built yet (404)', async () => {
    mockFetch(jsonResponse({ detail: 'Not Found' }, { status: 404 }));

    await expect(fetchProfile()).resolves.toBeNull();
  });

  it('returns null when the envelope carries no profile', async () => {
    mockFetch(jsonResponse({ profile: null }));

    await expect(fetchProfile()).resolves.toBeNull();
  });

  it('rejects with the HTTP status on other failures', async () => {
    mockFetch(jsonResponse({ detail: 'boom' }, { status: 503 }));

    await expect(fetchProfile()).rejects.toThrow('HTTP 503');
  });
});
