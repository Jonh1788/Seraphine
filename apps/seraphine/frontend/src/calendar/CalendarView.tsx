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
import { ArrowLeftIcon, BellIcon, CalendarIcon, FinanceIcon, TasksIcon } from '../icons/Icons';
import { Skeleton, useDelayedFlag } from '../utils';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CalendarViewProps {
  onBack: () => void;
  onNavigateToTask?: (taskId: string) => void;
}

type ViewMode = 'month' | 'week' | 'day';
type FilterKey = 'agenda' | 'financas' | 'outros' | 'tarefas' | 'lembretes';

interface CalendarItem {
  key: string;          // unique render key
  category: FilterKey;  // which filter drives visibility
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  color: string;
  amount?: number;      // signed finance amount
  amountKind?: 'income' | 'expense';
  taskId?: string;      // set when this is a task item (clickable)
  recurring?: boolean;  // true for expanded recurring rule occurrences
}

interface RecurringRule {
  id: string;
  title: string;
  description: string | null;
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number | null;   // 0=Mon..6=Sun
  day_of_month: number | null;
  time: string | null;      // HH:MM
  active: boolean;
}

interface Reminder {
  id: string;
  message: string;
  fire_at: string | null;
  recurring: string | null;  // 'daily' | 'weekly' | 'hourly' | null
  next_run: string | null;
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

const fmtGreetingDate = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const fmtDetailDate = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
});

const fmtDetailWeekday = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
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
  tarefas: '#22d3ee',
  lembretes: '#f59e0b',
};

