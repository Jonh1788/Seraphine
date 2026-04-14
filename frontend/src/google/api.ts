// Thin REST client for the backend's Google Workspace routes.
// Same-origin — Vite proxies /google/* to the backend.

import type {
  Calendar,
  CalendarEvent,
  EmailFull,
  EmailMessage,
  GoogleAuthStatus,
} from './types';

const API_BASE = '';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Format a Date as YYYY-MM-DD in the user's local timezone. */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function getAuthStatus(): Promise<GoogleAuthStatus> {
  const res = await fetch(`${API_BASE}/google/oauth/status`);
  return json<GoogleAuthStatus>(res);
}

export async function startOAuth(): Promise<{ consent_url: string }> {
  const res = await fetch(`${API_BASE}/google/oauth/start`, { method: 'POST' });
  return json<{ consent_url: string }>(res);
}

export async function logoutGoogle(): Promise<void> {
  const res = await fetch(`${API_BASE}/google/oauth/logout`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    from: toIsoDate(from),
    to: toIsoDate(to),
  });
  const res = await fetch(`${API_BASE}/google/calendar/events?${params.toString()}`);
  return json<CalendarEvent[]>(res);
}

export async function listCalendars(): Promise<Calendar[]> {
  const res = await fetch(`${API_BASE}/google/calendar/calendars`);
  return json<Calendar[]>(res);
}

export async function listImportantEmails(limit = 20): Promise<EmailMessage[]> {
  const res = await fetch(`${API_BASE}/google/gmail/important?limit=${limit}`);
  return json<EmailMessage[]>(res);
}

export async function getEmail(id: string): Promise<EmailFull> {
  const res = await fetch(`${API_BASE}/google/gmail/messages/${encodeURIComponent(id)}`);
  return json<EmailFull>(res);
}

export async function markEmailAsRead(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/google/gmail/messages/${encodeURIComponent(id)}/mark-read`,
    { method: 'POST' },
  );
  if (!res.ok) {
    // Prefer the backend's PT-BR `detail` over a bare HTTP status — the
    // route surfaces scope/reauth hints there (e.g. "permissao
    // insuficiente — reconecte o Google em /google/oauth/start").
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Response wasn't JSON — fall back to status below.
    }
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
}
