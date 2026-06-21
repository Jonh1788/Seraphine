import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { SparkleIcon } from '../icons/Icons';
import { MoodFace, moodFromValence } from './moods';
import type { JournalEntry } from './types';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function dayParts(iso: string): { day: string; wd: string } {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { day: '', wd: '' };
    return { day: String(d.getDate()), wd: WEEKDAYS[d.getDay()] };
  } catch {
    return { day: '', wd: '' };
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function preview(content: string, limit = 180): string {
  const stripped = (content || '').replace(/[#*_>`\-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, limit - 1).trimEnd() + '...';
}

/**
 * Per-entry Seraphine reflection. User entries now carry a real LLM-generated
 * `reflection` (best-effort, may be null). Proactive (Seraphine-authored)
 * entries are themselves the reflection, so we surface their own content.
 */
function reflectionText(entry: JournalEntry): string | null {
  if (entry.source === 'user') {
    const r = entry.reflection?.trim();
    return r ? r : null;
  }
  const txt = preview(entry.content, 220);
  return txt || null;
}

interface JournalEntryCardProps {
  entry: JournalEntry;
  onEdit?: (entry: JournalEntry) => void;
  onDelete?: (entry: JournalEntry) => void;
}

export function JournalEntryCard({ entry, onEdit, onDelete }: JournalEntryCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isEditable = entry.source === 'user';
  const { day, wd } = dayParts(entry.date);
  const mood = moodFromValence(entry.mood_valence);
  const reflection = reflectionText(entry);

  return (
    <div className="journal-row">
      <div className="journal-row__gutter">
        <div className="journal-row__day journal-card__day">{day}</div>
        <div className="journal-row__wd">{wd}</div>
      </div>

      <motion.div
        className="journal-card"
        layout
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div className="journal-card__head journal-card__header">
          <span
            className="journal-card__emoji"
            style={{ color: mood.color }}
            title={entry.mood_label ?? mood.label}
          >
            <MoodFace mood={mood.key} size={16} />
          </span>
          <h3 className="journal-card__title">{entry.title}</h3>
          <span className="journal-card__time">{formatTime(entry.date)}</span>
        </div>

        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              key="full"
              className="journal-card__body journal-card__content markdown-body"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Markdown rehypePlugins={[rehypeRaw]}>{entry.content}</Markdown>
            </motion.div>
          ) : (
            <motion.div
              key="preview"
              className="journal-card__body journal-card__preview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {preview(entry.content)}
            </motion.div>
          )}
        </AnimatePresence>

        {entry.tags.length > 0 && (
          <div className="journal-card__tags">
            {entry.tags.map((t) => (
              <span key={t} className="journal-card__tag">#{t}</span>
            ))}
          </div>
        )}

        {reflection && (
          <div className="journal-card__reflection">
            <SparkleIcon size={14} />
            <span>{reflection}</span>
          </div>
        )}

        {expanded && isEditable && (
          <div className="journal-card__actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="journal-card__action-btn"
              onClick={() => onEdit?.(entry)}
            >
              Editar
            </button>
            <button
              type="button"
              className="journal-card__action-btn journal-card__action-btn--danger"
              onClick={() => onDelete?.(entry)}
            >
              Excluir
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
