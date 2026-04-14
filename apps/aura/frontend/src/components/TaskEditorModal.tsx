import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Trash2,
  Maximize2,
  Minimize2,
  X,
  CircleDashed,
  Flag,
  Calendar,
  Clock,
  Tag as TagIcon,
  Check,
  Loader2,
} from "lucide-react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import * as tasksApi from "../api/tasks";
import type {
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskBody,
} from "../types/api";

// ---------- status / priority config -----------------------------------
type StatusOpt = { id: TaskStatus; label: string; dot: string; text: string };
const STATUS_OPTS: StatusOpt[] = [
  { id: "pending", label: "Para Fazer", dot: "bg-accent-purple", text: "text-accent-purple" },
  { id: "approved", label: "Fazendo", dot: "bg-cyan-400", text: "text-cyan-300" },
  { id: "completed", label: "Feito", dot: "bg-emerald-400", text: "text-emerald-300" },
];

type PrioOpt = { id: TaskPriority; label: string; dot: string; text: string };
const PRIO_OPTS: PrioOpt[] = [
  { id: "low", label: "Baixa", dot: "bg-emerald-400", text: "text-emerald-300" },
  { id: "med", label: "Média", dot: "bg-amber-400", text: "text-amber-300" },
  { id: "high", label: "Alta", dot: "bg-red-400", text: "text-red-300" },
];

// ---------- formatting helpers ------------------------------------------
const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function fmtDateLabel(iso: string | null | undefined): string {
  if (!iso) return "Sem data";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const day = parseInt(m[3], 10);
  const month = MONTHS_PT[parseInt(m[2], 10) - 1] ?? "";
  return `${day} de ${month}`;
}

function fmtTodayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ---------- picker popover ----------------------------------------------
interface PickerProps<T extends string> {
  open: boolean;
  onClose: () => void;
  options: { id: T; label: string; dot: string }[];
  value: T | null;
  onChange: (v: T | null) => void;
  allowClear?: boolean;
}

