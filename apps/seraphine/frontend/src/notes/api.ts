import { API_BASE } from '../api';
import type {
  Note,
  NoteCreateInput,
  NoteListResponse,
  NoteResponse,
  NoteUpdateInput,
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
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

export async function listNotes(q?: string, limit = 100): Promise<Note[]> {
  const params = new URLSearchParams();
  if (q && q.trim()) params.set('q', q.trim());
  params.set('limit', String(limit));
  const data = await request<NoteListResponse>(`/notes?${params.toString()}`);
  return Array.isArray(data.notes) ? data.notes : [];
}

export async function getNote(id: string): Promise<Note> {
  const data = await request<NoteResponse>(`/notes/${encodeURIComponent(id)}`);
  return data.note;
}

export async function createNote(body: NoteCreateInput): Promise<Note> {
  const data = await request<NoteResponse>('/notes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.note;
}

export async function updateNote(id: string, body: NoteUpdateInput): Promise<Note> {
  const data = await request<NoteResponse>(`/notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return data.note;
}

export async function deleteNote(id: string): Promise<void> {
  await request<void>(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
