import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFact, fetchProfile, listFacts } from '../api';

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

describe('createFact', () => {
  function body(spy: ReturnType<typeof vi.fn>, i = 0): Record<string, unknown> {
    return JSON.parse(String((spy.mock.calls[i][1] as RequestInit).body));
  }

  it('POSTs /memory/facts as JSON and returns the created fact', async () => {
    const spy = mockFetch(jsonResponse(FACT, { status: 201 }));

    const fact = await createFact({ text: 'Mora em São Paulo' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calledUrl(spy)).toContain('/memory/facts');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(fact).toEqual(FACT);
  });

  it('fills in the backend defaults so callers cannot drift from them', async () => {
    const spy = mockFetch(jsonResponse(FACT, { status: 201 }));

    await createFact({ text: 'Mora em São Paulo' });

    expect(body(spy)).toEqual({ text: 'Mora em São Paulo', source: 'explicit', confidence: 1 });
  });

  it('keeps confidence 0 — it is a real value, not "unset"', async () => {
    // `0 || 1.0` is 1.0. The same falsy-zero bug already cost this project a
    // budget ceiling and a provider-reported cost; a fact the user marked as
    // worthless must not be stored as certain.
    const spy = mockFetch(jsonResponse(FACT, { status: 201 }));

    await createFact({ text: 'talvez ele goste de jazz', confidence: 0 });

    expect(body(spy).confidence).toBe(0);
  });

  it('trims the text and refuses a blank one WITHOUT hitting the network', async () => {
    // The backend only asks for `min_length=1`, so " " would be stored as a
    // fact that says nothing — and every screen would then render a blank row.
    const spy = mockFetch(jsonResponse(FACT, { status: 201 }));

    await createFact({ text: '  Mora em São Paulo  ' });
    expect(body(spy).text).toBe('Mora em São Paulo');

    await expect(createFact({ text: '   ' })).rejects.toThrow(/vazi/i);
    await expect(createFact({ text: '' })).rejects.toThrow(/vazi/i);
    expect(spy).toHaveBeenCalledTimes(1); // só o primeiro
  });

  it('refuses a source outside the backend Literal WITHOUT hitting the network', async () => {
    // THE TRAP. `FactCreate.source` is a plain `str`, and `store.add_fact`
    // inserts it with `# type: ignore[arg-type]` — so POSTing source="mobile"
    // returns 201. But `Fact.source` IS a Literal, and `list_facts` rebuilds
    // every row through it: one bad write makes `GET /memory/facts` raise for
    // the WHOLE list. The poisoned row then cannot even be deleted from a
    // screen, because no screen can list it. Verified against the model.
    const spy = mockFetch(jsonResponse(FACT, { status: 201 }));

    await expect(createFact({ text: 'x', source: 'mobile' })).rejects.toThrow(/source/i);
    expect(spy).not.toHaveBeenCalled();

    // e os quatro válidos passam
    for (const source of ['explicit', 'reflection', 'user_taught', 'observation']) {
      await createFact({ text: 'x', source });
    }
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('refuses a confidence outside 0..1 WITHOUT hitting the network', async () => {
    // `Field(ge=0.0, le=1.0)` would answer 422, and the caller would only see
    // the bare "HTTP 422" this module throws — no clue about which field.
    const spy = mockFetch(jsonResponse(FACT, { status: 201 }));

    await expect(createFact({ text: 'x', confidence: 1.5 })).rejects.toThrow(/confian|confidence/i);
    await expect(createFact({ text: 'x', confidence: -0.1 })).rejects.toThrow(/confian|confidence/i);
    expect(spy).not.toHaveBeenCalled();

    // as bordas são válidas
    await createFact({ text: 'x', confidence: 0 });
    await createFact({ text: 'x', confidence: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rejects with the HTTP status when the backend fails', async () => {
    mockFetch(jsonResponse({ detail: 'boom' }, { status: 500 }));

    await expect(createFact({ text: 'Mora em São Paulo' })).rejects.toThrow('HTTP 500');
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
