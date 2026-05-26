import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { TrashIcon, XIcon } from '../icons/Icons';
import { useConfirm } from '../ui';
import type { Note, NoteRef } from './types';

interface NoteEditorProps {
  note: Note;
  busy?: boolean;
  onSave: (patch: { title: string; content: string; tags: string[] }) => void;
  onDelete: () => void;
  /** Navigate to a note by title (for backlink / [[wiki]] clicks). */
  onNavigate?: (noteId: string) => void;
}

/**
 * Replace ``[[title]]`` in markdown content with a clickable HTML link
 * so the preview renders them as navigable references.
 */
function renderWikiLinks(raw: string): string {
  return raw.replace(
    /\[\[([^\[\]]+?)\]\]/g,
    (_match, title: string) =>
      `<a class="note-editor__wikilink" data-wikilink="${title.trim()}">${title.trim()}</a>`,
  );
}

/**
 * Split-pane Markdown editor: textarea on the left, rendered preview on
 * the right. Title + chip-based tag input at the top. "Salvar" is manual;
 * "Excluir" prompts a native confirm before firing.
 *
 * SDD-084 additions:
 * - [[wiki]] links rendered as clickable links in the preview.
 * - Backlinks section at the bottom.
 * - Clickable checkboxes in preview toggle the markdown and save.
 */
export function NoteEditor({
  note,
  busy,
  onSave,
  onDelete,
  onNavigate,
}: NoteEditorProps): JSX.Element {
  const confirm = useConfirm();
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tags, setTags] = useState<string[]>(note.tags);
  const [tagDraft, setTagDraft] = useState('');
  const previewRef = useRef<HTMLDivElement>(null);

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

  // Toggle a checkbox at line-level in the markdown content.
  const toggleCheckbox = useCallback(
    (lineIndex: number) => {
      const lines = content.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length) return;
      const line = lines[lineIndex];
      const unchecked = /^([ \t]*-\s+)\[ \](\s+.+)$/;
      const checked = /^([ \t]*-\s+)\[[xX]\](\s+.+)$/;
      if (unchecked.test(line)) {
        lines[lineIndex] = line.replace(unchecked, '$1[x]$2');
      } else if (checked.test(line)) {
        lines[lineIndex] = line.replace(checked, '$1[ ]$2');
      } else {
        return;
      }
      const updated = lines.join('\n');
      setContent(updated);
      // Auto-save the toggle immediately.
      const cleanTitle = title.trim();
      if (cleanTitle) {
        onSave({ title: cleanTitle, content: updated, tags });
      }
    },
    [content, title, tags, onSave],
  );

  // Handle clicks in the preview area: wiki links and checkboxes.
  const handlePreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      // Wiki link click.
      if (target.classList.contains('note-editor__wikilink')) {
        e.preventDefault();
        const linkTitle = target.getAttribute('data-wikilink');
        if (linkTitle) {
          // Find matching backlink/note by title (case-insensitive).
          const allRefs = [
            ...(note.backlinks ?? []),
          ];
          // Also check linked references from the note content — we need
          // to look through all known notes. For now, navigate via title
          // by finding it in backlinks or a known note. If not found, the
          // parent can handle it.
          const match = allRefs.find(
            (r) => r.title.toLowerCase() === linkTitle.toLowerCase(),
          );
          if (match && onNavigate) {
            onNavigate(match.id);
          }
          // If not found in backlinks, the parent NotesView handles lookup.
          else if (onNavigate) {
            // Pass empty string as signal to search by title.
            onNavigate(`title:${linkTitle}`);
          }
        }
        return;
      }
      // Checkbox click in the rendered preview.
      const input = target.closest('input[type="checkbox"]') as HTMLInputElement | null;
      if (input) {
        e.preventDefault();
        // Find the line index from the data attribute.
        const lineAttr = input.getAttribute('data-line');
        if (lineAttr != null) {
          toggleCheckbox(Number(lineAttr));
        }
      }
    },
    [note.backlinks, onNavigate, toggleCheckbox],
  );

  // Cmd/Ctrl+S -- quick save
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (dirty && !busy) handleSave();
    }
  };

  // Pre-process markdown for the preview: replace [[links]] and annotate checkboxes.
  const processedContent = useMemo(() => {
    if (!content.trim()) return '';
    let md = renderWikiLinks(content);
    // Annotate checkbox lines with data-line indices so clicks can toggle them.
    let lineCounter = 0;
    const originalLines = content.split('\n');
    md = md.replace(
      /^([ \t]*-\s+)\[([ xX])\](\s+.+)$/gm,
      (_match, prefix: string, check: string, rest: string) => {
        // Find the line index for this checkbox in the original content.
        const fullLine = _match;
        while (lineCounter < originalLines.length) {
          const origWithLinks = renderWikiLinks(originalLines[lineCounter]);
          if (origWithLinks.trim() === fullLine.trim()) {
            break;
          }
          lineCounter++;
        }
        const idx = lineCounter;
        lineCounter++;
        const isChecked = check.toLowerCase() === 'x';
        return `${prefix}<input type="checkbox" ${isChecked ? 'checked' : ''} data-line="${idx}" readonly />${rest}`;
      },
    );
    return md;
  }, [content]);

  const backlinks: NoteRef[] = note.backlinks ?? [];

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
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div
          className="note-editor__preview markdown-body"
          ref={previewRef}
          onClick={handlePreviewClick}
        >
          {processedContent ? (
            <Markdown rehypePlugins={[rehypeRaw]}>{processedContent}</Markdown>
          ) : (
            <p className="note-editor__preview-empty">
              Preview do Markdown aparece aqui.
            </p>
          )}

          {backlinks.length > 0 && (
            <div className="note-editor__backlinks">
              <h4 className="note-editor__backlinks-title">Referenciada por</h4>
              <div className="note-editor__backlinks-list">
                {backlinks.map((bl) => (
                  <button
                    key={bl.id}
                    type="button"
                    className="note-editor__backlink"
                    onClick={() => onNavigate?.(bl.id)}
                  >
                    {bl.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
