import './obsidian.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listEvents } from '../google/api';
import type { CalendarEvent } from '../google/types';
import type { FinanceEntry, SeraphineTask } from '../finance/types';
import { API_BASE } from '../api';
import {
  fetchAggregate as apiFetchAggregate,
  fetchFinanceEntriesByRange,
  fetchTasksByRange,
} from './api';
import type { AggregateDay as DayAggregate } from './types';
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
import { ArrowLeftIcon, CalendarIcon } from '../icons/Icons';
import { Skeleton, useDelayedFlag } from '../utils';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CalendarViewProps {
  onBack: () => void;
  onNavigateToTask?: (taskId: string) => void;
}

type ViewMode = 'month' | 'week' | 'day' | 'heatmap';
type FilterKey = 'agenda' | 'financas' | 'outros' | 'tarefas' | 'lembretes';

export interface CalendarItem {
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

export interface RecurringRule {
  id: string;
  title: string;
  description: string | null;
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number | null;   // 0=Mon..6=Sun
  day_of_month: number | null;
  time: string | null;      // HH:MM
  end_date: string | null;  // YYYY-MM-DD, inclusive; null = forever
  active: boolean;
}

interface Reminder {
  id: string;
  message: string;
  fire_at: string | null;
  recurring: string | null;  // 'daily' | 'weekly' | 'hourly' | null
  next_run: string | null;
}

/* -- Aggregate types (SDD 083) live in ./types, shared with ./api -- */

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

const fmtDetailWeekday = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
});

const WEEKDAY_LONG: string[] = [
  'domingo', 'segunda-feira', 'terca-feira',
  'quarta-feira', 'quinta-feira', 'sexta-feira', 'sabado',
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const CATEGORY_COLORS: Record<FilterKey, string> = {
  agenda: '#42a5f5',
  financas: '#66bb6a',
  outros: '#78909c',
  tarefas: '#9a93ff',
  lembretes: '#ffa726',
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
    color: entry.type === 'income' ? '#66bb6a' : '#ef6b6b',
    amount: entry.amount,
    amountKind: entry.type,
  };
}

/** Expand a recurring rule into CalendarItems for every matching day in [start, end].
 *
 *  Exported for tests: this is where "durante 20 dias" either holds or silently
 *  becomes forever, and the only way to see it in the app is to reinstall. */
