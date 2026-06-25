import { memo } from 'react';
import { NotesIcon } from '../icons/Icons';

export interface NoteChatBlockData {
  id: string;
  title: string;
  content: string;
  tags: string[];
}

interface NoteChatBlockProps {
  note: NoteChatBlockData;
}

/** Strip basic Markdown syntax for a one-liner preview. */
function preview(content: string, limit = 160): string {
  const stripped = (content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#*_>]+/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, limit - 1).trimEnd() + '...';
}

function openInNotesView(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'notes');
  url.searchParams.set('note', id);
  // Full reload is the simplest way to trigger the App-level URL-param
  // parser: the handler only runs once at mount and is explicitly the
  // documented entry-point for cross-view deep-links.
  window.location.assign(url.pathname + url.search);
}

function NoteChatBlockImpl({ note }: NoteChatBlockProps): JSX.Element {
  const snippet = preview(note.content);
  const title = note.title?.trim() || 'Sem titulo';

  return (
    <button
      type="button"
      className="rich-card rich-card--note"
      onClick={() => openInNotesView(note.id)}
      aria-label={`Abrir nota "${title}"`}
    >
      <div className="task-chat-card__header">
        <span className="rich-card__icon rich-card__icon--note">
          <NotesIcon size={16} />
        </span>
        <div>
          <div className="rich-card__title">{title}</div>
          <div className="rich-card__subtitle">
            {note.tags.length > 0 ? note.tags.slice(0, 3).join(' - ') : 'Nota'}
          </div>
        </div>
      </div>

      {snippet && (
        <div className="note-chat-card__body">{snippet}</div>
      )}
    </button>
  );
}

export const NoteChatBlock = memo(NoteChatBlockImpl);