function PillPicker<T extends string>({
  open, onClose, options, value, onChange, allowClear,
}: PickerProps<T>) {
  if (!open) return null;
  return (
    <div
      className="absolute z-20 top-full left-0 mt-1 min-w-[180px] rounded-lg border border-white/10 bg-bg-elevated shadow-xl shadow-black/50 p-1"
      onClick={(e) => e.stopPropagation()}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => { onChange(o.id); onClose(); }}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-ink-primary hover:bg-white/5 text-left"
        >
          <span className={`h-2 w-2 rounded-full ${o.dot}`} />
          <span className="flex-1">{o.label}</span>
          {value === o.id ? <Check className="h-3.5 w-3.5 text-ink-dim" /> : null}
        </button>
      ))}
      {allowClear && value ? (
        <button
          type="button"
          onClick={() => { onChange(null); onClose(); }}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-ink-faint hover:bg-white/5 text-left border-t border-white/5 mt-1 pt-2"
        >
          Limpar
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------
// Main component
// ------------------------------------------------------------------------
interface Props {
  taskId: string | null;
  onClose: () => void;
  onSaved?: () => void;
  onDeleted?: () => void;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function TaskEditorModal({ taskId, onClose, onSaved, onDeleted }: Props) {
  const [task, setTask] = useState<Task | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [prioOpen, setPrioOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  // Pending patch accumulator + debounced flusher.
  const pendingRef = useRef<UpdateTaskBody>({});
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const currentIdRef = useRef<string | null>(taskId);
  currentIdRef.current = taskId;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = useCallback(async () => {
    const id = currentIdRef.current;
    if (!id) return;
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingRef.current = {};
    clearTimer();
    inFlightRef.current = true;
    setSaveState("saving");
    try {
      await tasksApi.updateTask(id, patch);
      inFlightRef.current = false;
      // Another mutation might have landed while we were saving.
      if (Object.keys(pendingRef.current).length > 0) {
        // Kick off the next save immediately.
        void flush();
      } else {
        setSaveState("saved");
        onSaved?.();
      }
    } catch {
      inFlightRef.current = false;
      setSaveState("error");
    }
  }, [onSaved]);

  const queuePatch = useCallback((patch: UpdateTaskBody) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    setSaveState("dirty");
    clearTimer();
    timerRef.current = window.setTimeout(() => { void flush(); }, 800);
  }, [flush]);

  // -------- Tiptap editor -----------------------------------------------
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Heading levels 1-3 are enough for a task description.
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder: "Escreva os detalhes…" }),
    ],
    content: "",
    editorProps: {
      attributes: {
        // Custom class targeted by globals.css for Tiptap node styles
        // (we deliberately don't depend on @tailwindcss/typography).
        class: "tiptap-editor focus:outline-none min-h-[200px] text-ink-primary",
      },
    },
    // Debounced save on every doc change.
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      setTask((prev) => (prev ? { ...prev, description: html } : prev));
      queuePatch({ description: html });
    },
  });

  // Load task on open / id change.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setTask(null);
    setLoadError(null);
    setSaveState("idle");
    pendingRef.current = {};
    clearTimer();
    void tasksApi.getTask(taskId)
      .then((t) => {
        if (cancelled) return;
        setTask(t);
        // Seed editor content WITHOUT triggering onUpdate.
        if (editor) {
          editor.commands.setContent(t.description ?? "", { emitUpdate: false });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Falha ao carregar tarefa");
      });
    return () => { cancelled = true; };
    // editor is stable for the lifetime of this modal render; including
    // it would re-seed content on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Seed editor content once the editor becomes ready (mount race with fetch).
  useEffect(() => {
    if (editor && task && editor.getHTML() !== (task.description ?? "")) {
      editor.commands.setContent(task.description ?? "", { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Flush pending changes on close.
  const handleClose = useCallback(() => {
    if (Object.keys(pendingRef.current).length > 0) {
      // Fire-and-forget: close immediately; the save is best-effort.
      void flush();
    }
    onClose();
  }, [flush, onClose]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, []);

  const statusOpt = useMemo(
    () => STATUS_OPTS.find((s) => s.id === task?.status),
    [task?.status],
  );
  const prioOpt = useMemo(
    () => PRIO_OPTS.find((p) => p.id === (task?.priority ?? undefined)),
    [task?.priority],
  );

  // -------- handlers for pickers / inputs -------------------------------
  const onTitleChange = (title: string) => {
    setTask((prev) => (prev ? { ...prev, title } : prev));
    queuePatch({ title });
  };
  const onStatusChange = (status: TaskStatus | null) => {
    if (!status) return;
    setTask((prev) => (prev ? { ...prev, status } : prev));
    queuePatch({ status });
  };
  const onPrioChange = (priority: TaskPriority | null) => {
    setTask((prev) => (prev ? { ...prev, priority } : prev));
    queuePatch({ priority: priority ?? "" });
  };
  const onDateChange = (iso: string) => {
    setTask((prev) => (prev ? { ...prev, due_date: iso || null } : prev));
    queuePatch({ due_date: iso || "" });
  };
  const onTimeChange = (hhmm: string) => {
    setTask((prev) => (prev ? { ...prev, due_time: hhmm || null } : prev));
    queuePatch({ due_time: hhmm || "" });
  };
  const commitTagDraft = () => {
    const raw = tagDraft.trim();
    if (!raw) return;
    const pieces = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (pieces.length === 0) return;
    const existing = task?.tags ?? [];
    const next = Array.from(new Set([...existing, ...pieces]));
    setTask((prev) => (prev ? { ...prev, tags: next } : prev));
    queuePatch({ tags: next });
    setTagDraft("");
  };
  const onTagKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitTagDraft();
    } else if (e.key === "Backspace" && tagDraft === "" && (task?.tags?.length ?? 0) > 0) {
      // Remove last tag.
      const next = (task?.tags ?? []).slice(0, -1);
      setTask((prev) => (prev ? { ...prev, tags: next } : prev));
      queuePatch({ tags: next });
    }
  };
  const removeTag = (idx: number) => {
    const next = (task?.tags ?? []).filter((_, i) => i !== idx);
    setTask((prev) => (prev ? { ...prev, tags: next } : prev));
    queuePatch({ tags: next });
  };

  // -------- delete -------------------------------------------------------
  const doDelete = async () => {
    if (!taskId) return;
    try {
      await tasksApi.deleteTask(taskId);
      onDeleted?.();
      onClose();
    } catch {
      setConfirmDelete(false);
      setSaveState("error");
    }
  };

  if (!taskId) return null;

  // -------- render ------------------------------------------------------
  const cardSize = expanded
    ? "w-[96vw] h-[94vh] max-w-[1200px]"
    : "w-[92vw] max-w-[640px] h-[min(86vh,760px)]";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} aria-hidden="true" />
      <div
        className={[
          "relative flex flex-col rounded-2xl border border-white/10 bg-bg-surface shadow-2xl shadow-black/50",
          cardSize,
        ].join(" ")}
        onClick={() => { setStatusOpen(false); setPrioOpen(false); }}
      >
        {/* Header */}
        <div className="flex items-start gap-2 p-5 pb-3">
          <input
            type="text"
            value={task?.title ?? ""}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Título da tarefa"
            className="flex-1 bg-transparent text-2xl font-bold text-ink-primary placeholder:text-ink-faint focus:outline-none"
          />
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="p-2 rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
              aria-label="Remover tarefa"
              title="Remover"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="p-2 rounded-lg bg-white/5 text-ink-dim hover:bg-white/10 transition-colors"
              aria-label={expanded ? "Contrair" : "Expandir"}
              title={expanded ? "Contrair" : "Expandir"}
            >
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="p-2 rounded-lg bg-white/5 text-ink-dim hover:bg-white/10 transition-colors"
              aria-label="Fechar"
              title="Fechar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loadError ? (
          <div className="px-5 py-3 text-sm text-red-400">{loadError}</div>
        ) : null}

        {/* Metadata rows */}
        <div className="px-5 flex flex-col gap-1">
          {/* Status */}
          <div className="relative flex items-center gap-3 py-2 text-sm">
            <div className="flex items-center gap-2 w-28 text-ink-dim">
              <CircleDashed className="h-4 w-4" />
              <span>Status</span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setStatusOpen((v) => !v);
                setPrioOpen(false);
              }}
              className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md hover:bg-white/5 transition-colors"
            >
              {statusOpt ? (
                <>
                  <span className={`h-2 w-2 rounded-full ${statusOpt.dot}`} />
                  <span className={statusOpt.text}>{statusOpt.label}</span>
                </>
              ) : (
                <span className="text-ink-faint">Selecionar</span>
              )}
            </button>
            <PillPicker
              open={statusOpen}
              onClose={() => setStatusOpen(false)}
              options={STATUS_OPTS}
              value={task?.status ?? null}
              onChange={onStatusChange}
            />
          </div>

          {/* Priority */}
          <div className="relative flex items-center gap-3 py-2 text-sm">
            <div className="flex items-center gap-2 w-28 text-ink-dim">
              <Flag className="h-4 w-4" />
              <span>Prioridade</span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPrioOpen((v) => !v);
                setStatusOpen(false);
              }}
              className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md hover:bg-white/5 transition-colors"
            >
              {prioOpt ? (
                <>
                  <span className={`h-2 w-2 rounded-full ${prioOpt.dot}`} />
                  <span className={prioOpt.text}>{prioOpt.label}</span>
                </>
              ) : (
                <span className="text-ink-faint">Selecionar</span>
              )}
            </button>
            <PillPicker
              open={prioOpen}
              onClose={() => setPrioOpen(false)}
              options={PRIO_OPTS}
              value={(task?.priority as TaskPriority | undefined) ?? null}
              onChange={onPrioChange}
              allowClear
            />
          </div>

          {/* Date + time */}
          <div className="flex items-center gap-3 py-2 text-sm">
            <div className="flex items-center gap-2 w-28 text-ink-dim">
              <Calendar className="h-4 w-4" />
              <span>Data</span>
            </div>
            <label className="relative inline-flex items-center gap-2 px-2.5 py-1 rounded-md hover:bg-white/5 transition-colors cursor-pointer">
              <span className={task?.due_date ? "text-ink-primary" : "text-ink-faint"}>
                {task?.due_date ? fmtDateLabel(task.due_date) : "Sem data"}
              </span>
              <input
                type="date"
                value={task?.due_date ?? ""}
                onChange={(e) => onDateChange(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label="Data"
              />
            </label>
            <label className="relative inline-flex items-center gap-1 px-2.5 py-1 rounded-md hover:bg-white/5 transition-colors cursor-pointer">
              <Clock className="h-3.5 w-3.5 text-ink-dim" />
              <span className={task?.due_time ? "text-ink-primary" : "text-ink-faint"}>
                {task?.due_time ?? "--:--"}
              </span>
              <input
                type="time"
                value={task?.due_time ?? ""}
                onChange={(e) => onTimeChange(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label="Horário"
              />
            </label>
          </div>

          {/* Tags */}
          <div className="flex items-start gap-3 py-2 text-sm">
            <div className="flex items-center gap-2 w-28 text-ink-dim pt-1">
              <TagIcon className="h-4 w-4" />
              <span>Tags</span>
            </div>
            <div className="flex-1 flex flex-wrap items-center gap-1.5">
              {(task?.tags ?? []).map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-purple/15 text-accent-purple text-xs ring-1 ring-accent-purple/30"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => removeTag(i)}
                    className="hover:text-white"
                    aria-label={`Remover ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={onTagKey}
                onBlur={commitTagDraft}
                placeholder={(task?.tags?.length ?? 0) === 0 ? "adicionar tag…" : ""}
                className="flex-1 min-w-[120px] bg-transparent text-ink-primary placeholder:text-ink-faint text-sm focus:outline-none py-1"
              />
            </div>
          </div>
        </div>

        <div className="mx-5 h-px bg-white/5" />

        {/* Editor */}
        <div className="flex-1 overflow-y-auto px-5 py-4 task-editor-body">
          <EditorContent editor={editor} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/5 text-xs text-ink-faint">
          <span>{fmtTodayStamp()}</span>
          <SaveIndicator state={saveState} />
        </div>

        {/* Delete confirm */}
        {confirmDelete ? (
          <div className="absolute inset-0 z-30 grid place-items-center rounded-2xl bg-black/70 backdrop-blur-sm">
            <div className="w-[90%] max-w-sm rounded-xl border border-white/10 bg-bg-elevated p-5 flex flex-col gap-4">
              <div className="text-sm text-ink-primary">
                Remover esta tarefa? Esta ação não pode ser desfeita.
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1.5 rounded-md bg-white/5 text-ink-primary text-sm hover:bg-white/10"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void doDelete()}
                  className="px-3 py-1.5 rounded-md bg-red-500/90 hover:bg-red-500 text-white text-sm"
                >
                  Remover
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        salvando…
      </span>
    );
  }
  if (state === "error") {
    return <span className="text-red-400">erro ao salvar</span>;
  }
  if (state === "dirty") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        alterações pendentes
      </span>
    );
  }
  // idle / saved — both render the green dot (idle means pristine from
  // server fetch, which is as "saved" as anything).
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      salvo
    </span>
  );
}
