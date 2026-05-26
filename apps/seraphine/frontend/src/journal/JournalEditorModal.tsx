import { useEffect, useState } from 'react';
import { XIcon } from '../icons/Icons';
import type { JournalEntry } from './types';

interface JournalEditorModalProps {
  /** If provided, editing an existing entry. Otherwise creating a new one. */
  entry?: JournalEntry | null;
  busy?: boolean;
  onSave: (data: { title: string; content: string; tags: string[] }) => void;
  onClose: () => void;
}

export function JournalEditorModal({
  entry,
  busy,
  onSave,
  onClose,
}: JournalEditorModalProps): JSX.Element {
  const [title, setTitle] = useState(entry?.title ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [tagsRaw, setTagsRaw] = useState(entry?.tags?.join(', ') ?? '');

  useEffect(() => {
    setTitle(entry?.title ?? '');
    setContent(entry?.content ?? '');
    setTagsRaw(entry?.tags?.join(', ') ?? '');
  }, [entry]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = (): void => {
    const t = title.trim();
    if (!t) return;
    const tags = tagsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onSave({ title: t, content, tags });
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="journal-modal-overlay" onClick={onClose}>
      <div
        className="journal-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="journal-modal__header">
          <h3 className="journal-modal__title">
            {entry ? 'Editar entrada' : 'Nova entrada'}
          </h3>
          <button
            type="button"
            className="journal-modal__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="journal-modal__body">
          <label className="journal-modal__label">
            <span>Titulo</span>
            <input
              className="journal-modal__input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Titulo da entrada..."
              disabled={busy}
              autoFocus
            />
          </label>

          <label className="journal-modal__label">
            <span>Conteudo (Markdown)</span>
            <textarea
              className="journal-modal__textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Escreva aqui..."
              rows={10}
              disabled={busy}
            />
          </label>

          <label className="journal-modal__label">
            <span>Tags (separadas por virgula)</span>
            <input
              className="journal-modal__input"
              type="text"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="reflexao, pessoal, trabalho"
              disabled={busy}
            />
          </label>
        </div>

        <div className="journal-modal__footer">
          <button
            type="button"
            className="journal-modal__btn journal-modal__btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="journal-modal__btn journal-modal__btn--primary"
            onClick={handleSubmit}
            disabled={busy || !title.trim()}
          >
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
