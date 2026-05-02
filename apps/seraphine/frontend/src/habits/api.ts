import { API_BASE } from '../api';
import type {
  Habit,
  HabitCalendarResponse,
  HabitCreateInput,
  HabitListResponse,
  HabitStreaks,
  HabitToggleResponse,
  HabitUpdateInput,
  HabitWithStatus,
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
  // DELETE may return empty body.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return (await res.json()) as T;
}

export async function listHabits(): Promise<HabitWithStatus[]> {
  const data = await request<HabitListResponse>('/habits');
  return Array.isArray(data?.habits) ? data!.habits : [];
}

export async function createHabit(body: HabitCreateInput): Promise<Habit> {
  const res = await request<Habit>('/habits', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res) throw new Error('Empty response from POST /habits');
  return res;
}

export async function updateHabit(id: string, body: HabitUpdateInput): Promise<Habit> {
  const res = await request<Habit>(`/habits/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res) throw new Error('Empty response from PATCH /habits');
  return res;
}

export async function deleteHabit(id: string): Promise<void> {
  await request<void>(`/habits/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function toggleHabit(id: string, date?: string): Promise<HabitToggleResponse> {
  const res = await request<HabitToggleResponse>(`/habits/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    body: JSON.stringify(date ? { date } : {}),
  });
  if (!res) throw new Error('Empty response from POST /habits/toggle');
  return res;
}

export async function getStreaks(id: string): Promise<HabitStreaks> {
  const res = await request<HabitStreaks>(`/habits/${encodeURIComponent(id)}/streaks`);
  if (!res) throw new Error('Empty response from GET /habits/streaks');
  return res;
}

export async function getCalendar(
  id: string,
  month: number,
  year: number,
): Promise<HabitCalendarResponse> {
  const params = new URLSearchParams({ month: String(month), year: String(year) });
  const res = await request<HabitCalendarResponse>(
    `/habits/${encodeURIComponent(id)}/calendar?${params.toString()}`,
  );
  if (!res) throw new Error('Empty response from GET /habits/calendar');
  return res;
}
