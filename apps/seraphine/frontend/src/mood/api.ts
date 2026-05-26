import { API_BASE } from '../api';
import type { MoodToday, MoodTrend } from './types';

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
  return (await res.json()) as T;
}

export async function fetchMoodToday(): Promise<MoodToday> {
  return request<MoodToday>('/mood/today');
}

export async function fetchMoodTrend(days = 14): Promise<MoodTrend> {
  return request<MoodTrend>(`/mood/trend?days=${days}`);
}

export async function postMoodCheckin(
  label: string,
  valence?: number,
  arousal?: number,
): Promise<void> {
  const body: Record<string, unknown> = { label };
  if (valence !== undefined) body.valence = valence;
  if (arousal !== undefined) body.arousal = arousal;
  await request<unknown>('/mood/checkin', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
