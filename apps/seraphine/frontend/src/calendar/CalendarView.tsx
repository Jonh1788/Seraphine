import { useCallback, useEffect, useMemo, useState } from 'react';
import { listEvents } from '../google/api';
import type { CalendarEvent } from '../google/types';
import type { FinanceEntry, SeraphineTask } from '../finance/types';
import { API_BASE } from '../api';
import {
  WEEKDAY_LABELS,
  chipColor,
  dayKey,
  eventEnd,
  eventStart,
  groupEventsByDay,
  isAllDay,
  isSameDay,
  monthGrid,
} from '../google/utils';
import { ArrowLeftIcon, CalendarIcon, FinanceIcon, TasksIcon } from '../icons/Icons';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CalendarViewProps {
  onBack: () => void;
  onNavigateToTask?: (taskId: string) => void;
}

type ViewMode = 'month' | 'week' | 'day';
type FilterKey = 'agenda' | 'financas' | 'outros' | 'tarefas';

interface CalendarItem {
  key: string;          // unique render key
  category: FilterKey;  // which filter drives visibility
  // For time-positioned items:
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  color: string;
  // Optional decorations
  amount?: number;      // signed finance amount
  amountKind?: 'income' | 'expense';
  taskId?: string;      // set when this is a task item (clickable)
}

/* ------------------------------------------------------------------ */
/*  PT-BR formatters                                                   */
/* ------------------------------------------------------------------ */

const fmtMonthYear = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDayLong = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const WEEKDAY_LONG: string[] = [
  'domingo', 'segunda-feira', 'terca-feira',
  'quarta-feira', 'quinta-feira', 'sexta-feira', 'sabado',
];

/* ------------------------------------------------------------------ */
/*  Mock data (used when Google Calendar API is not available)          */
/* ------------------------------------------------------------------ */

