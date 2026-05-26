import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { BookIcon, MicIcon, SunIcon } from '../icons/Icons';
import type { JournalEntry, JournalType } from './types';

const TYPE_LABELS: Record<JournalType, string> = {
  day_review: 'Revisao diaria',
  weekly_reflection: 'Reflexao semanal',
  manual: 'Entrada manual',
  voice_memo: 'Memo de voz',
};

const TYPE_CLASSES: Record<JournalType, string> = {
  day_review: 'journal-badge--day',
  weekly_reflection: 'journal-badge--week',
  manual: 'journal-badge--manual',
  voice_memo: 'journal-badge--voice',
};

function typeIcon(type: JournalType, size = 14): JSX.Element {
  switch (type) {
    case 'day_review':
      return <SunIcon size={size} />;
    case 'weekly_reflection':
      return <BookIcon size={size} />;
    case 'voice_memo':
      return <MicIcon size={size} />;
    default:
      return <BookIcon size={size} />;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const months = [
      'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
      'jul', 'ago', 'set', 'out', 'nov', 'dez',
    ];
    return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

function preview(content: string, limit = 120): string {
  const stripped = (content || '').replace(/[#*_>`\-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, limit - 1).trimEnd() + '...';
}

function moodColor(valence: number | null): string {
  if (valence == null) return 'var(--text-dim)';
  if (valence >= 0.6) return '#4ade80';
  if (valence >= 0.3) return '#a78bfa';
  if (valence >= 0) return '#f59e0b';
  return '#ef4444';
}

interface JournalEntryCardProps {
  entry: JournalEntry;
  onEdit?: (entry: JournalEntry) => void;
  onDelete?: (entry: JournalEntry) => void;
}

export function JournalEntryCard({ entry, onEdit, onDelete }: JournalEntryCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isEditable = entry.source === 'user';

  return (
    <div className="journal-card-wrapper">
      <div className="journal-timeline__dot" />
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
        <div className="journal-card__header">
          <span className="journal-card__date">{formatDate(entry.date)}</span>
          <div className="journal-card__badges">
            <span className={`journal-badge ${TYPE_CLASSES[entry.type]}`}>
              {typeIcon(entry.type)}
              <span>{TYPE_LABELS[entry.type]}</span>
            </span>
            {entry.source !== 'user' && (
              <span className="journal-badge journal-badge--auto">Auto</span>
            )}
          </div>
        </div>

        <h3 className="journal-card__title">{entry.title}</h3>

        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              key="full"
              className="journal-card__content markdown-body"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Markdown rehypePlugins={[rehypeRaw]}>{entry.content}</Markdown>
            </motion.div>
          ) : (
            <motion.p
              key="preview"
              className="journal-card__preview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {preview(entry.content)}
            </motion.p>
          )}
        </AnimatePresence>

        <div className="journal-card__footer">
          <div className="journal-card__meta">
            {entry.mood_label && (
              <span className="journal-card__mood">
                <span
                  className="journal-card__mood-dot"
                  style={{ background: moodColor(entry.mood_valence) }}
                />
                {entry.mood_label}
              </span>
            )}
            {entry.tags.length > 0 && (
              <div className="journal-card__tags">
                {entry.tags.map((t) => (
                  <span key={t} className="journal-card__tag">{t}</span>
                ))}
              </div>
            )}
          </div>
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
        </div>
      </motion.div>
    </div>
  );
}
