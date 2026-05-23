import { API_BASE } from '../api';
import type { Chat, JobDetail, JobSummary } from './types';

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

export async function listChats(): Promise<Chat[]> {
  const cached = sessionStorage.getItem('cv_triage:chats');
  if (cached) {
    try {
      const { ts, data } = JSON.parse(cached) as { ts: number; data: Chat[] };
      if (Date.now() - ts < 5 * 60_000) return data;
    } catch {
      /* corrupt cache — refetch */
    }
  }
  const data = await request<Chat[]>('/whatsapp/chats');
  const chats = Array.isArray(data) ? data : [];
  sessionStorage.setItem(
    'cv_triage:chats',
    JSON.stringify({ ts: Date.now(), data: chats }),
  );
  return chats;
}

export async function createJob(args: {
  zip: Uint8Array;
  rubric: string;
  target_chat_id: string;
  target_label: string;
}): Promise<{ job_id: number; turn_id: number }> {
  const fd = new FormData();
  // Cast to BlobPart: TS5.9 narrows Uint8Array's backing buffer as ArrayBufferLike
  // (could be SharedArrayBuffer), but the Blob ctor wants a definite ArrayBuffer.
  // The Tauri `zip_folder_pdfs` command produces a plain ArrayBuffer-backed array.
  fd.append(
    'zip',
    new Blob([args.zip as BlobPart], { type: 'application/zip' }),
    'cv.zip',
  );
  fd.append('rubric', args.rubric);
  fd.append('target_chat_id', args.target_chat_id);
  fd.append('target_label', args.target_label);
  // Multipart upload — let the browser set Content-Type (with boundary).
  const res = await fetch(`${API_BASE}/cv_triage/jobs`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`,
    );
  }
  return (await res.json()) as { job_id: number; turn_id: number };
}

export async function getJob(id: number): Promise<JobDetail> {
  const data = await request<JobDetail>(`/cv_triage/jobs/${id}`);
  if (!data) throw new Error(`Empty response from /cv_triage/jobs/${id}`);
  return data;
}

export async function listJobs(): Promise<JobSummary[]> {
  const data = await request<JobSummary[]>('/cv_triage/jobs');
  return Array.isArray(data) ? data : [];
}

export async function cancelJob(id: number): Promise<void> {
  await request<void>(`/cv_triage/jobs/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function resendJob(
  id: number,
  target_chat_id?: string,
): Promise<{ ok: boolean; media_sent: number; failed_ranks: number[] }> {
  const data = await request<{
    ok: boolean;
    media_sent: number;
    failed_ranks: number[];
  }>(`/cv_triage/jobs/${id}/resend`, {
    method: 'POST',
    body: JSON.stringify(target_chat_id ? { target_chat_id } : {}),
  });
  if (!data) throw new Error(`Empty response from /cv_triage/jobs/${id}/resend`);
  return data;
}
