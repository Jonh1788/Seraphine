/** 091 -- Individual reading item card (Obsidian colored-cover tile). */

import { useState } from 'react';
import { motion } from 'framer-motion';
import type { ReadingItem, ReadingKind, ReadingStatus } from './types';

interface ReadingItemCardProps {
  item: ReadingItem;
  onUpdate: (id: string, status: ReadingStatus) => void;
  onDelete: (id: string) => void;
  onFlashcards: (item: ReadingItem) => void;
  onProgress: (id: string, progress: number) => void;
}

/* Decorative cover gradients. There is no backend cover/image field, so the
   color is purely cosmetic: read/archived items use the neutral gray, and
   everything else gets a stable hue picked deterministically from the item id
   so a card keeps the same color across renders. */
const COVER_GRADIENTS: [string, string][] = [
  ['#5c6bc0', '#3949ab'], // indigo
  ['#26a69a', '#00796b'], // teal
  ['#42a5f5', '#1976d2'], // blue
  ['#ab47bc', '#7b1fa2'], // purple
  ['#ff7043', '#e64a19'], // orange
];
const READ_GRADIENT: [string, string] = ['#78909c', '#455a64']; // neutral gray

function hashIndex(seed: string, len: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h % len;
}

function coverFor(item: ReadingItem): [string, string] {
  if (item.status === 'read' || item.status === 'archived') return READ_GRADIENT;
  return COVER_GRADIENTS[hashIndex(item.id || item.url, COVER_GRADIENTS.length)];
}

/* kind is a client-side heuristic by domain -- there is no backend `kind`
   column, so a card is classified "livro" only by the host. */
function deriveKind(item: ReadingItem): ReadingKind {
  if (item.kind) return item.kind;
  const d = (item.domain || '').toLowerCase();
  const isBookish = /goodreads|amazon|books?\.|leanpub|manning|oreilly/.test(d);
  return isBookish ? 'livro' : 'artigo';
}

/* Reading-time estimate. There is no stored duration_min column, so this is a
   client-side estimate from the real content_text word count at ~200 wpm.
   Returns null when there is no content to estimate from. */
function readMinutes(item: ReadingItem): number | null {
  if (typeof item.duration_min === 'number') return item.duration_min;
  const words = (item.content_text || item.summary || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return null;
  return Math.max(1, Math.round(words / 200)); // ~200 wpm
}

function metaLine(item: ReadingItem): string {
  const kindLabel = deriveKind(item) === 'livro' ? 'Livro' : 'Artigo';
  // Prefer the real parsed author (backend column); fall back to domain.
  const author = (item.author || '').trim();
  const source = author || item.domain || 'link';
  const parts = [kindLabel, source];
  // Show domain alongside a real author so the source is still visible.
  if (author && item.domain && item.domain !== author) parts.push(item.domain);
  const mins = readMinutes(item);
  if (deriveKind(item) === 'artigo' && mins) {
    // "~N min" — flagged as an estimate (no stored duration field).
    parts.push(`~${mins} min`);
  }
  return parts.join(' · ');
}

/* In-cover status badge label. */
const CheckMark = (): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12l4.5 4.5L19 7" />
  </svg>
);

export function ReadingItemCard({
  item,
  onUpdate,
  onDelete,
  onFlashcards,
  onProgress,
}: ReadingItemCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const isProcessing = item.status === 'processing';
  const isError = item.status === 'error';
  const isReading = item.status === 'reading';
  const isDimmed = item.status === 'read' || item.status === 'archived';

  // Real backend progress column (0-100). Clamp defensively.
  const progress =
    typeof item.progress === 'number'
      ? Math.max(0, Math.min(100, item.progress))
      : 0;
  const hasProgress = progress > 0;
  // Show the progress control on items the user is actively reading (or any
  // unread/read item) so progress can be set; hide while processing/errored.
  const canSetProgress = !isProcessing && !isError;

  const [c0, c1] = coverFor(item);

  let badge: JSX.Element;
  if (isProcessing) {
    badge = (
      <span className="reading-card__badge">
        <span className="reading-card__badge-spinner" />
        Processando
      </span>
    );
  } else if (isError) {
    badge = <span className="reading-card__badge">Erro</span>;
  } else if (isReading) {
    badge = (
      <span className="reading-card__badge">
        Lendo{hasProgress ? ` · ${progress}%` : ''}
      </span>
    );
  } else if (item.status === 'read') {
    badge = (
      <span className="reading-card__badge">
        Lido <CheckMark />
      </span>
    );
  } else if (item.status === 'archived') {
    badge = <span className="reading-card__badge">Arquivado</span>;
  } else {
    badge = <span className="reading-card__badge">Quero ler</span>;
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className={`reading-card${isDimmed ? ' reading-card--read' : ''}`}
    >
      {/* Hover action overlay (open / actions) */}
      <div className="reading-card__overlay">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="reading-card__overlay-btn"
          title="Abrir link"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6M10 14L21 3" />
          </svg>
        </a>

        {isError && (
          <button
            type="button"
            className="reading-card__overlay-btn"
            onClick={() => onUpdate(item.id, 'unread')}
            title="Reprocessar"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}

        {!isError && !isProcessing && (
          <div className="reading-card__menu-wrap">
            <button
              type="button"
              className="reading-card__overlay-btn"
              onClick={() => setMenuOpen((v) => !v)}
              title="Acoes"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="5" r="1.4" />
                <circle cx="12" cy="12" r="1.4" />
                <circle cx="12" cy="19" r="1.4" />
              </svg>
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

      {/* Colored cover band + in-cover status badge */}
      <div
        className="reading-card__cover"
        style={{ background: `linear-gradient(135deg, ${c0}, ${c1})` }}
      >
        {badge}
      </div>

      {/* Body: title + meta + (reading) progress bar */}
      <div className="reading-card__body">
        <div className="reading-card__title">{item.title || item.url}</div>
        <div className="reading-card__meta">{metaLine(item)}</div>

        {isError && item.error_msg && (
          <div className="reading-card__error">{item.error_msg}</div>
        )}

        {/* Real progress bar -- reflects the stored `progress` column. Shown
            whenever there is progress to display, regardless of status. */}
        {hasProgress && (
          <div className="reading-card__progress" aria-hidden="true">
            <div className="reading-card__progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {/* Progress control: drag to set how far you've read. Commits on
            release/change so we don't PATCH on every pixel. */}
        {canSetProgress && (
          <label className="reading-card__progress-control">
            <span className="reading-card__progress-label">
              Progresso · {progress}%
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              defaultValue={progress}
              key={progress}
              className="reading-card__progress-slider"
              aria-label={`Definir progresso de leitura (${progress}%)`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const next = Number(e.currentTarget.value);
                if (next !== progress) onProgress(item.id, next);
              }}
            />
          </label>
        )}
      </div>
    </motion.div>
  );
}
