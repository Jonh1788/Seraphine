import { useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import { ModalShell } from './ModalShell';
import {
  fmtWeekdayLong,
  formatEventTimeRange,
  isAllDay,
} from './utils';
import type { CalendarEvent } from './types';

interface DayDetailModalProps {
  date: Date;
  events: CalendarEvent[];
  onClose: () => void;
  ws: SeraphineWS | null;
}

type InlineAction =
  | { kind: 'new' }
  | { kind: 'edit'; event: CalendarEvent };

const CALENDAR_TOOL_PREFIXES = [
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
];

/**
 * Day-level drill-down. Shows every event on the given date, lets the
 * user trigger create/edit/cancel flows by sending a prefilled
 * `user_message` through the WebSocket. Closes itself automatically
 * when a calendar tool reports `ok: true` via `tool_result`.
 */
export function DayDetailModal({
  date,
  events,
  onClose,
  ws,
}: DayDetailModalProps): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inline, setInline] = useState<InlineAction | null>(null);
  const [inlineText, setInlineText] = useState('');

  // Track request_ids of calendar write tools via `tool_request`, then
  // close the modal when the matching `tool_result` arrives with ok.
  const calendarReqIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      if (msg.type === 'tool_request') {
        if (CALENDAR_TOOL_PREFIXES.some((p) => msg.tool.startsWith(p))) {
          calendarReqIds.current.add(msg.request_id);
        }
      } else if (msg.type === 'tool_result') {
        if (!calendarReqIds.current.has(msg.request_id)) return;
        calendarReqIds.current.delete(msg.request_id);
        if (msg.ok) onClose();
      }
    });
    return off;
  }, [ws, onClose]);

  const title = fmtWeekdayLong.format(date);
  const dateShort = date.toLocaleDateString('pt-BR');

  const sendUserMessage = (content: string) => {
    if (!ws) return;
    ws.send({ type: 'user_message', content, speak: false });
  };

  const handleCancel = (ev: CalendarEvent) => {
    sendUserMessage(`Cancela o evento '${ev.summary}' do dia ${dateShort}`);
  };

  const openEdit = (ev: CalendarEvent) => {
    setInline({ kind: 'edit', event: ev });
    setInlineText(`Edita o evento '${ev.summary}': `);
  };

  const openNew = () => {
    setInline({ kind: 'new' });
    setInlineText(`Cria um evento no dia ${dateShort}: `);
  };

  const submitInline = () => {
    const text = inlineText.trim();
    if (!text) return;
    sendUserMessage(text);
    setInline(null);
    setInlineText('');
  };

  const cancelInline = () => {
    setInline(null);
    setInlineText('');
  };

  return (
    <ModalShell
      onClose={onClose}
      className="day-detail-modal"
      label={`Eventos de ${title}`}
    >
      <header className="day-detail-header">
        <h2 className="day-detail-header__title">{title}</h2>
        <button
          type="button"
          className="btn-ghost day-detail-header__close"
          onClick={onClose}
          aria-label="Fechar"
        >
          &times;
        </button>
      </header>

      <div className="day-detail-toolbar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={openNew}
          disabled={!ws}
        >
          + Novo evento
        </button>
      </div>

      {inline?.kind === 'new' && (
        <InlineInput
          value={inlineText}
          onChange={setInlineText}
          onSubmit={submitInline}
          onCancel={cancelInline}
          placeholder="Detalhes do novo evento..."
        />
      )}

      <div className="day-detail-list">
        {events.length === 0 && (
          <div className="day-detail-empty">Nenhum evento neste dia.</div>
        )}
        {events.map((ev) => {
          const expanded = expandedId === ev.id;
          const attendeeCount = ev.attendees?.length ?? 0;
          return (
            <div
              key={ev.id}
              className={`day-event-card${expanded ? ' day-event-card--expanded' : ''}`}
            >
              <button
                type="button"
                className="day-event-card__header"
                onClick={() => setExpandedId(expanded ? null : ev.id)}
              >
                <div className="day-event-card__time">
                  {formatEventTimeRange(ev)}
                </div>
                <div className="day-event-card__title">{ev.summary || '(sem titulo)'}</div>
                <div className="day-event-card__meta">
                  {ev.location && <span>{ev.location}</span>}
                  {attendeeCount > 0 && (
                    <span>
                      {attendeeCount} participante{attendeeCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {isAllDay(ev) && <span>dia inteiro</span>}
                </div>
              </button>

              {expanded && ev.description && (
                <div className="day-event-card__body">{ev.description}</div>
              )}

              <div className="day-event-card__actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => openEdit(ev)}
                  disabled={!ws}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn-ghost day-event-card__btn-danger"
                  onClick={() => handleCancel(ev)}
                  disabled={!ws}
                >
                  Cancelar
                </button>
                {ev.htmlLink && (
                  <a
                    href={ev.htmlLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-ghost"
                  >
                    Abrir no Google
                  </a>
                )}
              </div>

              {inline?.kind === 'edit' && inline.event.id === ev.id && (
                <InlineInput
                  value={inlineText}
                  onChange={setInlineText}
                  onSubmit={submitInline}
                  onCancel={cancelInline}
                  placeholder="Descreva as mudancas..."
                />
              )}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

interface InlineInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder?: string;
}

function InlineInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: InlineInputProps): JSX.Element {
  return (
    <div className="day-event-inline">
      <input
        type="text"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
          else if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="button" className="btn btn-primary" onClick={onSubmit}>
        Enviar
      </button>
      <button type="button" className="btn-ghost" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  );
}
