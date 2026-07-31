import { API_BASE } from '../api';
import type { AggregateDay, AggregateResponse, Task, TasksByRangeResponse } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      // Only on bodied requests: a JSON Content-Type on a plain GET is not
      // CORS-safelisted and would add a preflight the old inline fetch
      // never paid for.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

/**
 * Per-day aggregate (tasks, habits, health, water, mood, focus, journal,
 * events + server-side score) for the inclusive range [start, end].
 * Dates are YYYY-MM-DD. The backend caps the range at 100 days.
 */
export async function fetchAggregate(start: string, end: string): Promise<AggregateDay[]> {
  const params = new URLSearchParams({ start, end });
  const data = await request<AggregateResponse>(`/calendar/aggregate?${params.toString()}`);
  return Array.isArray(data?.days) ? data.days : [];
}

/** Tasks whose due_date falls in the inclusive range [start, end] (YYYY-MM-DD). */
export async function fetchTasksByRange(start: string, end: string): Promise<Task[]> {
  const params = new URLSearchParams({ start, end });
  const data = await request<TasksByRangeResponse>(`/tasks/by-date-range?${params.toString()}`);
  return Array.isArray(data?.tasks) ? data.tasks : [];
}
