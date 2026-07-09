import { API_BASE } from '../api';

/* ------------------------------------------------------------------ */
/*  Learning loop — GET/POST /learning/*                               */
/*                                                                     */
/*  The backend self-improvement loop proposes "candidate" policies    */
/*  (a behavior addendum, tool guidance, and knob overrides) scored    */
/*  against a baseline. Promotion to production is HUMAN-GATED here.    */
/* ------------------------------------------------------------------ */

export interface ActivePolicy {
  version: number;
  behavior_addendum: string;
  tool_guidance: string;
  knobs: Record<string, unknown>;
}

export interface Candidate {
  id: string;
  ts: string;
  behavior_addendum: string;
  tool_guidance: string;
  knobs: Record<string, unknown>;
  baseline_score: number;
  candidate_score: number;
  status: string;
  rationale: string;
  base_version: number;
}

export interface LearningTrace {
  id: string;
  ts: string;
  user_msg: string;
  assistant_msg: string;
  tools_json: string;
  feature: string;
  signal: number | null;
}

export interface Knob {
  name: string;
  kind: string;
  default: unknown;
  lo: number | null;
  hi: number | null;
  description: string;
}

export interface CycleSummary {
  candidate_id?: string;
  status: string;
  // Skip results (skipped_no_new / skipped_low_evidence) omit these — the gate
  // returned before proposing/evaluating a candidate.
  baseline_score?: number;
  candidate_score?: number;
  passed?: boolean;
  rationale?: string;
}

/** Currently-promoted policy (version 0 = default, no overrides). */
export async function fetchActivePolicy(): Promise<ActivePolicy> {
  const res = await fetch(`${API_BASE}/learning/active`);
  if (!res.ok) throw new Error(`fetchActivePolicy: HTTP ${res.status}`);
  return res.json();
}

/** Proposed candidates, optionally filtered by status (e.g. "pending"). */
export async function fetchCandidates(status?: string): Promise<Candidate[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${API_BASE}/learning/candidates${qs}`);
  if (!res.ok) throw new Error(`fetchCandidates: HTTP ${res.status}`);
  return res.json();
}

/** A single candidate by id. */
export async function fetchCandidate(id: string): Promise<Candidate> {
  const res = await fetch(`${API_BASE}/learning/candidates/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetchCandidate: HTTP ${res.status}`);
  return res.json();
}

/** Recent learning traces (user→assistant pairs with a thumbs signal). */
export async function fetchLearningTraces(limit = 20): Promise<LearningTrace[]> {
  const res = await fetch(`${API_BASE}/learning/traces?limit=${limit}`);
  if (!res.ok) throw new Error(`fetchLearningTraces: HTTP ${res.status}`);
  return res.json();
}

/** Tunable knobs and their bounds/defaults. */
export async function fetchKnobs(): Promise<Knob[]> {
  const res = await fetch(`${API_BASE}/learning/knobs`);
  if (!res.ok) throw new Error(`fetchKnobs: HTTP ${res.status}`);
  return res.json();
}

/** Promote a candidate to production. Returns the new active version. */
export async function promoteCandidate(id: string): Promise<{ version: number }> {
  const res = await fetch(`${API_BASE}/learning/candidates/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`promoteCandidate: HTTP ${res.status}`);
  return res.json();
}

/** Reject a candidate (it leaves the pending list). */
export async function rejectCandidate(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/learning/candidates/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`rejectCandidate: HTTP ${res.status}`);
  return res.json();
}

/** Run a learning cycle now (instead of waiting for the 03:30 nightly job). */
export async function runLearningCycle(): Promise<CycleSummary> {
  const res = await fetch(`${API_BASE}/learning/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`runLearningCycle: HTTP ${res.status}`);
  return res.json();
}
