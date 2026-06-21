import { API_BASE } from '../api';
import type {
  Goal,
  GoalCreateInput,
  GoalDetailResponse,
  GoalLink,
  GoalListResponse,
  GoalSummary,
  GoalUpdateInput,
  KeyResult,
  KRCreateInput,
  KRUpdateInput,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return (await res.json()) as T;
}

/* Goals CRUD */

export async function listGoals(
  area?: string,
  status?: string,
): Promise<Goal[]> {
  const params = new URLSearchParams();
  if (area) params.set('area', area);
  if (status) params.set('status', status);
  const qs = params.toString();
  const data = await request<GoalListResponse>(`/goals${qs ? `?${qs}` : ''}`);
  return Array.isArray(data?.goals) ? data!.goals : [];
}

export async function createGoal(body: GoalCreateInput): Promise<Goal> {
  // Backend wraps the payload: POST /goals -> { id, goal }.
  const res = await request<{ id: string; goal: Goal }>('/goals', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res?.goal) throw new Error('Empty response from POST /goals');
  return res.goal;
}

export async function getGoalDetail(id: string): Promise<GoalDetailResponse> {
  // Backend nests key_results/links INSIDE goal: GET /goals/:id -> { goal }.
  // They are omitted from goal.to_dict when empty, so default to [].
  const res = await request<{ goal: Goal }>(
    `/goals/${encodeURIComponent(id)}`,
  );
  if (!res?.goal) throw new Error('Empty response from GET /goals/:id');
  const g = res.goal;
  return {
    goal: g,
    key_results: g.key_results ?? [],
    links: g.links ?? [],
  };
}

export async function updateGoal(
  id: string,
  body: GoalUpdateInput,
): Promise<Goal> {
  // Backend wraps the payload: PATCH /goals/:id -> { goal }.
  const res = await request<{ goal: Goal }>(`/goals/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res?.goal) throw new Error('Empty response from PATCH /goals/:id');
  return res.goal;
}

export async function deleteGoal(id: string): Promise<void> {
  await request<void>(`/goals/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getGoalSummary(): Promise<GoalSummary> {
  const res = await request<GoalSummary>('/goals/summary');
  if (!res) throw new Error('Empty response from GET /goals/summary');
  return res;
}

/* Key Results */

export async function createKeyResult(
  goalId: string,
  body: KRCreateInput,
): Promise<KeyResult> {
  // Backend wraps the payload: POST .../key-results -> { key_result }.
  const res = await request<{ key_result: KeyResult }>(
    `/goals/${encodeURIComponent(goalId)}/key-results`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!res?.key_result) {
    throw new Error('Empty response from POST /goals/:id/key-results');
  }
  return res.key_result;
}

export async function updateKeyResult(
  goalId: string,
  krId: string,
  body: KRUpdateInput,
): Promise<KeyResult> {
  // Backend wraps the payload: PATCH .../key-results/:kr -> { key_result }.
  const res = await request<{ key_result: KeyResult }>(
    `/goals/${encodeURIComponent(goalId)}/key-results/${encodeURIComponent(krId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!res?.key_result) throw new Error('Empty response from PATCH key-result');
  return res.key_result;
}

/* Links */

export async function createGoalLink(
  goalId: string,
  linkedType: string,
  linkedId: string,
): Promise<GoalLink> {
  // Backend wraps the payload: POST .../links -> { link }.
  const res = await request<{ link: GoalLink }>(
    `/goals/${encodeURIComponent(goalId)}/links`,
    {
      method: 'POST',
      body: JSON.stringify({ linked_type: linkedType, linked_id: linkedId }),
    },
  );
  if (!res?.link) throw new Error('Empty response from POST /goals/:id/links');
  return res.link;
}

export async function deleteGoalLink(
  goalId: string,
  linkId: string,
): Promise<void> {
  await request<void>(
    `/goals/${encodeURIComponent(goalId)}/links/${encodeURIComponent(linkId)}`,
    { method: 'DELETE' },
  );
}
