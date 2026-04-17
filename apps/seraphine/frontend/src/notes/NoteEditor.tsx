import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { TrashIcon, XIcon } from '../icons/Icons';
import { useConfirm } from '../ui';
import type { Note } from './types';

interface NoteEditorProps {
  note: Note;
  busy?: boolean;
  onSave: (patch: { title: string; content: string; tags: string[] }) => void;
  onDelete: () => void;
}

/**
 * Split-pane Markdown editor: textarea on the left, rendered preview on
 * the right. Title + chip-based tag input at the top. "Salvar" is manual;
 * "Excluir" prompts a native confirm before firing.
 */
export function NoteEditor({ note, busy, onSave, onDelete }: NoteEditorProps): JSX.Element {
  const confirm = useConfirm();
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tags, setTags] = useState<string[]>(note.tags);
  const [tagDraft, setTagDraft] = useState('');

  // Reset local state whenever a different note is loaded.
  const noteIdRef = useRef(note.id);
  useEffect(() => {
    if (noteIdRef.current !== note.id) {
      noteIdRef.current = note.id;
      setTitle(note.title);
      setContent(note.content);
      setTags(note.tags);
      setTagDraft('');
      return;
    }
    // Same note refreshed from server (e.g. after save) -- sync tags/title/content
    // only if the user hasn't diverged from the server copy yet.
    setTitle((prev) => (prev === noteIdRef.current ? note.title : prev));
  }, [note.id, note.title, note.content, note.tags]);

  const dirty = useMemo(() => {
    if (title !== note.title) return true;
    if (content !== note.content) return true;
    if (tags.length !== note.tags.length) return true;
    for (let i = 0; i < tags.length; i++) {
      if (tags[i] !== note.tags[i]) return true;
    }
    return false;
  }, [title, content, tags, note]);

  const addTag = (raw: string): void => {
    const t = raw.trim();
    if (!t) return;
    setTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
    setTagDraft('');
  };

  const removeTag = (t: string): void => {
    setTags((prev) => prev.filter((x) => x !== t));
  };

  const handleTagKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && tags.length > 0) {
      e.preventDefault();
      setTags((prev) => prev.slice(0, -1));
    }
  };

  const handleSave = (): void => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    onSave({ title: cleanTitle, content, tags });
  };

  const handleDelete = async (): Promise<void> => {
    if (busy) return;
    const ok = await confirm({
      title: 'Excluir nota?',
      message: `A nota "${note.title}" sera excluida permanentemente.`,
      confirmLabel: 'Excluir',
      variant: 'danger',
    });
    if (ok) onDelete();
  };

  // Cmd/Ctrl+S — quick save
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (dirty && !busy) handleSave();
    }
  };

  return (
    <div className="note-editor" onKeyDown={handleKeyDown}>
      <div className="note-editor__toolbar">
        <input
          className="note-editor__title"
          type="text"
          value={title}
          placeholder="Titulo da nota"
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
        <div className="note-editor__actions">
          <button
            type="button"
            className="note-editor__save"
            onClick={handleSave}
            disabled={!dirty || !title.trim() || busy}
          >
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
          <button
            type="button"
            className="note-editor__delete"
            onClick={handleDelete}
            disabled={busy}
            aria-label="Excluir nota"
            title="Excluir"
          >
            <TrashIcon size={16} />
          </button>
        </div>
      </div>

      <div className="note-editor__tags">
        {tags.map((t) => (
          <span key={t} className="note-editor__tag">
            {t}
            <button
              type="button"
              className="note-editor__tag-remove"
              onClick={() => removeTag(t)}
              aria-label={`Remover tag ${t}`}
              disabled={busy}
            >
              <XIcon size={12} />
            </button>
          </span>
        ))}
        <input
          className="note-editor__tag-input"
          type="text"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={handleTagKey}
          onBlur={() => addTag(tagDraft)}
          placeholder={tags.length === 0 ? 'Tags (Enter pra adicionar)' : '+ tag'}
          disabled={busy}
        />
      </div>

      <div className="note-editor__split">
        <textarea
          className="note-editor__textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# Markdown aqui..."
          disabled={busy}
          spellCheck={false}
        />
        <div className="note-editor__preview markdown-body">
          {content.trim() ? (
            <Markdown rehypePlugins={[rehypeRaw]}>{content}</Markdown>
          ) : (
            <p className="note-editor__preview-empty">
              Preview do Markdown aparece aqui.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
