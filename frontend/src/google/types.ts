// Mirrors backend response shapes for the Google Workspace integration.
// See specs/006-google-integration.md.

export interface GoogleAuthStatus {
  authed: boolean;
  email: string | null;
  scopes: string[];
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
}

export interface CalendarEventDateTime {
  dateTime?: string; // RFC3339 timestamp
  date?: string;     // YYYY-MM-DD for all-day events
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  location?: string;
  attendees?: CalendarAttendee[];
  htmlLink?: string;
  description?: string;
  calendarId?: string;
  colorId?: string;
}

export interface Calendar {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string; // RFC3339 timestamp
  isUnread: boolean;
  isImportant: boolean;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size?: number;
}

export interface EmailFull {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  attachments?: EmailAttachment[];
}
