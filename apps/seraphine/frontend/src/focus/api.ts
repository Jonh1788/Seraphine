import { API_BASE } from '../api';
import type { FocusSession, FocusStats, FocusAppEntry } from './types';

export async function logFocusSession(
  session: Omit<FocusSession, 'id'>,
): Promise<FocusSession> {
  const res = await fetch(`${API_BASE}/focus/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  });
  if (!res.ok) throw new Error(`logFocusSession: HTTP ${res.status}`);
  return res.json();
}

export async function fetchFocusSessions(
  start: string,
  end: string,
): Promise<FocusSession[]> {
  const params = new URLSearchParams({ start, end });
  const res = await fetch(`${API_BASE}/focus/sessions?${params}`);
  if (!res.ok) throw new Error(`fetchFocusSessions: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.sessions ?? [];
}

export async function fetchFocusStats(
  period: 'week' | 'month',
): Promise<FocusStats> {
  const res = await fetch(`${API_BASE}/focus/stats?period=${period}`);
  if (!res.ok) throw new Error(`fetchFocusStats: HTTP ${res.status}`);
  return res.json();
}

export async function fetchTopApps(
  start: string,
  end: string,
): Promise<FocusAppEntry[]> {
  const params = new URLSearchParams({ start, end });
  const res = await fetch(`${API_BASE}/focus/apps?${params}`);
  if (!res.ok) throw new Error(`fetchTopApps: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.apps ?? [];
}

export async function setFocusActive(active: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/focus/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (!res.ok) throw new Error(`setFocusActive: HTTP ${res.status}`);
}

export async function logAppUsage(
  sessionId: number,
  appName: string,
  startedAt: string,
  durationSec: number,
): Promise<void> {
  const res = await fetch(`${API_BASE}/focus/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      app_name: appName,
      started_at: startedAt,
      duration_sec: durationSec,
    }),
  });
  if (!res.ok) throw new Error(`logAppUsage: HTTP ${res.status}`);
}
