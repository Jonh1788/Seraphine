import { RepeatIcon, ClockIcon } from '../icons/Icons';

const FREQ_LABELS: Record<string, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

export interface RecurringRule {
  id: string;
  title: string;
  frequency: string;
  weekday?: number | null;
  day_of_month?: number | null;
  time?: string | null;
}

export interface RecurringChatBlockProps {
  rule: RecurringRule;
}

export function RecurringChatBlock({ rule }: RecurringChatBlockProps): JSX.Element {
  const freqLabel = FREQ_LABELS[rule.frequency] || rule.frequency;

  let schedule = freqLabel;
  if (rule.frequency === 'weekly' && rule.weekday != null) {
    schedule += ` (${WEEKDAY_LABELS[rule.weekday] || rule.weekday})`;
  } else if (rule.frequency === 'monthly' && rule.day_of_month != null) {
    schedule += ` (dia ${rule.day_of_month})`;
  }

  return (
    <div className="rich-card rich-card--recurring">
      <div className="task-chat-card__header">
        <span className="rich-card__icon rich-card__icon--recurring">
          <RepeatIcon size={16} />
        </span>
        <div>
          <div className="rich-card__title">Tarefa Recorrente</div>
          <div className="rich-card__subtitle">{freqLabel}</div>
        </div>
      </div>

      <div className="recurring-chat-block__body">
        <div className="recurring-chat-block__title">{rule.title}</div>
        <div className="recurring-chat-block__detail">
          <RepeatIcon size={14} />
          <span>{schedule}</span>
        </div>
        {rule.time && (
          <div className="recurring-chat-block__detail">
            <ClockIcon size={14} />
            <span>{rule.time}</span>
          </div>
        )}
      </div>
    </div>
  );
}
