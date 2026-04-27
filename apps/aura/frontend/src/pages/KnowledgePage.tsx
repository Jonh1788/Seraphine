import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
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
import { useCountUp } from "../hooks/useCountUp";

type View =
  | { kind: "list" }
  | { kind: "notes"; notebook: Notebook }
  | { kind: "note"; notebook: Notebook; note: Note };

type Tab = "notebooks" | "brain" | "diary" | "dump";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const NB_PALETTE = [
  { hex: "#7DA4FF", emoji: "📚" },
  { hex: "#2DD4BF", emoji: "💚" },
  { hex: "#F472B6", emoji: "💗" },
  { hex: "#A78BFA", emoji: "💜" },
  { hex: "#F5A623", emoji: "💛" },
];

function emojiFor(name: string): string {
  const lower = name.toLowerCase();
  if (/[\$€£]|fina|gast|salar|invest|dinheiro|banco/.test(lower)) return "💰";
  if (/pess|ami|fami|relacion/.test(lower)) return "👤";
  if (/saude|medi|treino|fitness/.test(lower)) return "🩺";
  if (/livro|leit|estud|curso|aula/.test(lower)) return "📖";
  if (/ideia|brain|inspir/.test(lower)) return "💡";
  if (/diario|diary/.test(lower)) return "📝";
  if (/empresa|trab|projeto|negoc/.test(lower)) return "💼";
  return "📚";
}

