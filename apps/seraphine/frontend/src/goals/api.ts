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
  const res = await request<Goal>('/goals', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res) throw new Error('Empty response from POST /goals');
  return res;
}

export async function getGoalDetail(id: string): Promise<GoalDetailResponse> {
  const res = await request<GoalDetailResponse>(
    `/goals/${encodeURIComponent(id)}`,
  );
  if (!res) throw new Error('Empty response from GET /goals/:id');
  return res;
}

export async function updateGoal(
  id: string,
  body: GoalUpdateInput,
): Promise<Goal> {
  const res = await request<Goal>(`/goals/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res) throw new Error('Empty response from PATCH /goals/:id');
  return res;
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
  const res = await request<KeyResult>(
    `/goals/${encodeURIComponent(goalId)}/key-results`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!res) throw new Error('Empty response from POST /goals/:id/key-results');
  return res;
}

export async function updateKeyResult(
  goalId: string,
  krId: string,
  body: KRUpdateInput,
): Promise<KeyResult> {
  const res = await request<KeyResult>(
    `/goals/${encodeURIComponent(goalId)}/key-results/${encodeURIComponent(krId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!res) throw new Error('Empty response from PATCH key-result');
  return res;
}

/* Links */

export async function createGoalLink(
  goalId: string,
  linkedType: string,
  linkedId: string,
): Promise<GoalLink> {
  const res = await request<GoalLink>(
    `/goals/${encodeURIComponent(goalId)}/links`,
    {
      method: 'POST',
      body: JSON.stringify({ linked_type: linkedType, linked_id: linkedId }),
    },
  );
  if (!res) throw new Error('Empty response from POST /goals/:id/links');
  return res;
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
