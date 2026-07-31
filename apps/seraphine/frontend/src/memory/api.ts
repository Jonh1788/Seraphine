import { API_BASE } from '../api';
import type { Fact, MemoryProfile } from './types';

/**
 * Non-2xx response. The message is kept as the bare `HTTP <status>` string the
 * Memory screens already render, and `status` lets callers special-case 404.
 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** GET a JSON endpoint. Throws HttpError on non-2xx. */
async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as T;
}

/**
 * List remembered facts. `GET /memory/facts?limit=`
 *
 * Superseded facts are excluded by the backend default
 * (`include_superseded=false`).
 *
 * `q` is applied **client-side** over `text` — the endpoint has no search
 * parameter — mirroring the filtering the desktop view already does.
 */
export async function listFacts(params?: { limit?: number; q?: string }): Promise<Fact[]> {
  const search = new URLSearchParams();
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();

  const data = await request<Fact[]>(`/memory/facts${qs ? `?${qs}` : ''}`);
  const facts = Array.isArray(data) ? data : [];

  const q = params?.q?.trim().toLowerCase();
  if (!q) return facts;
  return facts.filter((f) => (f.text || '').toLowerCase().includes(q));
}

/**
 * The cached semantic profile. `GET /memory/profile`
 *
 * Returns `null` — not an error — when no profile exists yet: the endpoint
 * 404s (or answers with an empty envelope) until the first rebuild runs.
 */
export async function fetchProfile(): Promise<MemoryProfile | null> {
  try {
    const body = await request<{ profile?: MemoryProfile | null }>('/memory/profile');
    return body?.profile ?? null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}