export function KnowledgePage() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [tab, setTab] = useState<Tab>("notebooks");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const searchTimer = useRef<number | null>(null);
  const [newNotebookOpen, setNewNotebookOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const totalNotes = useMemo(
    () => notebooks.reduce((acc, nb) => acc + (nb.note_count ?? 0), 0),
    [notebooks],
  );
  const totalRecords = notebooks.length + totalNotes;

  const ringRatio = useMemo(() => {
    if (totalRecords === 0) return 0;
    // Ring fills based on total records, capped at 50 (after that always full).
    return Math.max(0.05, Math.min(1, totalRecords / 50));
  }, [totalRecords]);

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  // ---- Sub-views (nesting): notes list / editor ----
  if (view.kind === "notes") {
    return (
      <NotesListView
        notebook={view.notebook}
        onBack={() => setView({ kind: "list" })}
        onOpen={(n) => setView({ kind: "note", notebook: view.notebook, note: n })}
        onChanged={loadNotebooks}
      />
    );
  }
  if (view.kind === "note") {
    return (
      <NoteEditorView
        notebook={view.notebook}
        note={view.note}
        onBack={() => setView({ kind: "notes", notebook: view.notebook })}
        onUpdated={(n) => setView({ kind: "note", notebook: view.notebook, note: n })}
        onDeleted={() => {
          setView({ kind: "notes", notebook: view.notebook });
          void loadNotebooks();
        }}
      />
    );
  }

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-24 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Conhecimento
        </h1>
      </div>

      {/* h-hero ring blue */}
      <section
        className="mx-4 mb-3.5 p-4 rounded-[20px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] flex items-center gap-4 screen-item"
        style={animDelay(1)}
      >
        <RingSm ratio={ringRatio} value={totalRecords} sub="REG" />
        <div className="flex-1 min-w-0">
          <div className="font-display text-[14px] font-semibold tracking-tight text-[#EEF2FF] mb-1">
            {totalRecords === 0 ? "Início" : "Coleção viva"}
          </div>
          <div className="text-[11px] leading-snug mb-2" style={{ color: "#8B9CC8" }}>
            {totalRecords === 0
              ? "Comece a registrar seus pensamentos."
              : "Explore, pesquise e construa novos contextos."}
          </div>
          <div className="text-[11px]" style={{ color: "#4D5E8A" }}>
            {notebooks.length} caderno{notebooks.length === 1 ? "" : "s"} · {totalNotes} nota{totalNotes === 1 ? "" : "s"}
          </div>
        </div>
      </section>

      {/* search */}
      <div className="mx-4 mb-3.5 relative screen-item" style={animDelay(2)}>
        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#4D5E8A" }} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar em todas as notas…"
          className="w-full rounded-[12px] pl-10 pr-3 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={{
            background: "rgba(17,27,56,0.6)",
            border: "1px solid rgba(99,130,255,0.10)",
            color: "#EEF2FF",
          }}
        />
      </div>

      {/* pills row */}
      <div className="flex gap-1.5 px-4 mb-3.5 overflow-x-auto screen-item" style={{ ...animDelay(3), scrollbarWidth: "none" }}>
        <PillBtn active={tab === "notebooks"} onClick={() => setTab("notebooks")}>
          Cadernos · {notebooks.length}
        </PillBtn>
        <PillBtn active={tab === "brain"} onClick={() => setTab("brain")}>Cérebro</PillBtn>
        <PillBtn active={tab === "diary"} onClick={() => setTab("diary")}>Diário</PillBtn>
        <PillBtn active={tab === "dump"} onClick={() => setTab("dump")}>Brain Dump · {totalNotes}</PillBtn>
      </div>

      {searchResults !== null ? (
        <SearchResults
          results={searchResults}
          notebooks={notebooks}
          onOpen={(nb, n) => setView({ kind: "note", notebook: nb, note: n })}
        />
      ) : error ? (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg text-[11px]" style={{
          background: "rgba(255,91,114,0.12)",
          border: "1px solid rgba(255,91,114,0.2)",
          color: "#FF5B72",
        }}>
          {error}
        </div>
      ) : loading && notebooks.length === 0 ? (
        <div className="grid place-items-center py-10" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : notebooks.length === 0 ? (
        <div className="mx-4 mt-2 rounded-[18px] p-8 text-center text-[13px]" style={{
          color: "#4D5E8A",
          border: "1px dashed rgba(99,130,255,0.10)",
        }}>
          Nenhum caderno ainda. Toque em <span style={{ color: "#8B9CC8" }}>+</span> ou peça pra Aura criar um.
        </div>
      ) : (
        <ul className="px-4 flex flex-col gap-2.5">
          {notebooks.map((nb, i) => (
            <li key={nb.id} className="screen-item" style={animDelay(4 + i)}>
              <button
                type="button"
                onClick={() => setView({ kind: "notes", notebook: nb })}
                className="w-full text-left flex items-center gap-3 p-3.5 rounded-[14px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] hover:bg-[#111B38] transition-colors"
              >
                <span
                  className="grid place-items-center text-[20px] shrink-0 rounded-[12px]"
                  style={{
                    width: 44,
                    height: 44,
                    background: "rgba(79,126,255,0.12)",
                    border: "1px solid rgba(79,126,255,0.18)",
                  }}
                >
                  {emojiFor(nb.name)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[14px] font-medium text-[#EEF2FF] truncate">
                    {nb.name}
                  </span>
                  <span className="block text-[11px] mt-0.5" style={{ color: "#4D5E8A" }}>
                    Caderno · {nb.note_count > 0 ? `${nb.note_count} nota${nb.note_count === 1 ? "" : "s"}` : "vazio"}
                  </span>
                </span>
                <span
                  className="shrink-0 grid place-items-center text-[12px] font-semibold"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: nb.note_count > 0 ? "rgba(79,126,255,0.15)" : "#111B38",
                    color: nb.note_count > 0 ? "#7DA4FF" : "#4D5E8A",
                  }}
                >
                  {nb.note_count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setNewNotebookOpen(true)}
        aria-label="Novo caderno"
        className="fixed grid place-items-center transition-transform active:scale-95"
        style={{
          right: 20,
          bottom: "calc(var(--bottom-nav-h) + var(--safe-bottom) + 18px)",
          width: 50,
          height: 50,
          borderRadius: 16,
          background: "#4F7EFF",
          color: "white",
          boxShadow: "0 4px 20px rgba(79,126,255,0.5), 0 0 0 1px rgba(79,126,255,0.3)",
          zIndex: 20,
        }}
      >
        <Plus className="h-[22px] w-[22px]" strokeWidth={2.5} />
      </button>

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

function RingSm({ ratio, value, sub }: { ratio: number; value: number; sub: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - ratio);
  const animVal = useCountUp(value, 850, value);
  return (
    <div className="relative shrink-0" style={{ width: 70, height: 70 }}>
      <svg width={70} height={70} viewBox="0 0 70 70" style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={35} cy={35} r={r} fill="none" stroke="#162040" strokeWidth={6} />
        <circle
          cx={35}
          cy={35}
          r={r}
          fill="none"
          stroke="#4F7EFF"
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="ring-fill-anim"
          style={{ filter: "drop-shadow(0 0 6px rgba(79,126,255,0.5))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="font-display text-[16px] font-bold leading-none tracking-tight text-[#EEF2FF]">
            {animVal}
          </div>
          <div className="text-[8px] mt-0.5 uppercase tracking-[0.1em]" style={{ color: "#4D5E8A" }}>
            {sub}
          </div>
        </div>
      </div>
    </div>
  );
}

function PillBtn({ active = false, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[11px] font-medium tracking-[0.02em] whitespace-nowrap shrink-0 transition-colors"
      style={
        active
          ? { background: "rgba(79,126,255,0.15)", border: "1px solid rgba(79,126,255,0.3)", color: "#7DA4FF" }
          : { background: "transparent", border: "1px solid rgba(99,130,255,0.10)", color: "#4D5E8A" }
      }
    >
      {children}
    </button>
  );
}

function SearchResults({
  results,
  notebooks,
  onOpen,
}: {
  results: Note[];
  notebooks: Notebook[];
  onOpen: (nb: Notebook, n: Note) => void;
}) {
  if (results.length === 0) {
    return (
      <p className="text-[13px] text-center py-6" style={{ color: "#4D5E8A" }}>
        Nada encontrado.
      </p>
    );
  }
  const byId = new Map(notebooks.map((n) => [n.id, n]));
  return (
    <ul className="flex flex-col gap-2 px-4">
      {results.map((n) => {
        const nb = byId.get(n.notebook_id);
        if (!nb) return null;
        const preview = n.content_md.slice(0, 120).replace(/\n+/g, " ");
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onOpen(nb, n)}
              className="w-full text-left p-3 rounded-[14px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] hover:bg-[#111B38] transition-colors"
            >
              <div className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "#4D5E8A" }}>
                {nb.name}
              </div>
              <div className="text-[13px] text-[#EEF2FF] font-medium mt-0.5 truncate">
                {n.title || "Sem título"}
              </div>
              {preview ? (
                <div className="text-[11px] mt-1 truncate" style={{ color: "#8B9CC8" }}>{preview}</div>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function NotesListView({
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
    if (!confirm(`Excluir caderno "${notebook.name}"? Todas as notas serão removidas.`)) return;
    await knowledgeApi.deleteNotebook(notebook.id);
    onChanged();
    onBack();
  };

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-24 relative">
      <div className="flex items-center gap-3 pt-4 px-4 pb-3.5">
        <button
          type="button"
          onClick={onBack}
          className="grid place-items-center h-10 w-10 -ml-2 rounded-lg"
          style={{ color: "#8B9CC8" }}
          aria-label="Voltar"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-[20px] mr-1">{emojiFor(notebook.name)}</span>
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-[22px] font-bold tracking-tight text-[#EEF2FF] truncate leading-tight">
            {notebook.name}
          </h1>
          <p className="text-[11px]" style={{ color: "#4D5E8A" }}>
            {notes.length} nota{notes.length === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={onDeleteNotebook}
          aria-label="Excluir caderno"
          className="grid place-items-center h-10 w-10 rounded-lg"
          style={{ color: "#4D5E8A" }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="px-4 mb-3">
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 min-h-11 rounded-lg text-[13px] font-medium text-white disabled:opacity-50"
          style={{ background: "#4F7EFF", boxShadow: "0 4px 14px rgba(79,126,255,0.4)" }}
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Nova nota
        </button>
      </div>
      {loading ? (
        <div className="grid place-items-center py-10" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : notes.length === 0 ? (
        <div className="mx-4 rounded-[18px] p-8 text-center text-[13px]" style={{ color: "#4D5E8A", border: "1px dashed rgba(99,130,255,0.10)" }}>
          Caderno vazio. Crie a primeira nota.
        </div>
      ) : (
        <ul className="px-4 flex flex-col gap-2">
          {notes.map((n) => {
            const preview = n.content_md.slice(0, 140).replace(/\n+/g, " ");
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onOpen(n)}
                  className="w-full text-left p-3 rounded-[14px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] hover:bg-[#111B38] transition-colors flex items-center gap-3"
                >
                  <FileText className="h-4 w-4 shrink-0" style={{ color: "#4D5E8A" }} strokeWidth={2.2} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[#EEF2FF] font-medium truncate">
                      {n.title || "Sem título"}
                    </div>
                    {preview ? (
                      <div className="text-[11px] mt-0.5 line-clamp-1" style={{ color: "#4D5E8A" }}>
                        {preview}
                      </div>
                    ) : null}
                  </div>
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" style={{ color: "#4D5E8A" }} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NoteEditorView({
  notebook,
  note,
  onBack,
  onUpdated,
  onDeleted,
}: {
  notebook: Notebook;
  note: Note;
  onBack: () => void;
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
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-24 px-4">
      <div className="flex items-center gap-3 pt-4 pb-3.5">
        <button
          type="button"
          onClick={onBack}
          className="grid place-items-center h-10 w-10 -ml-2 rounded-lg"
          style={{ color: "#8B9CC8" }}
          aria-label="Voltar"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-[16px] shrink-0">{emojiFor(notebook.name)}</span>
        <div className="flex-1 min-w-0 text-[12px] truncate" style={{ color: "#4D5E8A" }}>
          em <span style={{ color: "#8B9CC8" }}>{notebook.name}</span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Excluir nota"
          className="grid place-items-center h-10 w-10 rounded-lg"
          style={{ color: "#4D5E8A" }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Título"
        className="font-display text-[22px] font-bold bg-transparent text-[#EEF2FF] placeholder:text-[#4D5E8A] focus:outline-none w-full px-1 py-2 mb-2"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Escreva em markdown…"
        rows={14}
        className="w-full rounded-[14px] px-4 py-3 placeholder:text-[#4D5E8A] resize-y min-h-[40vh] font-mono text-[13px] focus:outline-none"
        style={{
          background: "rgba(17,27,56,0.6)",
          border: "1px solid rgba(99,130,255,0.10)",
          color: "#EEF2FF",
        }}
      />
      {content.trim() ? (
        <details className="mt-3 rounded-[14px] px-4 py-3" style={{ background: "rgba(17,27,56,0.4)", border: "1px solid rgba(99,130,255,0.10)" }}>
          <summary className="text-[10px] uppercase tracking-[0.08em] cursor-pointer" style={{ color: "#4D5E8A" }}>
            Pré-visualizar
          </summary>
          <div className="mt-2">
            <Markdown text={content} />
          </div>
        </details>
      ) : null}
      <div className="text-[11px] mt-2" style={{ color: "#4D5E8A" }}>
        {saving
          ? "Salvando…"
          : savedAt
            ? `Salvo · ${new Date(savedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
            : ""}
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
  const canSubmit = name.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    void onCreate(name.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Nome
        </span>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Aprendizados, Ideias…"
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={{
            background: "rgba(17,27,56,0.6)",
            border: "1px solid rgba(99,130,255,0.10)",
            color: "#EEF2FF",
          }}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-[#EEF2FF]"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canSubmit || busy}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-white font-medium disabled:opacity-50"
          style={{ background: "#4F7EFF", boxShadow: "0 4px 20px rgba(79,126,255,0.5)" }}
        >
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}

// expose unused color palette as referenced styles for tests/eslint
void NB_PALETTE;
void isoLocal;
