// Shared helpers for the Google Workspace UI — date formatting,
// color palette for event chips, sender parsing.

import type { CalendarEvent } from './types';

const PT_BR = 'pt-BR';

export const fmtMonthYear = new Intl.DateTimeFormat(PT_BR, {
  month: 'long',
  year: 'numeric',
});

export const fmtWeekdayLong = new Intl.DateTimeFormat(PT_BR, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export const fmtDayShort = new Intl.DateTimeFormat(PT_BR, {
  day: '2-digit',
  month: 'short',
});

export const fmtTime = new Intl.DateTimeFormat(PT_BR, {
  hour: '2-digit',
  minute: '2-digit',
});

/** Day-of-week headers for the month grid (Dom, Seg, ... Sab). */
export const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

/** Small palette for event chips. Deterministic hash from id. */
const CHIP_COLORS = [
  '#a78bfa', // accent purple
  '#60a5fa', // blue
  '#34d399', // green
  '#f472b6', // pink
  '#fbbf24', // amber
  '#22d3ee', // cyan
  '#f87171', // red
  '#c084fc', // violet
];

export function chipColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return CHIP_COLORS[h % CHIP_COLORS.length];
}

/** Returns true if both dates fall on the same calendar day (local tz). */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Returns the Date for the first day of the given month. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Returns the Date for the last day of the given month. */
export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * Returns the 42-cell (6x7) grid covering the given month. Includes
 * trailing days from the previous month and leading days from the next
 * so every row is full. Sunday-first.
 */
export function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay()); // back up to Sunday
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

/** Parse the start field of a CalendarEvent into a Date. */
export function eventStart(ev: CalendarEvent): Date {
  const raw = ev.start.dateTime ?? ev.start.date;
  if (!raw) return new Date(NaN);
  // YYYY-MM-DD (all-day) gets parsed as midnight UTC by the Date ctor,
  // which shifts the day in negative timezones. Force local-midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(raw);
}

export function eventEnd(ev: CalendarEvent): Date {
  const raw = ev.end.dateTime ?? ev.end.date;
  if (!raw) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(raw);
}

export function isAllDay(ev: CalendarEvent): boolean {
  return !ev.start.dateTime && !!ev.start.date;
}

/** Format an event's time range as "14:00 - 15:30" or "Dia inteiro". */
export function formatEventTimeRange(ev: CalendarEvent): string {
  if (isAllDay(ev)) return 'Dia inteiro';
  const s = eventStart(ev);
  const e = eventEnd(ev);
  if (Number.isNaN(s.getTime())) return '';
  if (Number.isNaN(e.getTime())) return fmtTime.format(s);
  return `${fmtTime.format(s)} - ${fmtTime.format(e)}`;
}

/** Group events by their start-day key (YYYY-MM-DD). */
export function groupEventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const d = eventStart(ev);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const list = map.get(key);
    if (list) list.push(ev);
    else map.set(key, [ev]);
  }
  // Sort each day by start time
  for (const list of map.values()) {
    list.sort((a, b) => eventStart(a).getTime() - eventStart(b).getTime());
  }
  return map;
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Parse a "Name <email@host>" header into its parts. */
export function parseSender(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  }
  return { name: raw.trim(), email: raw.trim() };
}

/**
 * Human-friendly date label for email rows: "hoje 14:30", "ontem 09:12",
 * "12 abr" for anything older.
 */
export function formatEmailDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const evDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (evDay.getTime() === today.getTime()) return `hoje ${fmtTime.format(d)}`;
  if (evDay.getTime() === yest.getTime()) return `ontem ${fmtTime.format(d)}`;
  return fmtDayShort.format(d);
}
