import { API_BASE } from '../api';
import type { Fact, FactSource, MemoryProfile } from './types';

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
 * The four values `store.py::Fact.source` accepts. **Not** the same set the
 * create endpoint validates — see `createFact`.
 */
const SOURCES: readonly string[] = ['explicit', 'reflection', 'user_taught', 'observation'];

/** What `POST /memory/facts` takes, mirroring `routes.py::FactCreate`. */
export interface NewFact {
  text: string;
  /** Defaults to `explicit`, like the backend and like the desktop panel. */
  source?: string;
  /** 0..1. Defaults to 1.0. `0` is a real value — see below. */
  confidence?: number;
}

/**
 * Teach the backend a fact. `POST /memory/facts` → 201
 *
 * THE THREE THINGS THIS FUNCTION KNOWS SO CALLERS DON'T HAVE TO:
 *
 * 1. **`source` is validated here because the backend does NOT validate it on
 *    write, and DOES validate it on read.** `FactCreate.source` is a plain
 *    `str`; `store.add_fact` inserts it with `# type: ignore[arg-type]`. But
 *    `Fact.source` is a `Literal[...]`, and `list_facts` rebuilds every row
 *    through that model — so a single `POST {"source": "mobile"}` (201, no
 *    complaint) makes `GET /memory/facts` raise for the ENTIRE list, and the
 *    poisoned row can no longer be reached from any screen to be deleted.
 *    A caller cannot be expected to know that; the layer refuses up front.
 *
 * 2. **`confidence` is range-checked here** because `Field(ge=0, le=1)` answers
 *    422 and this module surfaces it as a bare `HTTP 422` — a message that says
 *    nothing about which field was wrong.
 *
 * 3. **The text is trimmed and a blank one is refused**, because the backend
 *    only asks for `min_length=1`: `" "` would be stored as a fact that says
 *    nothing, and every screen would render a blank row for it forever.
 *
 * NOT handled here, on purpose: **deduplication**. `learn_fact` has none —
 * unlike the reflection path, which merges and supersedes — so teaching the
 * same sentence twice leaves two active facts. Deduping from the client would
 * mean listing before every write and would still race two devices; it belongs
 * to the backend. Recorded as a backend follow-up.
 */
export async function createFact(body: NewFact): Promise<Fact> {
  const text = body.text.trim();
  if (!text) throw new Error('A lembrança está vazia — escreva alguma coisa antes de salvar.');

  const source = body.source ?? 'explicit';
  if (!SOURCES.includes(source)) {
    throw new Error(`source inválido: "${source}". O backend só lê de volta ${SOURCES.join(', ')}.`);
  }

  // `??`, nunca `||`: `0` é "não confio nada nisso", que é diferente de "não
  // informei". A mesma confusão já custou o teto de orçamento zero.
  const confidence = body.confidence ?? 1.0;
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new Error(`confiança fora de 0..1: ${confidence}.`);
  }

  const res = await fetch(`${API_BASE}/memory/facts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source: source as FactSource, confidence }),
  });
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as Fact;
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
