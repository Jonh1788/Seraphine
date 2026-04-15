import { useCallback, useState } from 'react';
import { TasksIcon, CircleIcon, CheckCircleIcon, ClockIcon } from '../icons/Icons';
import { API_BASE } from '../api';

export interface ChatTask {
  id: number;
  title: string;
  status: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: string | null;
}

export interface TaskChatBlockProps {
  tasks: ChatTask[];
  onOpenEditor?: (taskId: number) => void;
}

/** Format date as "HOJE" or "DD/MM". */
function dateLabel(iso: string): string {
  const today = new Date();
  const d = new Date(iso + 'T00:00:00');
  if (
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear()
  ) {
    return 'HOJE';
  }
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Group tasks by due_date, with null-date tasks under "SEM DATA". */
function groupByDate(tasks: ChatTask[]): Map<string, ChatTask[]> {
  const groups = new Map<string, ChatTask[]>();
  for (const t of tasks) {
    const key = t.due_date || '__none__';
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }
  return groups;
}

export function TaskChatBlock({ tasks, onOpenEditor }: TaskChatBlockProps): JSX.Element {
  // Track optimistic status overrides
  const [statusOverrides, setStatusOverrides] = useState<Record<number, string>>({});

  const toggleStatus = useCallback(
    (taskId: number, currentStatus: string) => {
      const nextStatus = currentStatus === 'completed' ? 'pending' : 'completed';
      // Optimistic update
      setStatusOverrides((prev) => ({ ...prev, [taskId]: nextStatus }));
      // PATCH backend
      fetch(`${API_BASE}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      }).catch(() => {
        // Revert on failure
        setStatusOverrides((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
      });
    },
    [],
  );

  const effectiveTasks = tasks.map((t) => ({
    ...t,
    status: statusOverrides[t.id] ?? t.status,
  }));

  const groups = groupByDate(effectiveTasks);
  const count = tasks.length;

  return (
    <div className="rich-card rich-card--tasks task-chat-card">
      <div className="task-chat-card__header">
        <span className="rich-card__icon rich-card__icon--tasks">
          <TasksIcon size={16} />
        </span>
        <div>
          <div className="rich-card__title">Tarefas</div>
          <div className="rich-card__subtitle">
            {count} tarefa{count !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {Array.from(groups.entries()).map(([dateKey, items]) => (
        <div key={dateKey}>
          <div className="task-chat-card__date-group">
            {dateKey === '__none__' ? 'SEM DATA' : dateLabel(dateKey)}
          </div>
          {items.map((task) => {
            const isDone = task.status === 'completed';
            return (
              <div key={task.id} className="task-chat-card__item">
                <button
                  type="button"
                  className="task-chat-card__toggle"
                  onClick={() => toggleStatus(task.id, task.status)}
                  aria-label={isDone ? 'Marcar como pendente' : 'Marcar como concluida'}
                >
                  {isDone ? <CheckCircleIcon size={16} /> : <CircleIcon size={16} />}
                </button>
                <span
                  className={`task-chat-card__title${isDone ? ' task-chat-card__title--done' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenEditor?.(task.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onOpenEditor?.(task.id);
                  }}
                  style={{ cursor: onOpenEditor ? 'pointer' : undefined }}
                >
                  {task.title}
                </span>
                {task.due_time && (
                  <span className="task-chat-card__time">
                    <ClockIcon size={12} />
                    {task.due_time}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
