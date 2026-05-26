/** 091 -- Individual reading item card. */

import { useState } from 'react';
import { motion } from 'framer-motion';
import type { ReadingItem, ReadingStatus } from './types';
import { STATUS_LABELS } from './types';

interface ReadingItemCardProps {
  item: ReadingItem;
  onUpdate: (id: string, status: ReadingStatus) => void;
  onDelete: (id: string) => void;
  onFlashcards: (item: ReadingItem) => void;
}

const STATUS_COLORS: Record<ReadingStatus, string> = {
  processing: '#f59e0b',
  unread: '#a78bfa',
  reading: '#3b82f6',
  read: '#10b981',
  archived: '#555570',
  error: '#ef4444',
};

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch {
    return '';
  }
}

function truncate(text: string, limit: number): string {
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + '...';
}

export function ReadingItemCard({
  item,
  onUpdate,
  onDelete,
  onFlashcards,
}: ReadingItemCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const isProcessing = item.status === 'processing';
  const isError = item.status === 'error';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="reading-card"
    >
      {/* Header row: domain + status */}
      <div className="reading-card__header">
        <span className="reading-card__domain">
          <img
            src={`https://www.google.com/s2/favicons?domain=${item.domain}&sz=16`}
            alt=""
            width={14}
            height={14}
            className="reading-card__favicon"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          {item.domain || 'link'}
        </span>
        <span
          className="reading-card__status"
          style={{ background: STATUS_COLORS[item.status] + '22', color: STATUS_COLORS[item.status] }}
        >
          {isProcessing && <span className="reading-card__spinner" />}
          {STATUS_LABELS[item.status]}
        </span>
      </div>

      {/* Title */}
      <div className="reading-card__title">
        {item.title || item.url}
      </div>

      {/* Summary */}
      {item.summary && (
        <div className="reading-card__summary">
          {truncate(item.summary, 200)}
        </div>
      )}

      {/* Error */}
      {isError && item.error_msg && (
        <div className="reading-card__error">
          {item.error_msg}
        </div>
      )}

      {/* Tags */}
      {item.tags && item.tags.length > 0 && (
        <div className="reading-card__tags">
          {item.tags.map((tag) => (
            <span key={tag} className="reading-card__tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: date + actions */}
      <div className="reading-card__footer">
        <span className="reading-card__date">{formatDate(item.saved_at)}</span>

        <div className="reading-card__actions">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="reading-card__btn"
            title="Abrir link"
          >
            Abrir
          </a>

          {isError && (
            <button
              type="button"
              className="reading-card__btn"
              onClick={() => onUpdate(item.id, 'unread')}
              title="Reprocessar"
            >
              Retentar
            </button>
          )}

          {!isError && !isProcessing && (
            <div className="reading-card__menu-wrap">
              <button
                type="button"
                className="reading-card__btn"
                onClick={() => setMenuOpen((v) => !v)}
              >
                Acoes
              </button>
              {menuOpen && (
                <div className="reading-card__menu" onMouseLeave={() => setMenuOpen(false)}>
                  {item.status !== 'read' && (
                    <button
                      type="button"
                      onClick={() => { onUpdate(item.id, 'read'); setMenuOpen(false); }}
                    >
                      Marcar como lido
                    </button>
                  )}
                  {item.status !== 'reading' && item.status !== 'read' && (
                    <button
                      type="button"
                      onClick={() => { onUpdate(item.id, 'reading'); setMenuOpen(false); }}
                    >
                      Marcar como lendo
                    </button>
                  )}
                  {item.status !== 'archived' && (
                    <button
                      type="button"
                      onClick={() => { onUpdate(item.id, 'archived'); setMenuOpen(false); }}
                    >
                      Arquivar
                    </button>
                  )}
                  {item.content_text && (
                    <button
                      type="button"
                      onClick={() => { onFlashcards(item); setMenuOpen(false); }}
                    >
                      Gerar flashcards
                    </button>
                  )}
                  <button
                    type="button"
                    className="reading-card__menu-danger"
                    onClick={() => { onDelete(item.id); setMenuOpen(false); }}
                  >
                    Excluir
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
