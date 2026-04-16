import { API_BASE } from '../api';
import type {
  Insight,
  InsightDismissResponse,
  InsightsListResponse,
  WeeklyReport,
  WeeklyReportEnvelope,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

export async function listInsights(): Promise<Insight[]> {
  const data = await request<InsightsListResponse>('/insights');
  return Array.isArray(data.insights) ? data.insights : [];
}

export async function refreshInsights(): Promise<Insight[]> {
  const data = await request<InsightsListResponse>('/insights/refresh', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return Array.isArray(data.insights) ? data.insights : [];
}

export async function dismissInsight(id: string): Promise<InsightDismissResponse> {
  return request<InsightDismissResponse>(
    `/insights/${encodeURIComponent(id)}/dismiss`,
    { method: 'POST', body: JSON.stringify({}) },
  );
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
