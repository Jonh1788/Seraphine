import { API_BASE } from '../api';
import type { DailyPlan, PlanHistoryEntry } from './types';

export async function fetchPlan(): Promise<DailyPlan> {
  const res = await fetch(`${API_BASE}/planning/today`);
  if (!res.ok) throw new Error(`fetchPlan: HTTP ${res.status}`);
  return res.json();
}

export async function acceptPlan(): Promise<{
  ok: boolean;
  calendar_events_created: number;
  event_ids: string[];
}> {
  const res = await fetch(`${API_BASE}/planning/accept`, { method: 'POST' });
  if (!res.ok) throw new Error(`acceptPlan: HTTP ${res.status}`);
  return res.json();
}

export async function updateBlock(
  blockId: string,
  patch: { start?: string; end?: string; title?: string; type?: string },
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/planning/blocks/${blockId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateBlock: HTTP ${res.status}`);
  return res.json();
}

export async function recordFeedback(
  blocksExecuted: number,
  tasksDone: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/planning/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks_executed: blocksExecuted,
      tasks_done: tasksDone,
    }),
  });
  if (!res.ok) throw new Error(`recordFeedback: HTTP ${res.status}`);
  return res.json();
}

export async function fetchHistory(days: number = 7): Promise<PlanHistoryEntry[]> {
  const res = await fetch(`${API_BASE}/planning/history?days=${days}`);
  if (!res.ok) throw new Error(`fetchHistory: HTTP ${res.status}`);
  return res.json();
}
