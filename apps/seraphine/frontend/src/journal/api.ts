import { API_BASE } from '../api';
import type {
  JournalEntry,
  JournalCreateInput,
  JournalEntryEnvelope,
  JournalListResponse,
  JournalSearchResponse,
  JournalStats,
  JournalType,
  JournalUpdateInput,
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
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return (await res.json()) as T;
}

export interface FetchJournalParams {
  month?: number;
  year?: number;
  type?: JournalType;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function fetchJournalEntries(
  params: FetchJournalParams = {},
): Promise<{ entries: JournalEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.month != null) qs.set('month', String(params.month));
  if (params.year != null) qs.set('year', String(params.year));
  if (params.type) qs.set('type', params.type);
  if (params.q?.trim()) qs.set('q', params.q.trim());
  qs.set('limit', String(params.limit ?? 50));
  qs.set('offset', String(params.offset ?? 0));
  const data = await request<JournalListResponse>(`/journal?${qs.toString()}`);
  return {
    entries: Array.isArray(data?.entries) ? data!.entries : [],
    total: data?.total ?? 0,
  };
}

export async function fetchJournalEntry(id: string): Promise<JournalEntry> {
  // Backend wraps the entry as { "entry": {...} } (journal/routes.py).
  const data = await request<JournalEntryEnvelope>(`/journal/${encodeURIComponent(id)}`);
  if (!data?.entry) throw new Error('Empty response from GET /journal/:id');
  return data.entry;
}

export async function createJournalEntry(body: JournalCreateInput): Promise<JournalEntry> {
  // Backend wraps the entry as { "entry": {...} } (journal/routes.py).
  const data = await request<JournalEntryEnvelope>('/journal', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!data?.entry) throw new Error('Empty response from POST /journal');
  return data.entry;
}

export async function updateJournalEntry(
  id: string,
  body: JournalUpdateInput,
): Promise<JournalEntry> {
  // Backend wraps the entry as { "entry": {...} } (journal/routes.py).
  const data = await request<JournalEntryEnvelope>(`/journal/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!data?.entry) throw new Error('Empty response from PATCH /journal/:id');
  return data.entry;
}

export async function deleteJournalEntry(id: string): Promise<void> {
  await request<void>(`/journal/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchJournalStats(): Promise<JournalStats> {
  const data = await request<JournalStats>('/journal/stats');
  return {
    current_streak: data?.current_streak ?? 0,
    longest_streak: data?.longest_streak ?? 0,
    total_entries: data?.total_entries ?? 0,
    days_logged: data?.days_logged ?? 0,
  };
}

export async function searchJournal(q: string, limit = 10): Promise<JournalEntry[]> {
  const qs = new URLSearchParams();
  qs.set('q', q.trim());
  qs.set('limit', String(limit));
  const data = await request<JournalSearchResponse>(`/journal/search?${qs.toString()}`);
  return Array.isArray(data?.results) ? data!.results : [];
}
