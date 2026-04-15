import { BellIcon, ClockIcon, CalendarIcon, RepeatIcon } from '../icons/Icons';

export interface ReminderData {
  id: string;
  message: string;
  fire_at?: string;
  date?: string;
  time?: string;
  recurring?: string | null;
}

const RECURRING_LABELS: Record<string, string> = {
  daily: 'Diario',
  weekly: 'Semanal',
  hourly: 'A cada hora',
};

export function ReminderChatBlock({ reminder }: { reminder: ReminderData }): JSX.Element {
  // Format date as DD/MM
  let dateLabel = '';
  if (reminder.date && reminder.date.length >= 10) {
    dateLabel = `${reminder.date.slice(8, 10)}/${reminder.date.slice(5, 7)}`;
  }

  return (
    <div className="rich-card rich-card--reminder">
      <div className="task-chat-card__header">
        <span className="rich-card__icon rich-card__icon--reminder">
          <BellIcon size={16} />
        </span>
        <div>
          <div className="rich-card__title">Lembrete</div>
          <div className="rich-card__subtitle">
            {reminder.recurring
              ? RECURRING_LABELS[reminder.recurring] || reminder.recurring
              : 'Unico'}
          </div>
        </div>
      </div>

      <div className="reminder-chat-block__body">
        <div className="reminder-chat-block__message">{reminder.message}</div>
        <div className="reminder-chat-block__details">
          {dateLabel && (
            <span className="reminder-chat-block__detail">
              <CalendarIcon size={14} />
              <span>{dateLabel}</span>
            </span>
          )}
          {reminder.time && (
            <span className="reminder-chat-block__detail">
              <ClockIcon size={14} />
              <span>{reminder.time}</span>
            </span>
          )}
          {reminder.recurring && (
            <span className="reminder-chat-block__detail">
              <RepeatIcon size={14} />
              <span>{RECURRING_LABELS[reminder.recurring] || reminder.recurring}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
