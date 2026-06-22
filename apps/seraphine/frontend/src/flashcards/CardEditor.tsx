/**
 * 067 — Flashcards card editor (modal).
 *
 * A self-contained modal for creating a new card or editing an existing one.
 * No app-context coupling — it talks to the dedicated `./api` module only, so
 * it is unit-testable in isolation (see __tests__/CardEditor.test.tsx).
 *
 * Fields: front/back (textareas), tags (comma-separated <-> string[]),
 * source_url, and a per-card image area (Gerar imagem / remover imagem via
 * generateCardImage / editCard). Save routes to editCard (existing) or
 * createCard (new). Errors — including over-budget image generation — are
 * surfaced inline from the thrown `err.message`.
 */

import { useState } from 'react';
import { createCard, editCard, generateCardImage, type Card } from './api';

interface CardEditorProps {
  /** Card to edit, or null to create a new one. */
  card: Card | null;
  /** Called with the saved/updated card after a successful save. */
  onSaved: (c: Card) => void;
  /** Close the editor without saving. */
  onClose: () => void;
  /**
   * Topic for brand-new cards. Ignored when editing (the card keeps its own
   * topic). Defaults to '' — createCard requires a topic, so the deck view
   * should pass the active deck's topic when opening a "+ card".
   */
  newTopic?: string;
}

// "a, b, c" <-> ['a','b','c']; trims and drops empties.
function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function CardEditor({ card, onSaved, onClose, newTopic = '' }: CardEditorProps): JSX.Element {
  const isNew = card === null;
  const [front, setFront] = useState(card?.front ?? '');
  const [back, setBack] = useState(card?.back ?? '');
  const [tags, setTags] = useState((card?.tags ?? []).join(', '));
  const [sourceUrl, setSourceUrl] = useState(card?.source_url ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(card?.image_url ?? null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [imageError, setImageError] = useState('');

  const canSave = front.trim().length > 0 && back.trim().length > 0 && !saving;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const tagList = parseTags(tags);
      const url = sourceUrl.trim();
      if (isNew) {
        const { card: created } = await createCard({
          topic: newTopic,
          front: front.trim(),
          back: back.trim(),
          ...(tagList.length ? { tags: tagList } : {}),
          ...(url ? { source_url: url } : {}),
        });
        onSaved(created);
      } else {
        const { card: updated } = await editCard(card.id, {
          front: front.trim(),
          back: back.trim(),
          tags: tagList,
          source_url: url || null,
          image_url: imageUrl,
        });
        onSaved(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar o card.');
    } finally {
      setSaving(false);
    }
  };

  // Image generation only applies to a persisted card (it needs an id).
  const handleGenerateImage = async (): Promise<void> => {
    if (isNew || generating) return;
    setGenerating(true);
    setImageError('');
    try {
      const { card: updated } = await generateCardImage(card.id);
      setImageUrl(updated.image_url ?? null);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : 'Falha ao gerar a imagem.');
    } finally {
      setGenerating(false);
    }
  };

  const handleRemoveImage = async (): Promise<void> => {
    if (isNew || generating) return;
    setImageError('');
    // Optimistic clear; persist immediately so the change survives a reload.
    setImageUrl(null);
    try {
      await editCard(card.id, { image_url: null });
    } catch (err) {
      setImageError(err instanceof Error ? err.message : 'Falha ao remover a imagem.');
    }
  };

  return (
    <div className="fce-backdrop" onClick={onClose}>
      <div
        className="fce-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? 'Novo card' : 'Editar card'}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Escape closes the editor without saving. Stop propagation so the
          // host view's global keydown handler doesn't also react.
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="fce-modal__head">
          <h2 className="fce-modal__title">{isNew ? 'Novo card' : 'Editar card'}</h2>
          <button type="button" className="fce-modal__close" onClick={onClose} aria-label="Fechar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="fce-modal__body">
          <div className="fce-field">
            <label className="fce-label" htmlFor="fce-front">Frente</label>
            <textarea
              id="fce-front"
              className="fce-textarea"
              value={front}
              onChange={(e) => setFront(e.target.value)}
              placeholder="pergunta / frente do card"
              autoFocus
            />
          </div>

          <div className="fce-field">
            <label className="fce-label" htmlFor="fce-back">Verso</label>
            <textarea
              id="fce-back"
              className="fce-textarea"
              value={back}
              onChange={(e) => setBack(e.target.value)}
              placeholder="resposta / verso do card"
            />
          </div>

          <div className="fce-field">
            <label className="fce-label" htmlFor="fce-tags">Tags</label>
            <input
              id="fce-tags"
              type="text"
              className="fce-input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="separadas por vírgula (ex: rust, memória)"
            />
          </div>

          <div className="fce-field">
            <label className="fce-label" htmlFor="fce-source">Fonte (URL)</label>
            <input
              id="fce-source"
              type="url"
              className="fce-input"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="fce-field">
            <span className="fce-label">Imagem</span>
            {imageUrl && (
              <img className="flashcards__card-img fce-image" src={imageUrl} alt="" />
            )}
            <div className="fce-image__row">
              <button
                type="button"
                className="obs-btn obs-btn--ghost"
                onClick={() => void handleGenerateImage()}
                disabled={isNew || generating}
                title={isNew ? 'Salve o card antes de gerar uma imagem' : undefined}
              >
                {generating && <span className="fcd-create__spinner" aria-hidden="true" />}
                {generating ? 'gerando...' : 'Gerar imagem'}
              </button>
              {imageUrl && (
                <button
                  type="button"
                  className="obs-btn obs-btn--ghost"
                  onClick={() => void handleRemoveImage()}
                  disabled={generating}
                >
                  remover imagem
                </button>
              )}
            </div>
            {isNew && (
              <div className="fce-hint">Salve o card antes de gerar uma imagem.</div>
            )}
            {imageError && <div className="fce-error">{imageError}</div>}
          </div>
        </div>

        <div className="fce-modal__foot">
          {error && <div className="fce-error fce-error--foot">{error}</div>}
          <div className="fce-modal__actions">
            <button type="button" className="obs-btn obs-btn--ghost" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="button"
              className="obs-btn obs-btn--primary"
              onClick={() => void handleSave()}
              disabled={!canSave}
            >
              {saving ? 'salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
