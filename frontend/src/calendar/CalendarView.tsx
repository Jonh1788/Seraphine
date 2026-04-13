import { useCallback, useEffect, useMemo, useState } from 'react';
import { listEvents } from '../google/api';
import type { CalendarEvent } from '../google/types';
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
import { ArrowLeftIcon, CalendarIcon, FinanceIcon } from '../icons/Icons';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CalendarViewProps {
  onBack: () => void;
}

type ViewMode = 'month' | 'week';
type FilterKey = 'agenda' | 'financas' | 'outros';

/* ------------------------------------------------------------------ */
/*  PT-BR formatters                                                   */
/* ------------------------------------------------------------------ */

const fmtMonthYear = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

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

/** Colour per category for mock events. */
const CATEGORY_COLORS: Record<string, string> = {
  agenda: '#a78bfa',
  financas: '#4ade80',
  outros: '#42a5f5',
};

function eventColor(ev: CalendarEvent): string {
  const cat = ev.calendarId ?? 'agenda';
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

/* ------------------------------------------------------------------ */
/*  MonthGrid                                                          */
/* ------------------------------------------------------------------ */

function MonthGrid({
  date,
  events,
  filters,
}: {
  date: Date;
  events: CalendarEvent[];
  filters: Set<FilterKey>;
}) {
  const cells = useMemo(() => monthGrid(date), [date]);
  const byDay = useMemo(() => groupEventsByDay(events), [events]);
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
        const dayEvents = (byDay.get(dayKey(cell)) ?? []).filter(
          (ev) => filters.has(eventCategory(ev)),
        );
        const visible = dayEvents.slice(0, 3);
        const extra = dayEvents.length - visible.length;
        const classes = ['month-grid__day'];
        if (otherMonth) classes.push('month-grid__day--other');
        if (today) classes.push('month-grid__day--today');
        return (
          <div key={cell.toISOString()} className={classes.join(' ')}>
            <div className="month-grid__day-num">{cell.getDate()}</div>
            {visible.map((ev) => (
              <div
                key={ev.id}
                className="month-grid__event"
                style={{ backgroundColor: `${eventColor(ev)}22`, color: eventColor(ev) }}
                title={ev.summary}
              >
                {ev.summary || '(sem titulo)'}
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
/*  WeekView                                                           */
/* ------------------------------------------------------------------ */

function WeekView({
  date,
  events,
  filters,
}: {
  date: Date;
  events: CalendarEvent[];
  filters: Set<FilterKey>;
}) {
  const now = useMemo(() => new Date(), []);
  const weekStart = useMemo(() => startOfWeek(date), [date]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const filtered = useMemo(
    () => events.filter((ev) => filters.has(eventCategory(ev))),
    [events, filters],
  );

  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="week-view">
      {/* Corner cell */}
      <div className="week-view__corner" />
      {/* Day headers */}
      {days.map((day) => {
        const today = isSameDay(day, now);
        return (
          <div
            key={day.toISOString()}
            className={`week-view__header${today ? ' week-view__header--today' : ''}`}
          >
            <div className="week-view__day-name">{WEEKDAY_LONG[day.getDay()]}</div>
            <div className="week-view__day-num">{day.getDate()}</div>
          </div>
        );
      })}

      {/* Hour rows */}
      {hours.map((h) => (
        <>
          <div key={`h-${h}`} className="week-view__hour">{h}h</div>
          {days.map((day) => {
            const today = isSameDay(day, now);
            const cellEvents = filtered.filter((ev) => {
              if (isAllDay(ev)) return false;
              const s = eventStart(ev);
              return isSameDay(s, day) && s.getHours() === h;
            });
            return (
              <div
                key={`${day.toISOString()}-${h}`}
                className={`week-view__cell${today ? ' week-view__cell--today' : ''}`}
              >
                {cellEvents.map((ev) => {
                  const s = eventStart(ev);
                  const e = eventEnd(ev);
                  const durationHours = Math.max(0.5, (e.getTime() - s.getTime()) / 3600000);
                  const topOffset = s.getMinutes() / 60;
                  return (
                    <div
                      key={ev.id}
                      className="week-view__event"
                      style={{
                        top: `${topOffset * 50}px`,
                        height: `${durationHours * 50 - 2}px`,
                        backgroundColor: `${eventColor(ev)}22`,
                        borderLeft: `3px solid ${eventColor(ev)}`,
                        color: eventColor(ev),
                      }}
                      title={`${ev.summary} (${fmtTime.format(s)} - ${fmtTime.format(e)})`}
                    >
                      <span className="week-view__event-title">{ev.summary}</span>
                      <span className="week-view__event-time">
                        {fmtTime.format(s)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>
      ))}

      {/* All-day events row at the very top would go here in a future iteration */}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CalendarView (main)                                                */
/* ------------------------------------------------------------------ */

export function CalendarView({ onBack }: CalendarViewProps): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Set<FilterKey>>(
    () => new Set(['agenda', 'financas', 'outros']),
  );

  const now = useMemo(() => new Date(), []);

  // Compute the visible date range based on view mode
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (viewMode === 'month') {
      const cells = monthGrid(currentDate);
      return { rangeStart: cells[0], rangeEnd: cells[cells.length - 1] };
    }
    const ws = startOfWeek(currentDate);
    return { rangeStart: ws, rangeEnd: addDays(ws, 6) };
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

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  // Refresh when Google OAuth state changes
  useEffect(() => {
    const handler = () => void fetchEvents();
    window.addEventListener('google-authed', handler);
    return () => window.removeEventListener('google-authed', handler);
  }, [fetchEvents]);

  // Navigation
  const goPrev = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    } else {
      setCurrentDate(addDays(currentDate, -7));
    }
  };

  const goNext = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    } else {
      setCurrentDate(addDays(currentDate, 7));
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

  const monthLabel = fmtMonthYear.format(currentDate);

  return (
    <div className="calendar-view">
      {/* Header */}
      <div className="calendar-view__header">
        <div className="calendar-view__header-left">
          <button className="calendar-view__back" onClick={onBack} type="button">
            <ArrowLeftIcon size={18} />
          </button>
          <h2 className="calendar-view__title">{monthLabel}</h2>
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
      </div>

      {/* Grid */}
      {viewMode === 'month' ? (
        <MonthGrid date={currentDate} events={events} filters={filters} />
      ) : (
        <WeekView date={currentDate} events={events} filters={filters} />
      )}
    </div>
  );
}