const CATEGORY_LABELS: Record<FilterKey, string> = {
  agenda: 'Agenda',
  financas: 'Financas',
  tarefas: 'Tarefas',
  outros: 'Outros',
  lembretes: 'Lembretes',
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

function parseIsoLocalDate(iso: string | null | undefined): Date {
  if (!iso) return new Date();
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

/** Expand a recurring rule into CalendarItems for every matching day in [start, end]. */
function expandRecurring(rule: RecurringRule, rangeStart: Date, rangeEnd: Date): CalendarItem[] {
  const items: CalendarItem[] = [];
  const d = new Date(rangeStart);
  while (d <= rangeEnd) {
    let match = false;
    if (rule.frequency === 'daily') {
      match = true;
    } else if (rule.frequency === 'weekly' && rule.weekday !== null) {
      // rule.weekday: 0=Mon..6=Sun  →  JS getDay(): 0=Sun..6=Sat
      const jsDay = d.getDay();
      const ruleDayJs = rule.weekday === 6 ? 0 : rule.weekday + 1;
      match = jsDay === ruleDayJs;
    } else if (rule.frequency === 'monthly' && rule.day_of_month !== null) {
      match = d.getDate() === rule.day_of_month;
    }
    if (match) {
      const start = new Date(d);
      if (rule.time) {
        const [h, m] = rule.time.split(':').map(Number);
        start.setHours(h ?? 9, m ?? 0, 0, 0);
      } else {
        start.setHours(9, 0, 0, 0);
      }
      const end = new Date(start);
      end.setHours(start.getHours() + 1);
      items.push({
        key: `rec-${rule.id}-${toIsoDate(d)}`,
        category: 'tarefas',
        start,
        end,
        allDay: true,
        title: rule.title,
        color: '#22d3ee',
        recurring: true,
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return items;
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

/** Expand a reminder into CalendarItems for the visible range. */
function expandReminder(rem: Reminder, rangeStart: Date, rangeEnd: Date): CalendarItem[] {
  const items: CalendarItem[] = [];
  const AMBER = '#f59e0b';

  if (!rem.recurring) {
    // One-time reminder — single item on fire_at date
    const fireStr = rem.next_run || rem.fire_at;
    if (!fireStr) return items;
    const fire = new Date(fireStr);
    if (Number.isNaN(fire.getTime())) return items;
    if (fire >= rangeStart && fire <= new Date(rangeEnd.getTime() + 86400000)) {
      const end = new Date(fire);
      end.setMinutes(end.getMinutes() + 30);
      items.push({
        key: `rem-${rem.id}`,
        category: 'lembretes',
        start: fire,
        end,
        allDay: false,
        title: rem.message,
        color: AMBER,
      });
    }
    return items;
  }

  // Recurring reminder — expand into visible range
  const baseStr = rem.fire_at || rem.next_run;
  if (!baseStr) return items;
  const base = new Date(baseStr);
  if (Number.isNaN(base.getTime())) return items;

  const intervalMs =
    rem.recurring === 'hourly' ? 3600000 :
    rem.recurring === 'daily' ? 86400000 :
    rem.recurring === 'weekly' ? 7 * 86400000 : 86400000;

  if (rem.recurring === 'hourly') {
    // For hourly, just show one item per day in the range at the base minute
    const d = new Date(rangeStart);
    while (d <= rangeEnd) {
      const start = new Date(d);
      start.setHours(base.getHours(), base.getMinutes(), 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 30);
      items.push({
        key: `rem-${rem.id}-${toIsoDate(d)}`,
        category: 'lembretes',
        start,
        end,
        allDay: false,
        title: rem.message,
        color: AMBER,
        recurring: true,
      });
      d.setDate(d.getDate() + 1);
    }
  } else {
    // daily / weekly — step through range
    // Find first occurrence >= rangeStart
    let cursor = new Date(base);
    if (cursor < rangeStart) {
      const diff = rangeStart.getTime() - cursor.getTime();
      const steps = Math.floor(diff / intervalMs);
      cursor = new Date(cursor.getTime() + steps * intervalMs);
      if (cursor < rangeStart) cursor = new Date(cursor.getTime() + intervalMs);
    }
    const rangeEndPlusDay = new Date(rangeEnd.getTime() + 86400000);
    while (cursor <= rangeEndPlusDay) {
      const end = new Date(cursor);
      end.setMinutes(end.getMinutes() + 30);
      items.push({
        key: `rem-${rem.id}-${toIsoDate(cursor)}`,
        category: 'lembretes',
        start: new Date(cursor),
        end,
        allDay: false,
        title: rem.message,
        color: AMBER,
        recurring: true,
      });
      cursor = new Date(cursor.getTime() + intervalMs);
    }
  }

  return items;
}

/* ------------------------------------------------------------------ */
/*  DayDetailPanel — sidebar showing selected day's items              */
/* ------------------------------------------------------------------ */

function DayDetailPanel({
  selectedDay,
  items,
  filters,
  onItemClick,
}: {
  selectedDay: Date | null;
  items: CalendarItem[];
  filters: Set<FilterKey>;
  onItemClick: (item: CalendarItem) => void;
}): JSX.Element {
  if (!selectedDay) {
    return (
      <div className="day-detail-panel glass-card">
        <div className="day-detail-panel__empty">
          <CalendarIcon size={32} className="day-detail-panel__empty-icon" />
          <span className="day-detail-panel__empty-text">Selecione um dia</span>
        </div>
      </div>
    );
  }

  const dayItems = items.filter(
    (it) => filters.has(it.category) && isSameDay(it.start, selectedDay),
  );
  dayItems.sort((a, b) => a.start.getTime() - b.start.getTime());

  const dateLabel = fmtDetailDate.format(selectedDay);
  const weekdayLabel = fmtDetailWeekday.format(selectedDay);

  const agendaItems = dayItems.filter((it) => it.category === 'agenda');
  const financeItems = dayItems.filter((it) => it.category === 'financas');
  const taskItems = dayItems.filter((it) => it.category === 'tarefas');
  const otherItems = dayItems.filter((it) => it.category === 'outros');
  const reminderItems = dayItems.filter((it) => it.category === 'lembretes');

  const renderSection = (
    sectionItems: CalendarItem[],
    label: string,
    color: string,
  ) => {
    if (sectionItems.length === 0) return null;
    return (
      <div className="day-detail-panel__section">
        <div className="day-detail-panel__section-label" style={{ color }}>
          {label}
        </div>
        {sectionItems.map((it) => (
          <div
            key={it.key}
            className={`day-detail-panel__item${it.taskId ? ' day-detail-panel__item--clickable' : ''}`}
            style={{ borderLeftColor: CATEGORY_COLORS[it.category] }}
            onClick={it.taskId ? () => onItemClick(it) : undefined}
          >
            <div className="day-detail-panel__item-title">{it.title}</div>
            {!it.allDay && (
              <div className="day-detail-panel__item-time">
                {fmtTime.format(it.start)} - {fmtTime.format(it.end)}
              </div>
            )}
            {it.allDay && !it.amount && (
              <div className="day-detail-panel__item-time">Dia inteiro</div>
            )}
            {it.amount != null && it.amountKind && (
              <div
                className={`day-detail-panel__item-amount day-detail-panel__item-amount--${it.amountKind}`}
              >
                {fmtBRLSigned(it.amount, it.amountKind)}
              </div>
            )}
            {it.taskId && (
              <div className="day-detail-panel__item-status">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Tarefa</span>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="day-detail-panel glass-card">
      <div className="day-detail-panel__header">
        <div className="day-detail-panel__date">{dateLabel}</div>
        <div className="day-detail-panel__weekday">{weekdayLabel}</div>
      </div>
      <div className="day-detail-panel__divider" />
      <div className="day-detail-panel__content">
        {dayItems.length === 0 ? (
          <div className="day-detail-panel__empty day-detail-panel__empty--inline">
            <span className="day-detail-panel__empty-text">Nenhum evento neste dia</span>
          </div>
        ) : (
          <>
            {renderSection(agendaItems, 'Agenda', CATEGORY_COLORS.agenda)}
            {renderSection(financeItems, 'Financas', CATEGORY_COLORS.financas)}
            {renderSection(taskItems, 'Tarefas', CATEGORY_COLORS.tarefas)}
            {renderSection(otherItems, 'Outros', CATEGORY_COLORS.outros)}
            {renderSection(reminderItems, 'Lembretes', CATEGORY_COLORS.lembretes)}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  MonthGrid — event dots instead of text                             */
/* ------------------------------------------------------------------ */

function MonthGrid({
  date,
  items,
  filters,
  selectedDay,
  onDayClick,
  onItemClick,
}: {
  date: Date;
  items: CalendarItem[];
  filters: Set<FilterKey>;
  selectedDay: Date | null;
  onDayClick: (day: Date) => void;
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

  // Silence unused prop
  void onItemClick;

  return (
    <div className="month-grid-v2 glass-card">
      {WEEKDAY_LABELS.map((label) => (
        <div key={label} className="month-grid-v2__header">{label}</div>
      ))}
      {cells.map((cell) => {
        const otherMonth = cell.getMonth() !== viewMonth;
        const today = isSameDay(cell, now);
        const selected = selectedDay ? isSameDay(cell, selectedDay) : false;
        const dayItems = byDay.get(dayKey(cell)) ?? [];

        // Collect unique category dots (max 4)
        const dotCategories: FilterKey[] = [];
        const seen = new Set<FilterKey>();
        for (const it of dayItems) {
          if (!seen.has(it.category)) {
            seen.add(it.category);
            dotCategories.push(it.category);
          }
          if (dotCategories.length >= 4) break;
        }

        const overflow = dayItems.length > 4 ? dayItems.length - 4 : 0;

        const classes = ['month-grid-v2__day'];
        if (otherMonth) classes.push('month-grid-v2__day--other');
        if (today) classes.push('month-grid-v2__day--today');
        if (selected) classes.push('month-grid-v2__day--selected');

        return (
          <div
            key={cell.toISOString()}
            className={classes.join(' ')}
            onClick={() => onDayClick(cell)}
          >
            <div className="month-grid-v2__day-num">
              <span className={today ? 'month-grid-v2__today-ring' : undefined}>
                {cell.getDate()}
              </span>
            </div>
            {dotCategories.length > 0 && (
              <div className="month-grid-v2__dots">
                {dotCategories.map((cat) => (
                  <span
                    key={cat}
                    className="month-grid-v2__dot"
                    style={{ backgroundColor: CATEGORY_COLORS[cat] }}
                  />
                ))}
                {overflow > 0 && (
                  <span className="month-grid-v2__dot-overflow">+{overflow}</span>
                )}
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
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [financeEntries, setFinanceEntries] = useState<FinanceEntry[]>([]);
  const [tasks, setTasks] = useState<SeraphineTask[]>([]);
  const [recurringRules, setRecurringRules] = useState<RecurringRule[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(false);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const delayedFirstLoading = useDelayedFlag(!firstLoaded && loading, 100);
  const [filters, setFilters] = useState<Set<FilterKey>>(
    () => new Set(['agenda', 'financas', 'outros', 'tarefas', 'lembretes']),
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
      setFirstLoaded(true);
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
            `${API_BASE}/finance/entries?year=${y}&month=${m}&limit=500`,
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

  // Fetch recurring rules (once, they don't change with range).
  const fetchRecurring = useCallback(async () => {
    if (!filters.has('tarefas')) {
      setRecurringRules([]);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/recurring`);
      if (!res.ok) { setRecurringRules([]); return; }
      const data = await res.json();
      const rules = Array.isArray(data.recurring) ? data.recurring : (Array.isArray(data) ? data : []);
      setRecurringRules(rules.filter((r: RecurringRule) => r.active));
    } catch {
      setRecurringRules([]);
    }
  }, [filters]);

  // Fetch reminders (once, they don't depend on range).
  const fetchReminders = useCallback(async () => {
    if (!filters.has('lembretes')) {
      setReminders([]);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/reminders`);
      if (!res.ok) { setReminders([]); return; }
      const data = await res.json();
      setReminders(Array.isArray(data.reminders) ? data.reminders : []);
    } catch {
      setReminders([]);
    }
  }, [filters]);

  useEffect(() => {
    void fetchRecurring();
  }, [fetchRecurring]);

  useEffect(() => {
    void fetchReminders();
  }, [fetchReminders]);

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
  const items: CalendarItem[] = useMemo(() => {
    const list: CalendarItem[] = [];
    for (const ev of events) {
      const cat = eventCategory(ev);
      list.push(eventToItem(ev));
      void cat;
    }
    for (const entry of financeEntries) {
      if (entry.date) list.push(entryToItem(entry));
    }
    for (const task of tasks) {
      const it = taskToItem(task);
      if (it) list.push(it);
    }
    for (const rule of recurringRules) {
      list.push(...expandRecurring(rule, rangeStart, rangeEnd));
    }
    for (const rem of reminders) {
      list.push(...expandReminder(rem, rangeStart, rangeEnd));
    }
    return list;
  }, [events, financeEntries, tasks, recurringRules, reminders, rangeStart, rangeEnd]);

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

  const handleDayClick = (day: Date): void => {
    setSelectedDay((prev) => (prev && isSameDay(prev, day) ? null : day));
  };

  const headerLabel =
    viewMode === 'day'
      ? fmtDayLong.format(currentDate)
      : fmtMonthYear.format(currentDate);

  const greetingLabel = fmtGreetingDate.format(now);

  // Filter pill data
  const filterPills: { key: FilterKey; label: string; color: string; icon: JSX.Element | null }[] = [
    { key: 'agenda', label: CATEGORY_LABELS.agenda, color: CATEGORY_COLORS.agenda, icon: <CalendarIcon size={14} /> },
    { key: 'financas', label: CATEGORY_LABELS.financas, color: CATEGORY_COLORS.financas, icon: <FinanceIcon size={14} /> },
    { key: 'tarefas', label: CATEGORY_LABELS.tarefas, color: CATEGORY_COLORS.tarefas, icon: <TasksIcon size={14} /> },
    { key: 'outros', label: CATEGORY_LABELS.outros, color: CATEGORY_COLORS.outros, icon: null },
    { key: 'lembretes', label: CATEGORY_LABELS.lembretes, color: CATEGORY_COLORS.lembretes, icon: <BellIcon size={14} /> },
  ];

  return (
    <div className="calendar-view">
      {/* Greeting header */}
      <div className="calendar-view__greeting">
        <button className="calendar-view__back" onClick={onBack} type="button">
          <ArrowLeftIcon size={18} />
        </button>
        <div className="calendar-view__greeting-text">
          <span className="calendar-view__greeting-date">{greetingLabel}</span>
          {loading && <span className="calendar-view__loading">atualizando...</span>}
        </div>
      </div>

      {/* Header */}
      <div className="calendar-view__header">
        <div className="calendar-view__header-left">
          <h2 className="calendar-view__title">{headerLabel}</h2>
        </div>

        <div className="calendar-view__filters">
          {filterPills.map((pill) => {
            const active = filters.has(pill.key);
            return (
              <button
                key={pill.key}
                type="button"
                className={`calendar-filter${active ? ' calendar-filter--active' : ''}`}
                style={active ? {
                  backgroundColor: `${pill.color}1f`,
                  borderColor: `${pill.color}4d`,
                  color: pill.color,
                } : undefined}
                onClick={() => toggleFilter(pill.key)}
              >
                {pill.icon}
                {pill.label}
              </button>
            );
          })}
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
      {delayedFirstLoading ? (
        <div className="calendar-skeleton-grid" aria-hidden="true">
          <Skeleton variant="card" height={40} count={35} />
        </div>
      ) : (
        <>
          {viewMode === 'month' && (
            <div className="calendar-view__month-layout">
              <MonthGrid
                date={currentDate}
                items={items}
                filters={filters}
                selectedDay={selectedDay}
                onDayClick={handleDayClick}
                onItemClick={handleItemClick}
              />
              <DayDetailPanel
                selectedDay={selectedDay}
                items={items}
                filters={filters}
                onItemClick={handleItemClick}
              />
            </div>
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
        </>
      )}
    </div>
  );
}

// Silence unused-import warnings while keeping upstream refs intact.
void groupEventsByDay;
