import { request } from "./client";

export interface GoogleOAuthStatus {
  connected: boolean;
  email?: string | null;
  scopes?: string[];
}

/** Google Calendar event — shape from Google's API. We keep it loose
 *  since Aura is read-only over events; only the fields we touch are
 *  typed strictly. */
export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  colorId?: string;
  hangoutLink?: string;
  conferenceData?: unknown;
}

export interface CalendarEventsQuery {
  /** ISO datetime (inclusive). */
  from?: string;
  /** ISO datetime (exclusive). */
  to?: string;
  q?: string;
  limit?: number;
}

export function getOAuthStatus(): Promise<GoogleOAuthStatus> {
  return request<GoogleOAuthStatus>("/google/status");
}

/** Returns the URL the browser must navigate (or open in popup) to
 *  start the consent flow. Aura backend gives `consent_url`. */
export function startOAuth(): Promise<{ url: string }> {
  return request<{ consent_url: string }>("/google/connect", { method: "POST" })
    .then((r) => ({ url: r.consent_url }));
}

export function disconnectOAuth(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/google/disconnect", { method: "POST" });
}

export function listCalendarEvents(query: CalendarEventsQuery = {}): Promise<GoogleEvent[]> {
  return request<GoogleEvent[]>("/google/calendar/events", { query: { ...query } });
}

/** Convenience: returns the start as a Date if the event has one,
 *  whether dateTime or all-day date. */
export function eventStartDate(e: GoogleEvent): Date | null {
  if (e.start?.dateTime) return new Date(e.start.dateTime);
  if (e.start?.date) {
    const [y, m, d] = e.start.date.split("-").map(Number);
    if (y && m && d) return new Date(y, m - 1, d);
  }
  return null;
}

export function eventEndDate(e: GoogleEvent): Date | null {
  if (e.end?.dateTime) return new Date(e.end.dateTime);
  if (e.end?.date) {
    const [y, m, d] = e.end.date.split("-").map(Number);
    if (y && m && d) return new Date(y, m - 1, d);
  }
  return null;
}

export function isAllDay(e: GoogleEvent): boolean {
  return !!e.start?.date && !e.start?.dateTime;
}