const MOCK_EVENTS: CalendarEvent[] = [
  {
    id: 'mock-1',
    summary: 'Reuniao de equipe',
    start: { dateTime: '2026-04-14T10:00:00' },
    end: { dateTime: '2026-04-14T11:30:00' },
    calendarId: 'agenda',
  },
  {
    id: 'mock-2',
    summary: 'Almoco com cliente',
    start: { dateTime: '2026-04-15T12:00:00' },
    end: { dateTime: '2026-04-15T13:30:00' },
    calendarId: 'agenda',
  },
  {
    id: 'mock-3',
    summary: 'Pagamento aluguel',
    start: { date: '2026-04-10' },
    end: { date: '2026-04-10' },
    calendarId: 'financas',
  },
  {
    id: 'mock-4',
    summary: 'Salario',
    start: { date: '2026-04-05' },
    end: { date: '2026-04-05' },
    calendarId: 'financas',
  },
  {
    id: 'mock-5',
    summary: 'Dentista',
    start: { dateTime: '2026-04-18T14:00:00' },
    end: { dateTime: '2026-04-18T15:00:00' },
    calendarId: 'outros',
  },
  {
    id: 'mock-6',
    summary: 'Deploy v2.0',
    start: { dateTime: '2026-04-12T09:00:00' },
    end: { dateTime: '2026-04-12T10:00:00' },
    calendarId: 'agenda',
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const CATEGORY_COLORS: Record<FilterKey, string> = {
  agenda: '#a78bfa',
  financas: '#4ade80',
  outros: '#42a5f5',
  tarefas: '#fbbf24',
};

function eventColor(ev: CalendarEvent): string {
  const cat = (ev.calendarId ?? 'agenda') as FilterKey;
  return CATEGORY_COLORS[cat] ?? chipColor(ev.id);
}

function eventCategory(ev: CalendarEvent): FilterKey {
  const cat = ev.calendarId?.toLowerCase() ?? '';
  if (cat === 'financas') return 'financas';
  if (cat === 'outros') return 'outros';
  return 'agenda';
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setDate(d.getDate() - d.getDay()); // Sunday start
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(d.getDate() + n);
  return copy;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtBRLSigned(amount: number, kind: 'income' | 'expense'): string {
  const abs = Math.abs(amount).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
  return kind === 'income' ? `+${abs}` : `-${abs}`;
}

function parseIsoLocalDate(iso: string): Date {
  // YYYY-MM-DD in user's local tz.
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Build a CalendarItem from a Google CalendarEvent. */
function eventToItem(ev: CalendarEvent): CalendarItem {
  const s = eventStart(ev);
  const e = eventEnd(ev);
  return {
    key: `ev-${ev.id}`,
    category: eventCategory(ev),
    start: s,
    end: Number.isNaN(e.getTime()) ? s : e,
    allDay: isAllDay(ev),
    title: ev.summary || '(sem titulo)',
    color: eventColor(ev),
  };
}

function entryToItem(entry: FinanceEntry): CalendarItem {
  const d = parseIsoLocalDate(entry.date);
  return {
    key: `fin-${entry.id}`,
    category: 'financas',
    start: d,
    end: d,
    allDay: true,
    title: entry.description,
    color: entry.type === 'income' ? '#4ade80' : '#f87171',
    amount: entry.amount,
    amountKind: entry.type,
  };
}

function taskToItem(task: SeraphineTask): CalendarItem | null {
  if (!task.due_date) return null;
  const d = parseIsoLocalDate(task.due_date);
  // Anchor to 09:00 so hour-grid views show it in a sensible slot.
  d.setHours(9, 0, 0, 0);
  const end = new Date(d);
  end.setHours(10, 0, 0, 0);
  return {
    key: `task-${task.id}`,
    category: 'tarefas',
    start: d,
    end,
    allDay: true, // render as all-day on day/week, as a chip on month
    title: task.title,
    color: CATEGORY_COLORS.tarefas,
    taskId: String(task.id),
  };
}

/* ------------------------------------------------------------------ */
/*  MonthGrid                                                          */
/* ------------------------------------------------------------------ */

function MonthGrid({
  date,
  items,
  filters,
  onItemClick,
}: {
  date: Date;
  items: CalendarItem[];
  filters: Set<FilterKey>;
  onItemClick: (item: CalendarItem) => void;
}) {
  const cells = useMemo(() => monthGrid(date), [date]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of items) {
      if (!filters.has(it.category)) continue;
      const k = dayKey(it.start);
      const list = m.get(k);
      if (list) list.push(it);
      else m.set(k, [it]);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.start.getTime() - b.start.getTime());
    }
    return m;
  }, [items, filters]);
  const now = useMemo(() => new Date(), []);
  const viewMonth = date.getMonth();

  return (
    <div className="month-grid">
      {WEEKDAY_LABELS.map((label) => (
        <div key={label} className="month-grid__header">{label}</div>
      ))}
      {cells.map((cell) => {
        const otherMonth = cell.getMonth() !== viewMonth;
        const today = isSameDay(cell, now);
        const dayItems = byDay.get(dayKey(cell)) ?? [];
        const visible = dayItems.slice(0, 3);
        const extra = dayItems.length - visible.length;
        const classes = ['month-grid__day'];
        if (otherMonth) classes.push('month-grid__day--other');
        if (today) classes.push('month-grid__day--today');
        return (
          <div key={cell.toISOString()} className={classes.join(' ')}>
            <div className="month-grid__day-num">{cell.getDate()}</div>
            {visible.map((it) => (
              <div
                key={it.key}
                className={`month-grid__event${it.taskId ? ' month-grid__event--clickable' : ''}`}
                style={{ backgroundColor: `${it.color}22`, color: it.color }}
                title={it.title}
                onClick={it.taskId ? () => onItemClick(it) : undefined}
              >
                {it.category === 'tarefas' && (
                  <span className="calendar-item__badge">Tarefa</span>
                )}
                <span className="calendar-item__title">{it.title}</span>
                {it.amount != null && it.amountKind && (
                  <span
                    className={`calendar-item__amount calendar-item__amount--${it.amountKind}`}
                  >
                    {fmtBRLSigned(it.amount, it.amountKind)}
                  </span>
                )}
              </div>
            ))}
            {extra > 0 && (
              <div className="month-grid__event month-grid__event--more">
                +{extra} mais
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  HourGrid — shared by WeekView (per column) and DayView             */
/* ------------------------------------------------------------------ */

const HOUR_PX = 50;

function HourColumn({
  day,
  items,
  onItemClick,
}: {
  day: Date;
  items: CalendarItem[];
  onItemClick: (item: CalendarItem) => void;
}): JSX.Element {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const nonAllDay = items.filter((it) => !it.allDay && isSameDay(it.start, day));
  return (
    <>
      {hours.map((h) => {
        const cellEvents = nonAllDay.filter((it) => it.start.getHours() === h);
        const now = new Date();
        const today = isSameDay(day, now);
        return (
          <div
            key={`c-${day.toISOString()}-${h}`}
            className={`week-view__cell${today ? ' week-view__cell--today' : ''}`}
          >
            {cellEvents.map((it) => {
              const durationHours = Math.max(
                0.5,
                (it.end.getTime() - it.start.getTime()) / 3600000,
              );
              const topOffset = it.start.getMinutes() / 60;
              return (
                <div
                  key={it.key}
                  className={`week-view__event${it.taskId ? ' week-view__event--clickable' : ''}`}
                  style={{
                    top: `${topOffset * HOUR_PX}px`,
                    height: `${durationHours * HOUR_PX - 2}px`,
                    backgroundColor: `${it.color}22`,
                    borderLeft: `3px solid ${it.color}`,
                    color: it.color,
                  }}
                  title={`${it.title} (${fmtTime.format(it.start)} - ${fmtTime.format(it.end)})`}
                  onClick={it.taskId ? () => onItemClick(it) : undefined}
                >
                  {it.category === 'tarefas' && (
                    <span className="calendar-item__badge">Tarefa</span>
                  )}
                  <span className="week-view__event-title">{it.title}</span>
                  <span className="week-view__event-time">{fmtTime.format(it.start)}</span>
                  {it.amount != null && it.amountKind && (
                    <span
                      className={`calendar-item__amount calendar-item__amount--${it.amountKind}`}
                    >
                      {fmtBRLSigned(it.amount, it.amountKind)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function AllDayRow({
  items,
  onItemClick,
}: {
  items: CalendarItem[];
  onItemClick: (item: CalendarItem) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="allday-row">
      {items.map((it) => (
        <div
          key={it.key}
          className={`allday-chip${it.taskId ? ' allday-chip--clickable' : ''}`}
          style={{ backgroundColor: `${it.color}22`, color: it.color, borderLeft: `3px solid ${it.color}` }}
          title={it.title}
          onClick={it.taskId ? () => onItemClick(it) : undefined}
        >
          {it.category === 'tarefas' && (
            <span className="calendar-item__badge">Tarefa</span>
          )}
          <span className="calendar-item__title">{it.title}</span>
          {it.amount != null && it.amountKind && (
            <span
              className={`calendar-item__amount calendar-item__amount--${it.amountKind}`}
            >
              {fmtBRLSigned(it.amount, it.amountKind)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  WeekView                                                           */
/* ------------------------------------------------------------------ */

function WeekView({
  date,
  items,
  filters,
  onItemClick,
}: {
  date: Date;
  items: CalendarItem[];
  filters: Set<FilterKey>;
  onItemClick: (item: CalendarItem) => void;
}) {
  const now = useMemo(() => new Date(), []);
  const weekStart = useMemo(() => startOfWeek(date), [date]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const filtered = useMemo(
    () => items.filter((it) => filters.has(it.category)),
    [items, filters],
  );

  const hours = Array.from({ length: 24 }, (_, i) => i);

  const allDayByDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of filtered) {
      if (!it.allDay) continue;
      const k = dayKey(it.start);
      const list = m.get(k);
      if (list) list.push(it);
      else m.set(k, [it]);
    }
    return m;
  }, [filtered]);

  return (
    <div className="week-view">
      {/* Corner cell */}
      <div className="week-view__corner" />
      {/* Day headers (with all-day row below each) */}
      {days.map((day) => {
        const today = isSameDay(day, now);
        const allDay = allDayByDay.get(dayKey(day)) ?? [];
        return (
          <div
            key={day.toISOString()}
            className={`week-view__header${today ? ' week-view__header--today' : ''}`}
          >
            <div className="week-view__day-name">{WEEKDAY_LONG[day.getDay()]}</div>
            <div className="week-view__day-num">{day.getDate()}</div>
            {allDay.length > 0 && (
              <AllDayRow items={allDay} onItemClick={onItemClick} />
            )}
          </div>
        );
      })}

      {/* Hour rows */}
      {hours.map((h) => (
        <>
          <div key={`h-${h}`} className="week-view__hour">{h}h</div>
          {days.map((day) => {
            const today = isSameDay(day, now);
            const cellEvents = filtered.filter((it) => {
              if (it.allDay) return false;
              return isSameDay(it.start, day) && it.start.getHours() === h;
            });
            return (
              <div
                key={`${day.toISOString()}-${h}`}
                className={`week-view__cell${today ? ' week-view__cell--today' : ''}`}
              >
                {cellEvents.map((it) => {
                  const durationHours = Math.max(
                    0.5,
                    (it.end.getTime() - it.start.getTime()) / 3600000,
                  );
                  const topOffset = it.start.getMinutes() / 60;
                  return (
                    <div
                      key={it.key}
                      className={`week-view__event${it.taskId ? ' week-view__event--clickable' : ''}`}
                      style={{
                        top: `${topOffset * HOUR_PX}px`,
                        height: `${durationHours * HOUR_PX - 2}px`,
                        backgroundColor: `${it.color}22`,
                        borderLeft: `3px solid ${it.color}`,
                        color: it.color,
                      }}
                      title={`${it.title} (${fmtTime.format(it.start)} - ${fmtTime.format(it.end)})`}
                      onClick={it.taskId ? () => onItemClick(it) : undefined}
                    >
                      {it.category === 'tarefas' && (
                        <span className="calendar-item__badge">Tarefa</span>
                      )}
                      <span className="week-view__event-title">{it.title}</span>
                      <span className="week-view__event-time">
                        {fmtTime.format(it.start)}
                      </span>
                      {it.amount != null && it.amountKind && (
                        <span
                          className={`calendar-item__amount calendar-item__amount--${it.amountKind}`}
                        >
                          {fmtBRLSigned(it.amount, it.amountKind)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DayView                                                            */
/* ------------------------------------------------------------------ */

function DayView({
  date,
  items,
  filters,
  onItemClick,
}: {
  date: Date;
  items: CalendarItem[];
  filters: Set<FilterKey>;
  onItemClick: (item: CalendarItem) => void;
}): JSX.Element {
  const filtered = useMemo(
    () => items.filter((it) => filters.has(it.category) && isSameDay(it.start, date)),
    [items, filters, date],
  );
  const allDay = filtered.filter((it) => it.allDay);
  const now = new Date();
  const today = isSameDay(date, now);

  return (
    <div className="day-view">
      <div className="day-view__header">
        {allDay.length > 0 && (
          <AllDayRow items={allDay} onItemClick={onItemClick} />
        )}
      </div>
      <div className={`day-view__grid${today ? ' day-view__grid--today' : ''}`}>
        <div className="day-view__hours">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`hr-${h}`} className="week-view__hour">{h}h</div>
          ))}
        </div>
        <div className="day-view__column">
          <HourColumn day={date} items={filtered} onItemClick={onItemClick} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CalendarView (main)                                                */
/* ------------------------------------------------------------------ */

export function CalendarView({ onBack, onNavigateToTask }: CalendarViewProps): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [financeEntries, setFinanceEntries] = useState<FinanceEntry[]>([]);
  const [tasks, setTasks] = useState<SeraphineTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Set<FilterKey>>(
    () => new Set(['agenda', 'financas', 'outros', 'tarefas']),
  );

  const now = useMemo(() => new Date(), []);

  // Compute the visible date range based on view mode
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (viewMode === 'month') {
      const cells = monthGrid(currentDate);
      return { rangeStart: cells[0], rangeEnd: cells[cells.length - 1] };
    }
    if (viewMode === 'week') {
      const ws = startOfWeek(currentDate);
      return { rangeStart: ws, rangeEnd: addDays(ws, 6) };
    }
    // day
    const d = new Date(currentDate);
    d.setHours(0, 0, 0, 0);
    return { rangeStart: d, rangeEnd: d };
  }, [viewMode, currentDate]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listEvents(rangeStart, rangeEnd);
      setEvents(list);
    } catch {
      // API unavailable — fall back to mock data
      setEvents(MOCK_EVENTS);
    } finally {
      setLoading(false);
    }
  }, [rangeStart, rangeEnd]);

  // Fetch finance entries for the visible range when the financas filter
  // is active. Each entry becomes an all-day calendar item with amount.
  const fetchFinance = useCallback(async () => {
    if (!filters.has('financas')) {
      setFinanceEntries([]);
      return;
    }
    try {
      // The /finance/entries endpoint filters by month+year; to cover a
      // multi-month range we request each month that intersects the view.
      const months = new Set<string>();
      const cursor = new Date(rangeStart);
      cursor.setDate(1);
      while (cursor <= rangeEnd) {
        months.add(`${cursor.getFullYear()}-${cursor.getMonth() + 1}`);
        cursor.setMonth(cursor.getMonth() + 1);
      }
      const results = await Promise.all(
        Array.from(months).map(async (ym) => {
          const [y, m] = ym.split('-').map(Number);
          const res = await fetch(
            `/finance/entries?year=${y}&month=${m}&limit=500`,
          );
          if (!res.ok) return [] as FinanceEntry[];
          const data = await res.json();
          return Array.isArray(data.entries) ? (data.entries as FinanceEntry[]) : [];
        }),
      );
      // Merge + dedupe by id.
      const seen = new Set<number>();
      const merged: FinanceEntry[] = [];
      for (const list of results) {
        for (const e of list) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          merged.push(e);
        }
      }
      setFinanceEntries(merged);
    } catch {
      setFinanceEntries([]);
    }
  }, [filters, rangeStart, rangeEnd]);

  // Fetch tasks with due_date in range when tarefas filter is active.
  const fetchTasks = useCallback(async () => {
    if (!filters.has('tarefas')) {
      setTasks([]);
      return;
    }
    try {
      const params = new URLSearchParams({
        start: toIsoDate(rangeStart),
        end: toIsoDate(rangeEnd),
      });
      const res = await fetch(`${API_BASE}/tasks/by-date-range?${params.toString()}`);
      if (!res.ok) {
        setTasks([]);
        return;
      }
      const data = await res.json();
      setTasks(Array.isArray(data.tasks) ? (data.tasks as SeraphineTask[]) : []);
    } catch {
      setTasks([]);
    }
  }, [filters, rangeStart, rangeEnd]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    void fetchFinance();
  }, [fetchFinance]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // Refresh when Google OAuth state changes
  useEffect(() => {
    const handler = () => void fetchEvents();
    window.addEventListener('google-authed', handler);
    return () => window.removeEventListener('google-authed', handler);
  }, [fetchEvents]);

  // Unified list of CalendarItems (events + finance entries + tasks).
  // When the `financas` filter is off, we still include google-calendar
  // financas events in the list so filtering is consistent — but they
  // won't render because the filter set excludes them.
  const items: CalendarItem[] = useMemo(() => {
    const list: CalendarItem[] = [];
    for (const ev of events) {
      const cat = eventCategory(ev);
      // For google-calendar "financas" items we don't have an amount, so
      // render them WITHOUT decoration — the /finance/entries source is
      // the amount-bearing one and is preferred visually.
      list.push(eventToItem(ev));
      // silence unused cat
      void cat;
    }
    for (const entry of financeEntries) {
      list.push(entryToItem(entry));
    }
    for (const task of tasks) {
      const it = taskToItem(task);
      if (it) list.push(it);
    }
    return list;
  }, [events, financeEntries, tasks]);

  // Navigation
  const goPrev = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    } else if (viewMode === 'week') {
      setCurrentDate(addDays(currentDate, -7));
    } else {
      setCurrentDate(addDays(currentDate, -1));
    }
  };

  const goNext = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    } else if (viewMode === 'week') {
      setCurrentDate(addDays(currentDate, 7));
    } else {
      setCurrentDate(addDays(currentDate, 1));
    }
  };

  const goToday = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(now.getFullYear(), now.getMonth(), 1));
    } else {
      setCurrentDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    }
  };

  const toggleFilter = (key: FilterKey) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleItemClick = (item: CalendarItem): void => {
    if (item.taskId && onNavigateToTask) {
      onNavigateToTask(item.taskId);
    }
  };

  const headerLabel =
    viewMode === 'day'
      ? fmtDayLong.format(currentDate)
      : fmtMonthYear.format(currentDate);

  return (
    <div className="calendar-view">
      {/* Header */}
      <div className="calendar-view__header">
        <div className="calendar-view__header-left">
          <button className="calendar-view__back" onClick={onBack} type="button">
            <ArrowLeftIcon size={18} />
          </button>
          <h2 className="calendar-view__title">{headerLabel}</h2>
          {loading && <span className="calendar-view__loading">atualizando...</span>}
        </div>

        <div className="calendar-view__filters">
          <button
            type="button"
            className={`calendar-filter${filters.has('agenda') ? ' calendar-filter--active' : ''}`}
            onClick={() => toggleFilter('agenda')}
          >
            <CalendarIcon size={14} />
            Agenda
          </button>
          <button
            type="button"
            className={`calendar-filter${filters.has('financas') ? ' calendar-filter--active' : ''}`}
            onClick={() => toggleFilter('financas')}
          >
            <FinanceIcon size={14} />
            Financas
          </button>
          <button
            type="button"
            className={`calendar-filter${filters.has('tarefas') ? ' calendar-filter--active' : ''}`}
            onClick={() => toggleFilter('tarefas')}
          >
            <TasksIcon size={14} />
            Tarefas
          </button>
          <button
            type="button"
            className={`calendar-filter${filters.has('outros') ? ' calendar-filter--active' : ''}`}
            onClick={() => toggleFilter('outros')}
          >
            Outros
          </button>
        </div>

        <div className="calendar-view__nav">
          <button
            type="button"
            className="calendar-view__nav-btn"
            onClick={goPrev}
            aria-label="Anterior"
          >
            <ArrowLeftIcon size={16} />
          </button>
          <button
            type="button"
            className="calendar-view__today-btn"
            onClick={goToday}
          >
            Hoje
          </button>
          <button
            type="button"
            className="calendar-view__nav-btn calendar-view__nav-btn--next"
            onClick={goNext}
            aria-label="Proximo"
          >
            <ArrowLeftIcon size={16} />
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div className="calendar-view__toggle">
        <button
          type="button"
          className={`calendar-view__toggle-btn${viewMode === 'month' ? ' calendar-view__toggle-btn--active' : ''}`}
          onClick={() => {
            setViewMode('month');
            setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), 1));
          }}
        >
          Mes
        </button>
        <button
          type="button"
          className={`calendar-view__toggle-btn${viewMode === 'week' ? ' calendar-view__toggle-btn--active' : ''}`}
          onClick={() => {
            setViewMode('week');
            // Jump to current week when switching to week view
            setCurrentDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
          }}
        >
          Semana
        </button>
        <button
          type="button"
          className={`calendar-view__toggle-btn${viewMode === 'day' ? ' calendar-view__toggle-btn--active' : ''}`}
          onClick={() => {
            setViewMode('day');
            setCurrentDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
          }}
        >
          Dia
        </button>
      </div>

      {/* Grid */}
      {viewMode === 'month' && (
        <MonthGrid
          date={currentDate}
          items={items}
          filters={filters}
          onItemClick={handleItemClick}
        />
      )}
      {viewMode === 'week' && (
        <WeekView
          date={currentDate}
          items={items}
          filters={filters}
          onItemClick={handleItemClick}
        />
      )}
      {viewMode === 'day' && (
        <DayView
          date={currentDate}
          items={items}
          filters={filters}
          onItemClick={handleItemClick}
        />
      )}
    </div>
  );
}

// Silence unused-import warnings while keeping upstream refs intact.
void groupEventsByDay;
