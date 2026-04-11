import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import { listEvents } from './api';
import { DayDetailModal } from './DayDetailModal';
import { ModalShell } from './ModalShell';
import type { CalendarEvent } from './types';
import {
  WEEKDAY_LABELS,
  chipColor,
  dayKey,
  fmtMonthYear,
  groupEventsByDay,
  isSameDay,
  monthGrid,
} from './utils';

interface CalendarModalProps {
  open: boolean;
  onClose: () => void;
  ws: SeraphineWS | null;
}

/**
 * Full-screen month-grid calendar. Fetches events for the visible
 * month range on mount and whenever the user navigates. Caches the
 * raw list in state; clicking a day opens DayDetailModal.
 */
export function CalendarModal({ open, onClose, ws }: CalendarModalProps): JSX.Element | null {
  // Cursor: first of the currently viewed month.
  const [cursor, setCursor] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const cells = useMemo(() => monthGrid(cursor), [cursor]);
  const byDay = useMemo(() => groupEventsByDay(events), [events]);
  const now = useMemo(() => new Date(), []);

  const fetchEvents = useCallback(async () => {
    if (!open) return;
    const from = cells[0];
    const to = cells[cells.length - 1];
    setLoading(true);
    setError(null);
    try {
      const list = await listEvents(from, to);
      setEvents(list);
    } catch (e) {
      setError(String(e));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [open, cells]);

  useEffect(() => {
    if (open) void fetchEvents();
  }, [open, fetchEvents]);

  // Refresh when OAuth state flips to authed while open.
  useEffect(() => {
    if (!open) return;
    const handler = () => void fetchEvents();
    window.addEventListener('google-authed', handler);
    return () => window.removeEventListener('google-authed', handler);
  }, [open, fetchEvents]);

  if (!open) return null;

  const goPrev = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  const goNext = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  const goToday = () => setCursor(new Date(now.getFullYear(), now.getMonth(), 1));

  const monthLabel = fmtMonthYear.format(cursor);
  const viewMonth = cursor.getMonth();

  const selectedEvents = selectedDay ? byDay.get(dayKey(selectedDay)) ?? [] : [];

  return (
    <>
      <ModalShell
        onClose={onClose}
        className="calendar-modal"
        label={`Calendario ${monthLabel}`}
      >
        <header className="calendar-header">
          <div className="calendar-header__title">
            <h2>{monthLabel}</h2>
            {loading && <span className="calendar-header__loading">atualizando...</span>}
          </div>
          <div className="calendar-header__nav">
            <button type="button" className="btn-ghost" onClick={goPrev} aria-label="Mes anterior">
              &#9664;
            </button>
            <button type="button" className="btn-ghost" onClick={goToday}>
              Hoje
            </button>
            <button type="button" className="btn-ghost" onClick={goNext} aria-label="Proximo mes">
              &#9654;
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void fetchEvents()}
              aria-label="Atualizar"
              title="Atualizar"
            >
              &#8635;
            </button>
            <button
              type="button"
              className="btn-ghost calendar-header__close"
              onClick={onClose}
              aria-label="Fechar"
            >
              &times;
            </button>
          </div>
        </header>

        {error && <div className="calendar-error">{error}</div>}

        <div className="calendar-grid">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="calendar-day-header">
              {label}
            </div>
          ))}
          {cells.map((cell) => {
            const otherMonth = cell.getMonth() !== viewMonth;
            const today = isSameDay(cell, now);
            const dayEvents = byDay.get(dayKey(cell)) ?? [];
            const visible = dayEvents.slice(0, 3);
            const extra = dayEvents.length - visible.length;
            const classes = ['calendar-day'];
            if (otherMonth) classes.push('calendar-day--other-month');
            if (today) classes.push('calendar-day--today');
            return (
              <button
                type="button"
                key={cell.toISOString()}
                className={classes.join(' ')}
                onClick={() => setSelectedDay(cell)}
              >
                <div className="calendar-day__num">{cell.getDate()}</div>
                <div className="calendar-day__events">
                  {visible.map((ev) => (
                    <span
                      key={ev.id}
                      className="calendar-event-chip"
                      style={{ backgroundColor: chipColor(ev.calendarId ?? ev.id) }}
                      title={ev.summary}
                    >
                      {ev.summary || '(sem titulo)'}
                    </span>
                  ))}
                  {extra > 0 && (
                    <span className="calendar-event-chip calendar-event-chip--more">
                      +{extra} mais
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </ModalShell>

      {selectedDay && (
        <DayDetailModal
          date={selectedDay}
          events={selectedEvents}
          ws={ws}
          onClose={() => {
            setSelectedDay(null);
            // Refresh in case Seraphine just created/edited/deleted something.
            void fetchEvents();
          }}
        />
      )}
    </>
  );
}
