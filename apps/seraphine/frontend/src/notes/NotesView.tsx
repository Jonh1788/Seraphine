import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, NotesIcon, SearchIcon } from '../icons/Icons';
import { createNote, deleteNote, fetchTags, getNote, listNotes, updateNote } from './api';
import { NoteEditor } from './NoteEditor';
import type { Note, TagCount } from './types';

interface NotesViewProps {
  onBack: () => void;
  /** Optional deep-link: auto-select this note id once the list loads. */
  initialNoteId?: string | null;
}

function formatDate(iso: string): string {
  if (!iso || iso.length < 10) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    if (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    ) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function preview(content: string, limit = 90): string {
  const stripped = (content || '').replace(/[#*_>`\-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, limit - 1).trimEnd() + '...';
}

export function NotesView({ onBack, initialNoteId }: NotesViewProps): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialApplied, setInitialApplied] = useState(false);

  // Tag filter state (SDD-084).
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  const refresh = useCallback(
    async (q?: string, tag?: string): Promise<Note[]> => {
      setLoading(true);
      setError(null);
      try {
        const list = await listNotes(q, 100, tag);
        setNotes(list);
        return list;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return [];
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const refreshTags = useCallback(async () => {
    try {
      const tags = await fetchTags();
      setAllTags(tags);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshTags();
  }, [refresh, refreshTags]);

  // Debounced search
  useEffect(() => {
    const handle = setTimeout(() => {
      // When filtering by tag, pass the first active tag to the API.
      // Multi-tag is handled client-side below.
      const tagFilter = activeTags.size === 1 ? [...activeTags][0] : undefined;
      void refresh(query, tagFilter);
    }, 200);
    return () => clearTimeout(handle);
  }, [query, activeTags, refresh]);

  // Apply deep-link ?note={id} once after the first list loads.
  useEffect(() => {
    if (initialApplied) return;
    if (!initialNoteId) {
      setInitialApplied(true);
      return;
    }
    if (notes.some((n) => n.id === initialNoteId)) {
      setSelectedId(initialNoteId);
      setInitialApplied(true);
    } else if (notes.length > 0) {
      // List loaded but note not found -- stop trying.
      setInitialApplied(true);
    }
  }, [initialApplied, initialNoteId, notes]);

  // Client-side multi-tag filter: when more than 1 tag is active,
  // filter notes that contain ALL active tags.
  const filteredNotes = useMemo(() => {
    if (activeTags.size <= 1) return notes;
    return notes.filter((n) =>
      [...activeTags].every((t) => n.tags.includes(t)),
    );
  }, [notes, activeTags]);

  const selected = useMemo(
    () => filteredNotes.find((n) => n.id === selectedId) ?? null,
    [filteredNotes, selectedId],
  );

  const handleNew = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const note = await createNote({ title: 'Sem titulo', content: '', tags: [] });
      setQuery('');
      setActiveTags(new Set());
      const list = await refresh();
      setSelectedId(note.id);
      // If refresh raced, at least ensure the new note is in state.
      if (!list.some((n) => n.id === note.id)) {
        setNotes((prev) => [note, ...prev]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleSave = useCallback(
    async (patch: { title: string; content: string; tags: string[] }): Promise<void> => {
      if (!selected) return;
      setBusy(true);
      try {
        const updated = await updateNote(selected.id, patch);
        setNotes((prev) => {
          const without = prev.filter((n) => n.id !== updated.id);
          return [updated, ...without];
        });
        setSelectedId(updated.id);
        void refreshTags();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [selected, refreshTags],
  );

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await deleteNote(selected.id);
      setSelectedId(null);
      await refresh(query);
      void refreshTags();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selected, refresh, query, refreshTags]);

  const toggleTag = useCallback((tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  // Navigate to a note by ID or by title (title:XYZ pattern from wiki links).
  const handleNavigate = useCallback(
    async (target: string) => {
      if (target.startsWith('title:')) {
        const titleQuery = target.slice(6);
        // Try to find in current note list first.
        const match = notes.find(
          (n) => n.title.toLowerCase() === titleQuery.toLowerCase(),
        );
        if (match) {
          setSelectedId(match.id);
          return;
        }
        // Otherwise search via API.
        try {
          const results = await listNotes(titleQuery, 5);
          const exact = results.find(
            (n) => n.title.toLowerCase() === titleQuery.toLowerCase(),
          );
          if (exact) {
            // Ensure note is in local list and select it.
            setNotes((prev) =>
              prev.some((n) => n.id === exact.id)
                ? prev
                : [exact, ...prev],
            );
            setSelectedId(exact.id);
          }
        } catch {
          // swallow
        }
      } else {
        // Direct ID navigation.
        if (notes.some((n) => n.id === target)) {
          setSelectedId(target);
        } else {
          // Fetch the note and add to local list.
          try {
            const note = await getNote(target);
            setNotes((prev) =>
              prev.some((n) => n.id === note.id) ? prev : [note, ...prev],
            );
            setSelectedId(note.id);
          } catch {
            // swallow
          }
        }
      }
    },
    [notes],
  );

  return (
    <div className="tasks-view notes-view">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button
            className="memory-view__back"
            onClick={onBack}
            type="button"
            aria-label="Voltar"
          >
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <NotesIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Notas</h2>
            <p className="memory-view__subtitle">
              Anotacoes rapidas em Markdown com tags e backlinks
            </p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button
            type="button"
            className="tasks-view__new-btn"
            onClick={() => void handleNew()}
            disabled={busy}
          >
            <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
            <span>Nova nota</span>
          </button>
        </div>
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      <div className="notes-view__body">
        <aside className="notes-view__sidebar">
          <div className="notes-view__search">
            <SearchIcon size={14} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar notas..."
              className="notes-view__search-input"
            />
          </div>

          {allTags.length > 0 && (
            <div className="notes-view__tag-filter">
              {allTags.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={`notes-view__tag-pill${activeTags.has(t.name) ? ' notes-view__tag-pill--active' : ''}`}
                  onClick={() => toggleTag(t.name)}
                >
                  {t.name}
                  <span className="notes-view__tag-pill-count">{t.count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="notes-view__list" role="listbox">
            {loading && filteredNotes.length === 0 ? (
              <div className="notes-view__empty-hint">Carregando...</div>
            ) : filteredNotes.length === 0 ? (
              <div className="notes-view__empty-hint">
                {query.trim() || activeTags.size > 0 ? 'Sem resultados.' : 'Sem notas. Crie a primeira.'}
              </div>
            ) : (
              filteredNotes.map((note) => {
                const active = note.id === selectedId;
                return (
                  <button
                    key={note.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`notes-view__item${active ? ' notes-view__item--active' : ''}`}
                    onClick={() => setSelectedId(note.id)}
                  >
                    <div className="notes-view__item-title">
                      {note.title || 'Sem titulo'}
                    </div>
                    {preview(note.content) && (
                      <div className="notes-view__item-preview">
                        {preview(note.content)}
                      </div>
                    )}
                    <div className="notes-view__item-meta">
                      <span>{formatDate(note.updated_at)}</span>
                      {note.tags.length > 0 && (
                        <span className="notes-view__item-tags">
                          {note.tags.slice(0, 3).map((t) => (
                            <span key={t} className="notes-view__item-tag">{t}</span>
                          ))}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="notes-view__main">
          {selected ? (
            <NoteEditor
              note={selected}
              busy={busy}
              onSave={(patch) => void handleSave(patch)}
              onDelete={() => void handleDelete()}
              onNavigate={(target) => void handleNavigate(target)}
            />
          ) : (
            <div className="notes-view__empty">
              <div className="notes-view__empty-icon">
                <NotesIcon size={32} />
              </div>
              <p className="notes-view__empty-title">
                Selecione uma nota ou crie uma nova
              </p>
              <p className="notes-view__empty-hint">
                Use Markdown no corpo da nota: cabecalhos, listas, negrito,
                codigo. Tags ajudam na busca. Use [[titulo]] para criar backlinks.
              </p>
              <button
                type="button"
                className="tasks-view__new-btn"
                onClick={() => void handleNew()}
                disabled={busy}
              >
                <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
                <span>Nova nota</span>
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
