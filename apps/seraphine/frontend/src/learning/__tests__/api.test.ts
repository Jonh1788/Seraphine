import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as api from '../api';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

function lastCall(): { url: string; init: RequestInit | undefined } {
  const calls = (fetch as any).mock.calls;
  const c = calls[calls.length - 1];
  return { url: String(c[0]), init: c[1] };
}

describe('learning api', () => {
  it('fetchActivePolicy GETs /learning/active', async () => {
    await api.fetchActivePolicy();
    const { url, init } = lastCall();
    expect(url).toContain('/learning/active');
    expect(init).toBeUndefined();
  });

  it('fetchCandidates() hits /learning/candidates with no query', async () => {
    await api.fetchCandidates();
    expect(lastCall().url).toMatch(/\/learning\/candidates$/);
  });

  it('fetchCandidates("pending") appends ?status=pending', async () => {
    await api.fetchCandidates('pending');
    expect(lastCall().url).toContain('/learning/candidates?status=pending');
  });

  it('fetchLearningTraces forwards the limit', async () => {
    await api.fetchLearningTraces(15);
    expect(lastCall().url).toContain('/learning/traces?limit=15');
  });

  it('promoteCandidate encodes the id and POSTs to /promote', async () => {
    await api.promoteCandidate('a b');
    const { url, init } = lastCall();
    expect(url).toContain('/learning/candidates/a%20b/promote');
    expect(init?.method).toBe('POST');
  });

  it('rejectCandidate encodes the id and POSTs to /reject', async () => {
    await api.rejectCandidate('a b');
    const { url, init } = lastCall();
    expect(url).toContain('/learning/candidates/a%20b/reject');
    expect(init?.method).toBe('POST');
  });

  it('runLearningCycle POSTs to /learning/run', async () => {
    await api.runLearningCycle();
    const { url, init } = lastCall();
    expect(url).toContain('/learning/run');
    expect(init?.method).toBe('POST');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(api.fetchActivePolicy()).rejects.toThrow('HTTP 503');
  });
});
