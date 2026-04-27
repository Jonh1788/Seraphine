import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  BookText,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import * as knowledgeApi from "../api/knowledge";
import type { Note, Notebook } from "../api/knowledge";
import { ApiError } from "../api/client";
import { Sheet } from "../components/Sheet";
import { Markdown } from "../components/Markdown";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";

type View =
  | { kind: "notebooks" }
  | { kind: "notes"; notebook: Notebook }
  | { kind: "note"; notebook: Notebook; note: Note };

export function KnowledgePage() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [view, setView] = useState<View>({ kind: "notebooks" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newNotebookOpen, setNewNotebookOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const searchTimer = useRef<number | null>(null);

  const loadNotebooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await knowledgeApi.listNotebooks();
      setNotebooks(res.notebooks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao carregar cadernos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotebooks();
  }, [loadNotebooks]);
  useRegisterPageRefresh(loadNotebooks);

  // Debounced search
  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    searchTimer.current = window.setTimeout(async () => {
      try {
        const res = await knowledgeApi.searchNotes(search.trim());
        setSearchResults(res.notes);
      } catch {
        setSearchResults([]);
      }
    }, 250);
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, [search]);

  const openNotebook = useCallback((nb: Notebook) => {
    setView({ kind: "notes", notebook: nb });
  }, []);

  const openNote = useCallback((notebook: Notebook, note: Note) => {
    setView({ kind: "note", notebook, note });
  }, []);

  return (
    <div className="flex flex-col gap-4 max-w-3xl mx-auto">
      <header className="flex items-center gap-3">
        {view.kind === "notebooks" ? (
          <Link
            to="/mais"
            className="grid place-items-center h-10 w-10 -ml-2 rounded-lg text-ink-dim hover:text-ink-primary hover:bg-white/5"
            aria-label="Voltar"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
        ) : (
          <button
            type="button"
            onClick={() =>
              view.kind === "note"
                ? setView({ kind: "notes", notebook: view.notebook })
                : setView({ kind: "notebooks" })
            }
            className="grid place-items-center h-10 w-10 -ml-2 rounded-lg text-ink-dim hover:text-ink-primary hover:bg-white/5"
            aria-label="Voltar"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <div className="h-10 w-10 rounded-xl2 bg-mod-chat/15 text-mod-chat grid place-items-center">
          <BookText className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink-primary leading-tight truncate">
            {view.kind === "notebooks"
              ? "Conhecimento"
              : view.kind === "notes"
                ? view.notebook.name
                : (view.note.title || "Sem título")}
          </h1>
          <p className="text-sm text-ink-dim truncate">
            {view.kind === "notebooks"
              ? "Cadernos, notas e brain dumps."
              : view.kind === "notes"
                ? `${view.notebook.note_count} nota(s)`
                : view.notebook.name}
          </p>
        </div>
        {view.kind === "notebooks" ? (
          <button
            type="button"
            onClick={() => setNewNotebookOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 min-h-10 rounded-lg bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base text-sm font-medium shadow-glow-blue"
          >
            <Plus className="h-4 w-4" />
            Caderno
          </button>
        ) : null}
      </header>

      {view.kind === "notebooks" ? (
        <>
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar em todas as notas…"
              className="w-full rounded-xl2 border border-white/10 bg-bg-s1/60 pl-10 pr-3 py-2.5 min-h-11 text-ink-primary placeholder:text-ink-faint focus:border-accent-blue focus:outline-none"
            />
          </div>

          {searchResults !== null ? (
            <SearchResults
              results={searchResults}
              notebooks={notebooks}
              onOpen={openNote}
            />
          ) : (
            <NotebookList
              notebooks={notebooks}
              loading={loading}
              error={error}
              onOpen={openNotebook}
            />
          )}
        </>
      ) : view.kind === "notes" ? (
        <NotesList
          notebook={view.notebook}
          onBack={() => setView({ kind: "notebooks" })}
          onOpen={(n) => openNote(view.notebook, n)}
          onChanged={loadNotebooks}
        />
      ) : (
        <NoteEditor
          notebook={view.notebook}
          note={view.note}
          onUpdated={(n) => setView({ kind: "note", notebook: view.notebook, note: n })}
          onDeleted={() => {
            setView({ kind: "notes", notebook: view.notebook });
            void loadNotebooks();
          }}
        />
      )}

      <Sheet
        open={newNotebookOpen}
        onClose={() => setNewNotebookOpen(false)}
        title="Novo caderno"
        maxWidth="max-w-sm"
      >
        <NewNotebookForm
          busy={busy}
          onCancel={() => setNewNotebookOpen(false)}
          onCreate={async (name) => {
            setBusy(true);
            try {
              const nb = await knowledgeApi.createNotebook({ name });
              setNewNotebookOpen(false);
              await loadNotebooks();
              setView({ kind: "notes", notebook: { ...nb, note_count: 0 } });
            } finally {
              setBusy(false);
            }
          }}
        />
      </Sheet>
    </div>
  );
}

function NotebookList({
  notebooks,
  loading,
  error,
  onOpen,
}: {
  notebooks: Notebook[];
  loading: boolean;
  error: string | null;
  onOpen: (nb: Notebook) => void;
}) {
  if (loading) {
    return (
      <div className="grid place-items-center py-10 text-ink-faint">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (notebooks.length === 0) {
    return (
      <div className="rounded-xl3 border border-dashed border-white/10 p-10 text-center text-ink-faint">
        Nenhum caderno ainda. Toque em <span className="text-ink-dim">Caderno</span> pra criar o primeiro.
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {notebooks.map((nb) => (
        <li key={nb.id}>
          <button
            type="button"
            onClick={() => onOpen(nb)}
            className="w-full text-left flex items-center gap-3 p-4 rounded-xl2 bg-bg-s1/70 border border-white/8 hover:bg-bg-s2 hover:border-white/15 transition-colors"
          >
            <span className="h-12 w-12 rounded-xl2 bg-mod-chat/20 text-mod-chat grid place-items-center shrink-0">
              <BookText className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-display text-base font-semibold text-ink-primary truncate">
                {nb.name}
              </span>
              <span className="block text-xs text-ink-faint mt-0.5">
                {nb.note_count} nota(s)
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-ink-faint shrink-0" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SearchResults({
  results,
  notebooks,
  onOpen,
}: {
  results: Note[];
  notebooks: Notebook[];
  onOpen: (notebook: Notebook, note: Note) => void;
}) {
  if (results.length === 0) {
    return (
      <p className="text-sm text-ink-faint text-center py-6">
        Nada encontrado.
      </p>
    );
  }
  const byId = new Map(notebooks.map((n) => [n.id, n]));
  return (
    <ul className="flex flex-col gap-2">
      {results.map((n) => {
        const nb = byId.get(n.notebook_id);
        if (!nb) return null;
        const preview = n.content_md.slice(0, 120).replace(/\n+/g, " ");
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onOpen(nb, n)}
              className="w-full text-left p-3 rounded-xl2 bg-bg-s1/60 border border-white/8 hover:bg-bg-s2 transition-colors"
            >
              <div className="text-xs uppercase tracking-wider text-ink-faint">
                {nb.name}
              </div>
              <div className="text-sm text-ink-primary font-medium mt-0.5 truncate">
                {n.title || "Sem título"}
              </div>
              {preview ? (
                <div className="text-xs text-ink-dim mt-1 truncate">{preview}</div>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function NotesList({
  notebook,
  onBack,
  onOpen,
  onChanged,
}: {
  notebook: Notebook;
  onBack: () => void;
  onOpen: (n: Note) => void;
  onChanged: () => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await knowledgeApi.listNotes(notebook.id);
      setNotes(res.notes);
    } finally {
      setLoading(false);
    }
  }, [notebook.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onNew = async () => {
    setBusy(true);
    try {
      const note = await knowledgeApi.createNote({
        notebook_id: notebook.id,
        title: "",
        content_md: "",
      });
      onOpen(note);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const onDeleteNotebook = async () => {
    if (!confirm(`Excluir caderno "${notebook.name}"? Todas as notas serão removidas.`))
      return;
    await knowledgeApi.deleteNotebook(notebook.id);
    onChanged();
    onBack();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 min-h-11 rounded-lg bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base text-sm font-medium shadow-glow-blue disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Nova nota
        </button>
        <button
          type="button"
          onClick={onDeleteNotebook}
          aria-label="Excluir caderno"
          className="grid place-items-center h-11 w-11 rounded-lg text-ink-faint hover:text-red-300 hover:bg-white/5"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {loading ? (
        <div className="grid place-items-center py-10 text-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : notes.length === 0 ? (
        <div className="rounded-xl3 border border-dashed border-white/10 p-10 text-center text-ink-faint">
          Caderno vazio. Crie a primeira nota.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => {
            const preview = n.content_md.slice(0, 140).replace(/\n+/g, " ");
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onOpen(n)}
                  className="w-full text-left p-3 rounded-xl2 bg-bg-s1/70 border border-white/8 hover:bg-bg-s2 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="h-3.5 w-3.5 text-ink-faint" />
                    <span className="text-sm font-medium text-ink-primary truncate">
                      {n.title || "Sem título"}
                    </span>
                  </div>
                  {preview ? (
                    <div className="text-xs text-ink-dim line-clamp-2">{preview}</div>
                  ) : (
                    <div className="text-xs text-ink-faint italic">vazia</div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NoteEditor({
  notebook,
  note,
  onUpdated,
  onDeleted,
}: {
  notebook: Notebook;
  note: Note;
  onUpdated: (n: Note) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(note.title ?? "");
  const [content, setContent] = useState(note.content_md);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(note.updated_at);
  const dirtyTimer = useRef<number | null>(null);

  const persist = useCallback(
    async (nextTitle: string, nextContent: string) => {
      setSaving(true);
      try {
        const updated = await knowledgeApi.updateNote(note.id, {
          title: nextTitle,
          content_md: nextContent,
        });
        setSavedAt(updated.updated_at);
        onUpdated(updated);
      } finally {
        setSaving(false);
      }
    },
    [note.id, onUpdated],
  );

  // Autosave on idle (450ms after last keystroke)
  useEffect(() => {
    if (title === (note.title ?? "") && content === note.content_md) return;
    if (dirtyTimer.current !== null) window.clearTimeout(dirtyTimer.current);
    dirtyTimer.current = window.setTimeout(() => {
      void persist(title, content);
    }, 450);
    return () => {
      if (dirtyTimer.current !== null) window.clearTimeout(dirtyTimer.current);
    };
  }, [title, content, note.title, note.content_md, persist]);

  const onDelete = async () => {
    if (!confirm("Excluir esta nota?")) return;
    await knowledgeApi.deleteNote(note.id);
    onDeleted();
  };

  return (
    <div className="flex flex-col gap-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Título"
        className="font-display text-xl font-semibold bg-transparent text-ink-primary placeholder:text-ink-faint focus:outline-none px-1 py-2"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Escreva em markdown…"
        rows={14}
        className="rounded-xl2 border border-white/10 bg-bg-s1/60 px-4 py-3 text-ink-primary placeholder:text-ink-faint resize-y min-h-[40vh] font-mono text-sm focus:border-accent-blue focus:outline-none"
      />
      {content.trim() ? (
        <details className="rounded-xl2 border border-white/8 bg-bg-s1/40 px-4 py-3">
          <summary className="text-xs uppercase tracking-wider text-ink-faint cursor-pointer">
            Pré-visualizar
          </summary>
          <div className="mt-2">
            <Markdown text={content} />
          </div>
        </details>
      ) : null}

      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span>
          {saving
            ? "Salvando…"
            : savedAt
              ? `Salvo · ${new Date(savedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
              : ""}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md hover:text-red-300 hover:bg-white/5"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Excluir
        </button>
      </div>
      <div className="text-[10px] text-ink-faint pl-1">
        em <span className="text-ink-dim">{notebook.name}</span>
      </div>
    </div>
  );
}

function NewNotebookForm({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const canSubmit = useMemo(() => name.trim().length > 0, [name]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    void onCreate(name.trim());
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Nome
        </span>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Aprendizados, Ideias…"
          className="rounded-lg border border-white/10 bg-bg-s2/60 px-3.5 py-2.5 min-h-11 text-ink-primary placeholder:text-ink-faint focus:border-accent-blue focus:outline-none"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg bg-white/5 text-ink-primary hover:bg-white/10"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canSubmit || busy}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base font-medium shadow-glow-blue disabled:opacity-50"
        >
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}
