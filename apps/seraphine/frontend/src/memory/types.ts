/**
 * Types for the Memory module — mirrors the backend contract in
 * apps/seraphine/backend/seraphine/memory (store.py::Fact, routes.py).
 */

/** Backend `Literal` on seraphine/memory/store.py::Fact.source. */
export type FactSource = 'explicit' | 'reflection' | 'user_taught' | 'observation';

/**
 * A single remembered fact, exactly as `GET /memory/facts` returns it
 * (`Fact.model_dump()`).
 *
 * Note `id` is a uuid **string**, not a number, and `confidence` is always
 * present (backend `float`, no default null).
 */
export interface Fact {
  id: string;
  text: string;
  /** Widened from FactSource: legacy rows may carry sources we no longer emit. */
  source: string;
  /** 0..1 */
  confidence: number;
  created_at: string;
  /** Id of the fact that replaced this one; null while the fact is active. */
  superseded_by: string | null;
  /** Last time the fact was recalled/revalidated. Null until first recall. */
  last_used_at: string | null;
  /**
   * Server-derived category eyebrow (METAS / TRABALHO / ROTINA / PESSOAS /
   * LOCAL / PREFERENCIA / OUTROS). Persisted on the facts table; absent on
   * very old payloads that predate the column.
   */
  category?: string | null;
  /** 0/1 — pinned identity facts are always injected into context. */
  pinned?: number;
}

/** One section of the semantic profile (identity, preferences, …). */
export type ProfileSection = Record<string, unknown>;

/**
 * The cached semantic profile — the `profile` field of the
 * `GET /memory/profile` envelope. Every section is optional: the profile is
 * LLM-built and grows over time.
 */
export interface MemoryProfile {
  identity?: ProfileSection;
  preferences?: ProfileSection;
  work?: ProfileSection;
  contacts?: ProfileSection | unknown[];
  finances?: ProfileSection;
  health?: ProfileSection;
  goals?: unknown[];
  activity?: ProfileSection;
  [key: string]: unknown;
}