export function expandRecurring(rule: RecurringRule, rangeStart: Date, rangeEnd: Date): CalendarItem[] {
  const items: CalendarItem[] = [];
  const d = new Date(rangeStart);
  while (d <= rangeEnd) {
    // Inclusive end date — a time-boxed rule must stop painting the grid.
    if (rule.end_date && toIsoDate(d) > rule.end_date) break;
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
        color: CATEGORY_COLORS.tarefas,
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
  const AMBER = CATEGORY_COLORS.lembretes;

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
/*  Heatmap score colour mapping                                       */
/* ------------------------------------------------------------------ */

const HEATMAP_COLORS: Record<number, string> = {
  0: '#2a2a3e',
  1: 'rgba(154, 147, 255, 0.2)',
  2: 'rgba(154, 147, 255, 0.35)',
  3: 'rgba(154, 147, 255, 0.55)',
  4: 'rgba(154, 147, 255, 0.75)',
  5: '#9a93ff',
};

function heatmapBg(score: number): string {
  return HEATMAP_COLORS[Math.min(Math.max(score, 0), 5)] ?? HEATMAP_COLORS[0];
}

function scoreLabel(score: number): string {
  if (score === 0) return 'Sem atividade';
  if (score <= 2) return 'Atividade leve';
  if (score <= 4) return 'Atividade boa';
  return 'Dia excelente';
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
      <div className="day-detail-panel">
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

  const dateLabel = String(selectedDay.getDate());
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
            style={{
              borderLeftColor: CATEGORY_COLORS[it.category],
              background: `${CATEGORY_COLORS[it.category]}14`,
            }}
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
    <div className="day-detail-panel">
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
/*  HeatmapDetailPanel — aggregate day detail (SDD 083)                */
/* ------------------------------------------------------------------ */

function HeatmapDetailPanel({
  selectedDay,
  aggregate,
  onTaskDragStart,
  onNavigateToTask,
}: {
  selectedDay: Date | null;
  aggregate: DayAggregate | null;
  onTaskDragStart: (taskId: number, sourceDate: string) => void;
  onNavigateToTask?: (taskId: string) => void;
}): JSX.Element {
  if (!selectedDay || !aggregate) {
    return (
      <div className="day-detail-panel">
        <div className="day-detail-panel__empty">
          <CalendarIcon size={32} className="day-detail-panel__empty-icon" />
          <span className="day-detail-panel__empty-text">Selecione um dia</span>
        </div>
      </div>
    );
  }

  const dateLabel = String(selectedDay.getDate());
  const weekdayLabel = fmtDetailWeekday.format(selectedDay);
  const { tasks, habits, health, water, events, score } = aggregate;
  const hasContent = tasks.length > 0 || habits.length > 0 || health || water || events.length > 0;

  return (
    <div className="day-detail-panel">
      <div className="day-detail-panel__header">
        <div className="day-detail-panel__date">{dateLabel}</div>
        <div className="day-detail-panel__weekday">{weekdayLabel}</div>
      </div>
      <div className="heatmap-detail__score" style={{ backgroundColor: heatmapBg(score) }}>
        {score}/5 - {scoreLabel(score)}
      </div>
      <div className="day-detail-panel__divider" />
      <div className="day-detail-panel__content">
        {!hasContent ? (
          <div className="day-detail-panel__empty day-detail-panel__empty--inline">
            <span className="day-detail-panel__empty-text">Nenhuma atividade neste dia</span>
          </div>
        ) : (
          <>
            {/* Google Calendar Events */}
            {events.length > 0 && (
              <div className="day-detail-panel__section">
                <div className="day-detail-panel__section-label" style={{ color: CATEGORY_COLORS.agenda }}>
                  Agenda
                </div>
                {events.map((ev, i) => (
                  <div key={`ev-${i}`} className="day-detail-panel__item" style={{ borderLeftColor: CATEGORY_COLORS.agenda }}>
                    <div className="day-detail-panel__item-title">{ev.title}</div>
                    {ev.start && ev.start.length > 10 && (
                      <div className="day-detail-panel__item-time">
                        {fmtTime.format(new Date(ev.start))}
                        {ev.end && ev.end.length > 10 && ` - ${fmtTime.format(new Date(ev.end))}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Tasks (draggable) */}
            {tasks.length > 0 && (
              <div className="day-detail-panel__section">
                <div className="day-detail-panel__section-label" style={{ color: CATEGORY_COLORS.tarefas }}>
                  Tarefas
                </div>
                {tasks.map((t) => (
                  <div
                    key={`task-${t.id}`}
                    className="day-detail-panel__item day-detail-panel__item--clickable heatmap-detail__task-drag"
                    style={{ borderLeftColor: CATEGORY_COLORS.tarefas }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(t.id));
                      e.dataTransfer.effectAllowed = 'move';
                      onTaskDragStart(t.id, aggregate.date);
                    }}
                    onClick={() => onNavigateToTask?.(String(t.id))}
                  >
                    <div className="day-detail-panel__item-title">{t.title}</div>
                    <div className="day-detail-panel__item-status">
                      {t.status === 'done' ? (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span style={{ color: '#4ade80' }}>Concluida</span>
                        </>
                      ) : (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                          </svg>
                          <span style={{ color: '#f59e0b' }}>Pendente</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Habits */}
            {habits.length > 0 && (
              <div className="day-detail-panel__section">
                <div className="day-detail-panel__section-label" style={{ color: '#22d3ee' }}>
                  Habitos
                </div>
                {habits.map((h, i) => (
                  <div key={`habit-${i}`} className="day-detail-panel__item" style={{ borderLeftColor: '#22d3ee' }}>
                    <div className="day-detail-panel__item-title">{h.name}</div>
                    <div className="day-detail-panel__item-status">
                      {h.completed ? (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span style={{ color: '#4ade80' }}>Completo</span>
                        </>
                      ) : (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                          </svg>
                          <span style={{ color: 'var(--text-faint)' }}>Pendente</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Health */}
            {health && (
              <div className="day-detail-panel__section">
                <div className="day-detail-panel__section-label" style={{ color: '#f472b6' }}>
                  Saude
                </div>
                <div className="heatmap-detail__health-grid">
                  <div className="heatmap-detail__health-stat">
                    <div className="heatmap-detail__health-value">{health.steps.toLocaleString('pt-BR')}</div>
                    <div className="heatmap-detail__health-label">Passos</div>
                  </div>
                  {health.sleep_hours != null && (
                    <div className="heatmap-detail__health-stat">
                      <div className="heatmap-detail__health-value">{health.sleep_hours}h</div>
                      <div className="heatmap-detail__health-label">Sono</div>
                    </div>
                  )}
                  <div className="heatmap-detail__health-stat">
                    <div className="heatmap-detail__health-value">{health.calories}</div>
                    <div className="heatmap-detail__health-label">Calorias</div>
                  </div>
                  {health.resting_hr != null && (
                    <div className="heatmap-detail__health-stat">
                      <div className="heatmap-detail__health-value">{health.resting_hr} bpm</div>
                      <div className="heatmap-detail__health-label">FC Repouso</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Water */}
            {water && water.goal_ml > 0 && (
              <div className="day-detail-panel__section">
                <div className="day-detail-panel__section-label" style={{ color: '#60a5fa' }}>
                  Agua
                </div>
                <div className="heatmap-detail__water">
                  <div className="heatmap-detail__water-bar-bg">
                    <div
                      className="heatmap-detail__water-bar-fill"
                      style={{ width: `${Math.min(100, Math.round((water.intake_ml / water.goal_ml) * 100))}%` }}
                    />
                  </div>
                  <div className="heatmap-detail__water-text">
                    {water.intake_ml} / {water.goal_ml} ml
                    {water.intake_ml >= water.goal_ml && (
                      <span className="heatmap-detail__water-check">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  HeatmapGrid — month grid coloured by aggregate score (SDD 083)     */
/* ------------------------------------------------------------------ */

function HeatmapGrid({
  date,
  aggregates,
  selectedDay,
  onDayClick,
  onTaskDrop,
  dragTaskId,
}: {
  date: Date;
  aggregates: Map<string, DayAggregate>;
  selectedDay: Date | null;
  onDayClick: (day: Date) => void;
  onTaskDrop: (taskId: number, targetDate: string) => void;
  dragTaskId: number | null;
}) {
  const cells = useMemo(() => monthGrid(date), [date]);
  const now = useMemo(() => new Date(), []);
  const viewMonth = date.getMonth();
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  return (
    <div className="heatmap-grid">
      {WEEKDAY_LABELS.map((label) => (
        <div key={label} className="heatmap-grid__header">{label}</div>
      ))}
      {cells.map((cell) => {
        const otherMonth = cell.getMonth() !== viewMonth;
        const today = isSameDay(cell, now);
        const selected = selectedDay ? isSameDay(cell, selectedDay) : false;
        const iso = toIsoDate(cell);
        const agg = aggregates.get(iso);
        const score = agg?.score ?? 0;
        const isDropTarget = dropTarget === iso;

        const classes = ['heatmap-grid__day'];
        if (otherMonth) classes.push('heatmap-grid__day--other');
        if (today) classes.push('heatmap-grid__day--today');
        if (selected) classes.push('heatmap-grid__day--selected');
        if (isDropTarget) classes.push('heatmap-grid__day--drop-target');

        return (
          <div
            key={cell.toISOString()}
            className={classes.join(' ')}
            style={{ backgroundColor: otherMonth ? undefined : heatmapBg(score) }}
            onClick={() => onDayClick(cell)}
            onMouseEnter={() => setHoverDate(iso)}
            onMouseLeave={() => setHoverDate(null)}
            onDragOver={(e) => {
              if (dragTaskId !== null) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropTarget(iso);
              }
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              const taskIdStr = e.dataTransfer.getData('text/plain');
              const taskId = Number(taskIdStr);
              if (taskId && !Number.isNaN(taskId)) {
                onTaskDrop(taskId, iso);
              }
            }}
          >
            <div className="heatmap-grid__day-num">
              <span className={today ? 'month-grid-v2__today-ring' : undefined}>
                {cell.getDate()}
              </span>
            </div>
            {!otherMonth && agg && score > 0 && (
              <div className="heatmap-grid__score-badge">{score}</div>
            )}
            {/* Tooltip on hover */}
            {hoverDate === iso && agg && !otherMonth && (
              <div className="heatmap-grid__tooltip" ref={tooltipRef}>
                <div className="heatmap-grid__tooltip-score">{score}/5 - {scoreLabel(score)}</div>
                {agg.tasks.length > 0 && (
                  <div className="heatmap-grid__tooltip-row">
                    Tarefas: {agg.tasks.filter(t => t.status === 'done').length}/{agg.tasks.length}
                  </div>
                )}
                {agg.habits.length > 0 && (
                  <div className="heatmap-grid__tooltip-row">
                    Habitos: {agg.habits.filter(h => h.completed).length}/{agg.habits.length}
                  </div>
                )}
                {agg.health && (
                  <div className="heatmap-grid__tooltip-row">
                    {agg.health.steps.toLocaleString('pt-BR')} passos
                    {agg.health.sleep_hours != null && ` / ${agg.health.sleep_hours}h sono`}
                  </div>
                )}
                {agg.water && agg.water.goal_ml > 0 && (
                  <div className="heatmap-grid__tooltip-row">
                    Agua: {Math.round((agg.water.intake_ml / agg.water.goal_ml) * 100)}%
                  </div>
                )}
                {agg.events.length > 0 && (
                  <div className="heatmap-grid__tooltip-row">
                    {agg.events.length} evento{agg.events.length > 1 ? 's' : ''}
                  </div>
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
    <div className="month-grid-v2">
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

export function CalendarView({ onNavigateToTask }: CalendarViewProps): JSX.Element {
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

  // Heatmap aggregate data (SDD 083)
  const [aggregates, setAggregates] = useState<Map<string, DayAggregate>>(new Map());
  const [aggLoading, setAggLoading] = useState(false);
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);

  const now = useMemo(() => new Date(), []);

  // Compute the visible date range based on view mode
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (viewMode === 'month' || viewMode === 'heatmap') {
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
      setEvents([]);
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
      // Pela DATA DA COMPRA, que é por onde `entryToItem` posiciona cada
      // lançamento na grade. `month`/`year` respondem outra pergunta — o mês
      // DE CAIXA, em que o dinheiro sai — e buscar por um enquanto se desenha
      // pelo outro fazia a compra de 15/07 numa fatura que vence em 10/08
      // nunca ser buscada para a semana de 13–19/07: ela sumia do dia em que
      // aconteceu. A visão de mês escapava por acidente (a grade puxa três
      // meses) até a fatura ser paga em setembro. O calendário é sobre quando
      // a compra aconteceu; as duas pontas concordam nisso agora.
      setFinanceEntries(
        await fetchFinanceEntriesByRange(toIsoDate(rangeStart), toIsoDate(rangeEnd)),
      );
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
      setTasks(await fetchTasksByRange(toIsoDate(rangeStart), toIsoDate(rangeEnd)));
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

  // Fetch aggregate data for heatmap mode (SDD 083)
  const fetchAggregate = useCallback(async () => {
    if (viewMode !== 'heatmap') return;
    setAggLoading(true);
    try {
      const days = await apiFetchAggregate(toIsoDate(rangeStart), toIsoDate(rangeEnd));
      const m = new Map<string, DayAggregate>();
      for (const d of days) {
        m.set(d.date, d);
      }
      setAggregates(m);
    } catch {
      setAggregates(new Map());
    } finally {
      setAggLoading(false);
    }
  }, [viewMode, rangeStart, rangeEnd]);

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

  useEffect(() => {
    void fetchAggregate();
  }, [fetchAggregate]);

  // Refresh when Google OAuth state changes
  useEffect(() => {
    const handler = () => {
      void fetchEvents();
      if (viewMode === 'heatmap') void fetchAggregate();
    };
    window.addEventListener('google-authed', handler);
    return () => window.removeEventListener('google-authed', handler);
  }, [fetchEvents, fetchAggregate, viewMode]);

  // Clear drag state on dragend (window-level to catch drops outside)
  useEffect(() => {
    const handler = () => setDragTaskId(null);
    window.addEventListener('dragend', handler);
    return () => window.removeEventListener('dragend', handler);
  }, []);

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
    if (viewMode === 'month' || viewMode === 'heatmap') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    } else if (viewMode === 'week') {
      setCurrentDate(addDays(currentDate, -7));
    } else {
      setCurrentDate(addDays(currentDate, -1));
    }
  };

  const goNext = () => {
    if (viewMode === 'month' || viewMode === 'heatmap') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    } else if (viewMode === 'week') {
      setCurrentDate(addDays(currentDate, 7));
    } else {
      setCurrentDate(addDays(currentDate, 1));
    }
  };

  const goToday = () => {
    if (viewMode === 'month' || viewMode === 'heatmap') {
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

  // Drag-to-reschedule: PATCH /tasks/{id} with new due_date
  const handleTaskDrop = useCallback(async (taskId: number, targetDate: string) => {
    try {
      const res = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: targetDate }),
      });
      if (res.ok) {
        // Refresh aggregate data + tasks
        void fetchAggregate();
        void fetchTasks();
      }
    } catch {
      // silently fail
    } finally {
      setDragTaskId(null);
    }
  }, [fetchAggregate, fetchTasks]);

  const handleTaskDragStart = useCallback((taskId: number, _sourceDate: string) => {
    setDragTaskId(taskId);
  }, []);

  const headerLabel =
    viewMode === 'day'
      ? fmtDayLong.format(currentDate)
      : fmtMonthYear.format(currentDate);

  // Selected day's aggregate (for heatmap detail panel)
  const selectedAggregate = useMemo<DayAggregate | null>(() => {
    if (!selectedDay) return null;
    return aggregates.get(toIsoDate(selectedDay)) ?? null;
  }, [selectedDay, aggregates]);

  // Filter pill data — each leads with an 8px colored dot in the category color.
  const filterPills: { key: FilterKey; label: string; color: string }[] = [
    { key: 'agenda', label: CATEGORY_LABELS.agenda, color: CATEGORY_COLORS.agenda },
    { key: 'financas', label: CATEGORY_LABELS.financas, color: CATEGORY_COLORS.financas },
    { key: 'tarefas', label: CATEGORY_LABELS.tarefas, color: CATEGORY_COLORS.tarefas },
    { key: 'outros', label: CATEGORY_LABELS.outros, color: CATEGORY_COLORS.outros },
    { key: 'lembretes', label: CATEGORY_LABELS.lembretes, color: CATEGORY_COLORS.lembretes },
  ];

  return (
    <div className="calendar-view">
      {/* Header: title (left) | [Heatmap|Mês|Semana|Dia] [‹ Hoje ›] [+ Evento] (right) */}
      <div className="calendar-view__header">
        <div className="calendar-view__header-left">
          <h2 className="calendar-view__title">{headerLabel}</h2>
          {(loading || aggLoading) && <span className="calendar-view__loading">atualizando...</span>}
        </div>

        <div className="calendar-view__actions">
          {/* Segmented view toggle */}
          <div className="calendar-view__toggle" role="tablist">
            <button
              type="button"
              className={`calendar-view__toggle-btn${viewMode === 'heatmap' ? ' calendar-view__toggle-btn--active' : ''}`}
              onClick={() => {
                setViewMode('heatmap');
                setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), 1));
              }}
            >
              Heatmap
            </button>
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

          {/* Prev / Hoje / Next pill */}
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

          {/* Primary CTA — focus today's day panel (no dedicated create modal exists) */}
          <button
            type="button"
            className="calendar-view__add-event"
            onClick={() => handleDayClick(new Date())}
          >
            + Evento
          </button>
        </div>
      </div>

      {/* Filter pills (8px colored dots) */}
      {viewMode !== 'heatmap' && (
        <div className="calendar-view__filters">
          {filterPills.map((pill) => {
            const active = filters.has(pill.key);
            return (
              <button
                key={pill.key}
                type="button"
                className={`calendar-filter${active ? ' calendar-filter--active' : ' calendar-filter--off'}`}
                onClick={() => toggleFilter(pill.key)}
              >
                <span className="calendar-filter__dot" style={{ background: pill.color }} />
                {pill.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Grid */}
      {delayedFirstLoading ? (
        <div className="calendar-skeleton-grid" aria-hidden="true">
          <Skeleton variant="card" height={40} count={35} />
        </div>
      ) : (
        <>
          {viewMode === 'heatmap' && (
            <div className="calendar-view__month-layout">
              <HeatmapGrid
                date={currentDate}
                aggregates={aggregates}
                selectedDay={selectedDay}
                onDayClick={handleDayClick}
                onTaskDrop={handleTaskDrop}
                dragTaskId={dragTaskId}
              />
              <HeatmapDetailPanel
                selectedDay={selectedDay}
                aggregate={selectedAggregate}
                onTaskDragStart={handleTaskDragStart}
                onNavigateToTask={onNavigateToTask}
              />
            </div>
          )}
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
