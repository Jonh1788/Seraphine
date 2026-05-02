import { API_BASE } from '../api';
import type {
  WaterHistoryDay,
  WaterIntakeResponse,
  WaterProfile,
  WaterProfileInput,
  WaterToday,
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

/** Returns the profile, or `null` when the backend responds with 404 (not set). */
export async function getWaterProfile(): Promise<WaterProfile | null> {
  const res = await fetch(`${API_BASE}/water/profile`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as WaterProfile;
}

export async function saveWaterProfile(body: WaterProfileInput): Promise<WaterProfile> {
  const res = await request<WaterProfile>('/water/profile', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res) throw new Error('Empty response from /water/profile');
  return res;
}

export async function addWaterIntake(amount_ml: number): Promise<WaterIntakeResponse> {
  const res = await request<WaterIntakeResponse>('/water/intake', {
    method: 'POST',
    body: JSON.stringify({ amount_ml }),
  });
  if (!res) throw new Error('Empty response from /water/intake');
  return res;
}

export async function getWaterToday(): Promise<WaterToday> {
  const res = await request<WaterToday>('/water/today');
  if (!res) throw new Error('Empty response from /water/today');
  return res;
}

export async function getWaterHistory(days = 7): Promise<WaterHistoryDay[]> {
  const params = new URLSearchParams({ days: String(days) });
  const data = await request<{ days: WaterHistoryDay[] } | WaterHistoryDay[]>(
    `/water/history?${params.toString()}`,
  );
  if (!data) return [];
  // Backend may return either { days: [...] } or a bare array; normalise.
  if (Array.isArray(data)) return data;
  return Array.isArray(data.days) ? data.days : [];
}

export async function deleteWaterLog(id: number): Promise<void> {
  await request<void>(`/water/logs/${id}`, { method: 'DELETE' });
}
