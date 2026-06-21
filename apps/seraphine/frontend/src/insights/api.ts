import { API_BASE } from '../api';
import type {
  FocusStats,
  Insight,
  InsightDismissResponse,
  InsightsListResponse,
  TimeByCategoryResponse,
  WeeklyReport,
  WeeklyReportEnvelope,
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

export async function listInsights(): Promise<Insight[]> {
  const data = await request<InsightsListResponse>('/insights');
  return Array.isArray(data?.insights) ? data!.insights : [];
}

export async function refreshInsights(): Promise<Insight[]> {
  const data = await request<InsightsListResponse>('/insights/refresh', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return Array.isArray(data?.insights) ? data!.insights : [];
}

export async function dismissInsight(id: string): Promise<InsightDismissResponse> {
  const data = await request<InsightDismissResponse>(
    `/insights/${encodeURIComponent(id)}/dismiss`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!data) throw new Error('Empty response from /insights/dismiss');
  return data;
}

export async function getWeeklyReport(): Promise<WeeklyReport | null> {
  const data = await request<WeeklyReportEnvelope>('/insights/weekly-report');
  return data?.report ?? null;
}

export async function generateWeeklyReport(): Promise<WeeklyReport | null> {
  const data = await request<WeeklyReportEnvelope>(
    '/insights/weekly-report/generate',
    { method: 'POST', body: JSON.stringify({}) },
  );
  return data?.report ?? null;
}

// GET /focus/stats returns the bare ``FocusStats.to_dict()`` (no envelope).
// ``period`` is 'week' (last 7 days) or 'month' (calendar month-to-date).
export async function getFocusStats(
  period: 'week' | 'month' = 'week',
): Promise<FocusStats | null> {
  const data = await request<FocusStats>(
    `/focus/stats?period=${encodeURIComponent(period)}`,
  );
  return data ?? null;
}

// GET /insights/time-by-category — focus minutes summed by category.
// Backs the "Onde foi seu tempo" breakdown card.
export async function getTimeByCategory(
  period: 'week' | 'month' = 'week',
): Promise<TimeByCategoryResponse | null> {
  const data = await request<TimeByCategoryResponse>(
    `/insights/time-by-category?period=${encodeURIComponent(period)}`,
  );
  return data ?? null;
}
