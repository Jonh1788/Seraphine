import { API_BASE } from '../api';
import type { AttachmentRef } from './types';

/** Upload a file to the staging store; returns its reference (id + meta). */
export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  // Multipart — let the browser set Content-Type with the boundary.
  const res = await fetch(`${API_BASE}/attachments`, { method: 'POST', body: fd });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as AttachmentRef;
}
