import './obsidian.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellIcon, CalendarIcon, ClockIcon, CheckIcon, XIcon } from '../icons/Icons';
import type { FinanceEntry, SeraphineTask, FinanceImportPayload } from '../finance/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../finance/types';
import { TaskEditorModal } from './TaskEditorModal';
import { Skeleton, useDelayedFlag } from '../utils';

import { API_BASE } from '../api';
import { createTask, listTasks, updateTaskStatus } from './api';
import type { TaskCreateInput } from './types';

type ColumnId = 'pending' | 'in_progress' | 'done' | 'discarded';

type CardKind = 'task' | 'entry';

interface BaseCard {
  key: string;
  kind: CardKind;
  column: ColumnId;
  title: string;
  subtitle?: string;
  typeLabel: string; // Email / WhatsApp / Financa / Sistema
  createdAt: string;
}

interface TaskCard extends BaseCard {
  kind: 'task';
  task: SeraphineTask;
}

interface EntryCard extends BaseCard {
  kind: 'entry';
  entry: FinanceEntry;
}

type Card = TaskCard | EntryCard;

interface TasksViewProps {
  onBack: () => void;
  focusId?: string;
}

function parsePayload(payload: SeraphineTask['payload']): FinanceImportPayload {
  if (!payload) return {};
  if (typeof payload === 'object') return payload as FinanceImportPayload;
  try {
    return JSON.parse(payload) as FinanceImportPayload;
  } catch {
    return {};
  }
}

function typeLabelForTask(task: SeraphineTask): string {
  const src = (task.source || '').toLowerCase();
  const t = (task.type || '').toLowerCase();
  if (t.includes('finance') || src.includes('finance') || src === 'pdf') return 'Financa';
  if (src === 'email' || src === 'gmail') return 'Email';
  if (src === 'whatsapp' || src === 'wa') return 'WhatsApp';
  return 'Sistema';
}

/* Normalize a free-text category to a CATEGORY_COLORS key (strip accents). */
function normalizeCategory(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/* CATEGORY_LABELS in finance/types.ts carry an emoji prefix; the project
   forbids emojis in the UI, so strip any leading non-letter glyphs. */
function cleanCategoryLabel(key: string): string {
  const label = CATEGORY_LABELS[key];
  if (!label) return '';
  // Drop leading emoji + whitespace, keep the word(s).
  return label.replace(/^[^\p{L}]+/u, '').trim();
}

/* Convert a #rrggbb hex to an rgba() string at the given alpha. Falls back
   to the raw color (e.g. a CSS var) when it isn't a 6-digit hex. */
function hexToAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface CategoryChip {
  label: string;
  color: string;
}

/* Resolve a per-category colored chip for a card. Entries always carry a
   finance category; tasks now carry a persisted task.category (server-
   derived). Falls back to the tags/type guess for legacy rows that
   predate the column. Returns null when nothing maps so the card omits
   the chip gracefully. */
function categoryChipForCard(card: Card): CategoryChip | null {
  let raw = '';
  if (card.kind === 'entry') {
    raw = card.entry.category;
  } else {
    const task = card.task;
    // Prefer the real persisted category; fall back to the tags/type guess.
    if (task.category && normalizeCategory(task.category) in CATEGORY_COLORS) {
      raw = task.category;
    } else {
      const candidates = [
        ...(Array.isArray(task.tags) ? task.tags : []),
        task.type,
      ];
      raw = candidates.find((c) => normalizeCategory(c) in CATEGORY_COLORS) || '';
    }
  }
  const key = normalizeCategory(raw);
  if (!(key in CATEGORY_COLORS)) return null;
  return { label: cleanCategoryLabel(key) || raw, color: CATEGORY_COLORS[key] };
}

function timeAgo(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `ha ${mins}min`;
  if (hours < 24) return `ha ${hours}h`;
  if (days === 1) return 'ontem';
  if (days < 30) return `ha ${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

function fmtBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function isWithinDays(iso: string, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= days * 86400000;
}

const COLUMNS: { id: ColumnId; title: string }[] = [
  { id: 'pending', title: 'A fazer' },
  { id: 'in_progress', title: 'Fazendo' },
  { id: 'done', title: 'Concluido' },
  { id: 'discarded', title: 'Descartadas' },
];

interface PasswordModalProps {
  filename?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}

function PasswordModal({ filename, busy, onCancel, onConfirm }: PasswordModalProps): JSX.Element {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const submit = (e?: React.FormEvent): void => {
    e?.preventDefault();
    if (!password || busy) return;
    onConfirm(password);
  };

  return (
    <div className="password-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <form
        className="password-modal"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="password-modal__title">Senha do arquivo</h4>
        {filename && <p className="password-modal__file">{filename}</p>}
        <p className="password-modal__hint">Este PDF e protegido. Informe a senha para importar.</p>
        <input
          ref={inputRef}
          type="password"
          className="password-modal__input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          autoComplete="off"
          placeholder="Senha"
        />
        <div className="password-modal__actions">
          <button type="button" className="btn-reject" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn-confirm" disabled={busy || !password}>
            {busy ? 'Importando...' : 'Confirmar'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  New Task modal                                                     */
/* ------------------------------------------------------------------ */

const PRIO_COLORS: Record<string, string> = { low: '#4ade80', med: '#f59e0b', high: '#ef4444' };

interface NewTaskModalProps {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (data: {
    title: string;
    description: string;
    due_date: string | null;
    due_time: string | null;
    priority: string | null;
    remind: string | null;
  }) => void;
}

function NewTaskModal({ busy, onCancel, onConfirm }: NewTaskModalProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [priority, setPriority] = useState('');
  const [remind, setRemind] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const submit = (e?: React.FormEvent): void => {
    e?.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    onConfirm({
      title: t,
      description: description.trim(),
      due_date: dueDate || null,
      due_time: dueTime || null,
      priority: priority || null,
      remind: remind || null,
    });
  };

  const fmtDateLabel = dueDate
    ? (() => {
        const [, m, d] = dueDate.split('-').map(Number);
        const months = ['','janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        return `${d} de ${months[m] || m}`;
      })()
    : '';

  return (
    <div className="password-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <form
        className="task-editor-modal"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="te__header">
          <input
            ref={inputRef}
            type="text"
            className="te__title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            placeholder="O que precisa ser feito?"
            required
          />
          <div className="te__actions">
            <button type="button" className="te__action" onClick={onCancel} disabled={busy}>
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div className="te__fields">
          <div className="te__row">
            <span className="te__label">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>
              Prioridade
            </span>
            {priority && <span className="te__dot" style={{ background: PRIO_COLORS[priority] }} />}
            <select
              className="te__value te__select"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              disabled={busy}
              style={{ color: PRIO_COLORS[priority] || 'var(--text)' }}
            >
              <option value="">Selecionar</option>
              <option value="low" style={{ color: '#4ade80' }}>Baixa</option>
              <option value="med" style={{ color: '#f59e0b' }}>Media</option>
              <option value="high" style={{ color: '#ef4444' }}>Alta</option>
            </select>
          </div>

          <div className="te__row">
            <span className="te__label">
              <CalendarIcon size={14} />
              Data
            </span>
            <span className="te__value te__date-group">
              <input ref={dateInputRef} type="date" className="te__date-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={busy} />
              <span className="te__date-label" onClick={() => dateInputRef.current?.showPicker?.()}>{fmtDateLabel || 'Selecionar'}</span>
              <span className="te__time-group">
                <ClockIcon size={14} />
                <input type="time" className="te__time-input" value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={busy} />
              </span>
            </span>
          </div>

          <div className="te__row">
            <span className="te__label">
              <BellIcon size={14} />
              Lembrete
            </span>
            <select className="te__value te__select" value={remind} onChange={(e) => setRemind(e.target.value)} disabled={busy}>
              <option value="">Nao lembrar</option>
              <option value="at_time">Na hora</option>
              <option value="1h_before">1 hora antes</option>
              <option value="1d_before">1 dia antes</option>
            </select>
          </div>
        </div>

        <textarea
          className="te__description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          placeholder="Escreva os detalhes..."
        />

        <div className="te__footer">
          <span />
          <button type="submit" className="btn-confirm" disabled={busy || !title.trim()} style={{ padding: '6px 20px', borderRadius: '8px' }}>
            {busy ? 'Criando...' : 'Criar tarefa'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* TaskEditorModal is now imported from ./TaskEditorModal */

interface RecurringRule {
  id: string;
  title: string;
  frequency: string;
  weekday: number | null;
  day_of_month: number | null;
  time: string | null;
  active: boolean;
  description: string | null;
}

interface ReminderData {
  id: string;
  message: string;
  fire_at: string | null;
  recurring: string | null;
  next_run: string | null;
}

const RECURRING_LABELS: Record<string, string> = {
  hourly: 'A cada hora',
  daily: 'Diario',
  weekly: 'Semanal',
};

const FREQ_LABELS: Record<string, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

export function TasksView({ onBack, focusId }: TasksViewProps): JSX.Element {
  const [tasks, setTasks] = useState<SeraphineTask[]>([]);
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [confirmedEntries, setConfirmedEntries] = useState<FinanceEntry[]>([]);
  const [recurringRules, setRecurringRules] = useState<RecurringRule[]>([]);
  const [reminders, setReminders] = useState<ReminderData[]>([]);
  const [loading, setLoading] = useState(false);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const delayedFirstLoading = useDelayedFlag(!firstLoaded && loading, 100);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<ColumnId | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [passwordTask, setPasswordTask] = useState<SeraphineTask | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskBusy, setNewTaskBusy] = useState(false);
  const [focusedCardKey, setFocusedCardKey] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  // Optimistic overrides: key -> column (to move cards instantly on drop)
  const [overrides, setOverrides] = useState<Record<string, ColumnId>>({});
  // Per-card in-flight mutation counter. Refresh must NOT clear overrides
  // for cards with pending mutations (> 0), otherwise a rapid second move
  // briefly flips the card back to the backend's stale state.
  const inFlightRef = useRef<Map<string, number>>(new Map());
  const inFlightInc = (key: string): void => {
    inFlightRef.current.set(key, (inFlightRef.current.get(key) ?? 0) + 1);
  };
  const inFlightDec = (key: string): number => {
    const n = (inFlightRef.current.get(key) ?? 0) - 1;
    if (n <= 0) inFlightRef.current.delete(key);
    else inFlightRef.current.set(key, n);
    return Math.max(0, n);
  };
  // Pointer-drag state stored in refs to avoid re-renders mid-drag. The
  // HTML5-DnD path was unreliable on Chromium + touch; pointer events are
  // identical across browsers and drive Playwright's locator.dragTo cleanly.
  // Refs used during a single drag gesture.
  const dragStateRef = useRef<{
    card: Card;
    startX: number;
    startY: number;
    pointerId: number;
    element: HTMLElement;
    dragging: boolean;        // threshold crossed → true drag
    ghost: HTMLElement | null;
    targetColumn: ColumnId | null;
  } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [tasksRes, pendingEntriesRes, confirmedEntriesRes, recurringRes, remindersRes] = await Promise.all([
        // Parity with the previous inline fetch: a failing /tasks yields an
        // empty board instead of blowing up the whole refresh.
        listTasks({ limit: 200 }).catch(() => []),
        fetch(`${API_BASE}/finance/entries?status=pending_review&limit=100`).then((r) =>
          r.ok ? r.json() : { entries: [] },
        ),
        fetch(`${API_BASE}/finance/entries?status=confirmed&limit=100`).then((r) =>
          r.ok ? r.json() : { entries: [] },
        ),
        fetch(`${API_BASE}/recurring`).then((r) =>
          r.ok ? r.json() : { recurring: [] },
        ),
        fetch(`${API_BASE}/reminders`).then((r) =>
          r.ok ? r.json() : { reminders: [] },
        ),
      ]);
      setTasks(tasksRes);
      setEntries(Array.isArray(pendingEntriesRes.entries) ? pendingEntriesRes.entries : []);
      setConfirmedEntries(
        Array.isArray(confirmedEntriesRes.entries) ? confirmedEntriesRes.entries : [],
      );
      setRecurringRules(
        Array.isArray(recurringRes.recurring) ? recurringRes.recurring : [],
      );
      setReminders(
        Array.isArray(remindersRes.reminders) ? remindersRes.reminders : [],
      );
      // Keep overrides for keys with an in-flight mutation — clearing
      // them would flip the card back to the server's stale state while
      // a newer PATCH is still in transit.
      setOverrides((prev) => {
        const next: Record<string, ColumnId> = {};
        for (const key of Object.keys(prev)) {
          if ((inFlightRef.current.get(key) ?? 0) > 0) next[key] = prev[key];
        }
        return next;
      });
      setCardErrors({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setFirstLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The Obsidian header drops the visible "Voltar" button; preserve the
  // back affordance (and the onBack prop) by mapping Escape → onBack when no
  // modal/editor is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (showNewTask || passwordTask || editingTaskId != null) return;
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, showNewTask, passwordTask, editingTaskId]);

  // Build the card list grouped by column (before overrides).
  const allCards: Card[] = useMemo(() => {
    const list: Card[] = [];

    for (const task of tasks) {
      const key = `task-${task.id}`;
      const typeLabel = typeLabelForTask(task);
      let column: ColumnId | null = null;
      if (task.status === 'pending') column = 'pending';
      else if (task.status === 'approved') column = 'in_progress';
      else if (task.status === 'completed') {
        if (isWithinDays(task.updated_at || task.created_at, 7)) column = 'done';
      } else if (task.status === 'rejected' || task.status === 'failed') {
        if (isWithinDays(task.updated_at || task.created_at, 7)) column = 'discarded';
      }
      if (!column) continue;
      // For terminal columns, use completion time (updated_at) so "concluidas
      // hoje" counts completion date, not creation date.
      const createdAt =
        column === 'done' || column === 'discarded'
          ? task.updated_at || task.created_at
          : task.created_at;
      list.push({
        kind: 'task',
        key,
        column,
        title: task.title,
        subtitle: task.description,
        typeLabel,
        createdAt,
        task,
      });
    }

    for (const entry of entries) {
      const key = `entry-${entry.id}`;
      list.push({
        kind: 'entry',
        key,
        column: 'pending',
        title: entry.description,
        subtitle: `${entry.type === 'income' ? '+' : '-'}${fmtBRL(entry.amount)} . ${entry.category}`,
        typeLabel: 'Financa',
        createdAt: entry.date,
        entry,
      });
    }

    for (const entry of confirmedEntries) {
      // Consider date (YYYY-MM-DD) as recency signal; only show last 7 days.
      if (!isWithinDays(entry.date, 7)) continue;
      const key = `entry-${entry.id}`;
      list.push({
        kind: 'entry',
        key,
        column: 'done',
        title: entry.description,
        subtitle: `${entry.type === 'income' ? '+' : '-'}${fmtBRL(entry.amount)} . ${entry.category}`,
        typeLabel: 'Financa',
        createdAt: entry.date,
        entry,
      });
    }

    return list;
  }, [tasks, entries, confirmedEntries]);

  const cardsWithOverrides: Card[] = useMemo(
    () =>
      allCards.map((c) => {
        const override = overrides[c.key];
        return override ? { ...c, column: override } : c;
      }),
    [allCards, overrides],
  );

  const byColumn: Record<ColumnId, Card[]> = useMemo(() => {
    const acc: Record<ColumnId, Card[]> = {
      pending: [],
      in_progress: [],
      done: [],
      discarded: [],
    };
    for (const c of cardsWithOverrides) {
      acc[c.column].push(c);
    }
    // Sort each column by createdAt desc (most recent first).
    for (const col of COLUMNS) {
      acc[col.id].sort((a, b) => {
        const at = new Date(a.createdAt).getTime() || 0;
        const bt = new Date(b.createdAt).getTime() || 0;
        return bt - at;
      });
    }
    return acc;
  }, [cardsWithOverrides]);

  const summary = useMemo(() => {
    const totalTasks = tasks.length;
    const completedToday = cardsWithOverrides.filter(
      (c) => c.column === 'done' && isWithinDays(c.createdAt, 1),
    ).length;
    const pendingCount = byColumn.pending.length;
    // Overdue: tasks with a due_date in the past and not completed/rejected
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const overdueCount = tasks.filter((t) => {
      if (t.status === 'completed' || t.status === 'rejected' || t.status === 'failed') return false;
      if (!t.due_date) return false;
      return t.due_date < todayStr;
    }).length;
    return { totalTasks, completedToday, pendingCount, overdueCount };
  }, [tasks, byColumn, cardsWithOverrides]);

  const setCardError = (key: string, msg: string | null): void => {
    setCardErrors((prev) => {
      const next = { ...prev };
      if (msg) next[key] = msg;
      else delete next[key];
      return next;
    });
  };

  const executeTask = async (taskId: number, params?: Record<string, unknown>): Promise<void> => {
    const body = params ? { params } : {};
    const res = await fetch(`${API_BASE}/tasks/${taskId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = 'Falha ao executar';
      try {
        const data = await res.json();
        if (data?.detail) msg = typeof data.detail === 'string' ? data.detail : msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
  };

  const patchEntryStatus = async (entryId: number, status: 'confirmed'): Promise<void> => {
    const res = await fetch(`${API_BASE}/finance/entries/${entryId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`Falha HTTP ${res.status}`);
  };

  const deleteEntry = async (entryId: number): Promise<void> => {
    const res = await fetch(`${API_BASE}/finance/entries/${entryId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Falha HTTP ${res.status}`);
  };

  const moveCard = async (card: Card, target: ColumnId): Promise<void> => {
    if (card.column === target) return;
    const key = card.key;
    setCardError(key, null);

    // Optimistic override + mark in-flight so refresh won't clobber it.
    setOverrides((prev) => ({ ...prev, [key]: target }));
    inFlightInc(key);
    setBusyKey(key);

    try {
      if (card.kind === 'task') {
        const task = card.task;
        if (target === 'pending') {
          await updateTaskStatus(task.id, 'pending');
        } else if (target === 'in_progress') {
          await updateTaskStatus(task.id, 'approved');
        } else if (target === 'discarded') {
          await updateTaskStatus(task.id, 'rejected');
        } else if (target === 'done') {
          const payload = parsePayload(task.payload);
          if (task.type === 'finance_import') {
            // finance_import requires running the actual import tool.
            if (payload.needs_password) {
              // Needs a password — revert the override, open modal.
              setOverrides((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
              setPasswordTask(task);
              setBusyKey(null);
              return;
            }
            await executeTask(task.id);
          } else {
            // Other task types (generic, calendar_add, etc.) — just mark
            // completed. execute_task for these returns 501.
            await updateTaskStatus(task.id, 'completed');
          }
        }
      } else {
        const entry = card.entry;
        if (target === 'done') {
          await patchEntryStatus(entry.id, 'confirmed');
        } else if (target === 'discarded') {
          // Only pending entries can be rejected (deleted). Confirmed entries
          // already in "Concluidas" must not be destroyed on drag — that would
          // silently delete user financial records.
          if (card.column !== 'pending') {
            throw new Error('Acao nao suportada para este item');
          }
          await deleteEntry(entry.id);
        } else {
          // Entries cannot move to pending/in_progress; revert.
          throw new Error('Acao nao suportada para este item');
        }
      }
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCardError(key, msg);
      // Revert override on error
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } finally {
      const remaining = inFlightDec(key);
      setBusyKey((curr) => (curr === key ? null : curr));
      // If this was the last in-flight mutation for the card, clear its
      // override — the next refresh (already fetched above) reflects the
      // latest backend state.
      if (remaining === 0) {
        setOverrides((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    }
  };

  const handlePasswordConfirm = async (password: string): Promise<void> => {
    if (!passwordTask) return;
    const key = `task-${passwordTask.id}`;
    setBusyKey(key);
    setCardError(key, null);
    try {
      await executeTask(passwordTask.id, { password });
      setPasswordTask(null);
      await refresh();
    } catch (e) {
      setCardError(key, e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateTask = async (data: {
    title: string;
    description: string;
    due_date: string | null;
    due_time: string | null;
    priority: string | null;
    remind: string | null;
  }): Promise<void> => {
    setNewTaskBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      if (data.due_date) payload.due_date = data.due_date;
      const body: TaskCreateInput = {
        type: 'generic',
        title: data.title,
        description: data.description,
        source: 'chat',
        payload,
        due_date: data.due_date,
      };
      if (data.due_time) body.due_time = data.due_time;
      if (data.priority) body.priority = data.priority;
      if (data.remind) body.remind = data.remind;
      await createTask(body);
      setShowNewTask(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewTaskBusy(false);
    }
  };

  const deleteRecurringRule = async (ruleId: string): Promise<void> => {
    try {
      const res = await fetch(`${API_BASE}/recurring/${ruleId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRecurringRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch {
      // silent — will refresh on next load
    }
  };

  const deleteReminder = async (reminderId: string): Promise<void> => {
    try {
      const res = await fetch(`${API_BASE}/reminders/${reminderId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReminders((prev) => prev.filter((r) => r.id !== reminderId));
    } catch {
      // silent — will refresh on next load
    }
  };

  /* ---- pointer-based drag handlers ----------------------------- */
  // HTML5 draggable is flaky in Chromium + React (dragstart aborts when the
  // source gets any transform/layout change mid-start) and useless on touch.
  // We replace it with pointer events: pointerdown records origin, a move
  // beyond THRESHOLD_PX promotes the gesture to a "drag", pointermove
  // hit-tests `.tasks-column` under the cursor to pick a target, pointerup
  // either drops on that column or, if never promoted, fires a click.
  const DRAG_THRESHOLD_PX = 5;

  const clearDragVisuals = (): void => {
    const s = dragStateRef.current;
    if (s?.ghost && s.ghost.parentNode) {
      s.ghost.parentNode.removeChild(s.ghost);
    }
    setDraggingKey(null);
    setDragOver(null);
  };

  const findColumnAt = (x: number, y: number): ColumnId | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const col = el.closest<HTMLElement>('[data-column-id]');
    if (!col) return null;
    const id = col.getAttribute('data-column-id');
    if (!id) return null;
    if (id === 'pending' || id === 'in_progress' || id === 'done' || id === 'discarded') {
      return id;
    }
    return null;
  };

  const buildGhost = (source: HTMLElement, x: number, y: number): HTMLElement => {
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.classList.add('task-card__ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${x - rect.width / 2}px`;
    ghost.style.top = `${y - 16}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    ghost.style.opacity = '0.92';
    // SDD 016-D: stronger drag elevation — slight scale + tilt + layered
    // shadow/glow. Keep small to preserve hit-test accuracy.
    ghost.style.transform = 'scale(1.03) rotate(1deg)';
    // Shadow is also reinforced by the .task-card__ghost CSS rule; this
    // inline value is a fallback that matches var(--shadow-lg) and adds a
    // subtle accent tint.
    ghost.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.6), 0 0 20px rgba(154, 147, 255, 0.18)';
    document.body.appendChild(ghost);
    return ghost;
  };

  const handlePointerDown = (card: Card) => (e: React.PointerEvent<HTMLDivElement>): void => {
    // Only left mouse button / primary pointer.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // Ignore if the pointerdown originated inside an interactive child
    // (button, input, link) — those have their own click semantics.
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, a, select, .password-modal-backdrop')) {
      return;
    }
    // Clean up any leftover drag state from a prior interaction whose
    // pointerup/cancel was lost (e.g., pointer released outside the
    // window). Prevents a ghost from sticking around.
    if (dragStateRef.current) {
      clearDragVisuals();
      dragStateRef.current = null;
    }
    const element = e.currentTarget as HTMLElement;
    // Capture the pointer *immediately* so subsequent move/up events
    // always arrive here even if the pointer leaves the card before the
    // drag threshold is crossed. Without this we can lose pointerup and
    // strand the ghost.
    try {
      element.setPointerCapture(e.pointerId);
    } catch {
      /* some browsers throw if already captured */
    }
    dragStateRef.current = {
      card,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      element,
      dragging: false,
      ghost: null,
      targetColumn: null,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      // Promote to drag. Pointer was already captured on pointerdown.
      s.dragging = true;
      s.ghost = buildGhost(s.element, e.clientX, e.clientY);
      setDraggingKey(s.card.key);
    }
    // Update ghost position.
    if (s.ghost) {
      const rect = s.ghost.getBoundingClientRect();
      s.ghost.style.left = `${e.clientX - rect.width / 2}px`;
      s.ghost.style.top = `${e.clientY - 16}px`;
    }
    // Hide ghost briefly to hit-test the column underneath.
    const prevVis = s.ghost ? s.ghost.style.visibility : '';
    if (s.ghost) s.ghost.style.visibility = 'hidden';
    const col = findColumnAt(e.clientX, e.clientY);
    if (s.ghost) s.ghost.style.visibility = prevVis;
    s.targetColumn = col;
    setDragOver(col);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const wasDragging = s.dragging;
    const card = s.card;
    const target = s.targetColumn;
    try {
      s.element.releasePointerCapture(s.pointerId);
    } catch {
      /* ignore */
    }
    clearDragVisuals();
    dragStateRef.current = null;

    if (wasDragging) {
      if (target && target !== card.column) {
        void moveCard(card, target);
      }
      return;
    }
    // No drag: treat as a click → open editor for tasks, toggle expand for entries.
    if (card.kind === 'task') {
      setEditingTaskId(card.task.id);
    } else {
      toggleExpand(card.key);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    try {
      s.element.releasePointerCapture(s.pointerId);
    } catch {
      /* ignore */
    }
    clearDragVisuals();
    dragStateRef.current = null;
  };

  const toggleExpand = (key: string): void => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /* ---- focus/scroll-into-view on deep-link --------------------- */
  useEffect(() => {
    if (!focusId) return;
    if (loading) return;
    if (tasks.length === 0) return;
    const key = `task-${focusId}`;
    // Wait one frame so the card is in the DOM after re-render.
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-task-id="${CSS.escape(focusId)}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFocusedCardKey(key);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [focusId, tasks, loading]);

  useEffect(() => {
    if (!focusedCardKey) return;
    const t = setTimeout(() => setFocusedCardKey(null), 2000);
    return () => clearTimeout(t);
  }, [focusedCardKey]);

  const renderCardActions = (card: Card): JSX.Element | null => {
    const busy = busyKey === card.key;
    if (card.kind === 'task') {
      const task = card.task;
      if (card.column === 'pending') {
        if (task.type === 'finance_import') {
          const payload = parsePayload(task.payload);
          return (
            <div className="task-card__actions">
              <button
                type="button"
                className="btn-confirm"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (payload.needs_password) setPasswordTask(task);
                  else void moveCard(card, 'done');
                }}
              >
                {busy ? 'Importando...' : (
                  <>
                    <CheckIcon size={14} /> Importar
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn-reject"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void moveCard(card, 'discarded');
                }}
              >
                {busy ? '...' : (
                  <>
                    <XIcon size={14} /> Ignorar
                  </>
                )}
              </button>
            </div>
          );
        }
        return (
          <div className="task-card__actions">
            <button
              type="button"
              className="btn-confirm"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void moveCard(card, 'in_progress');
              }}
            >
              {busy ? '...' : (
                <>
                  <CheckIcon size={14} /> Aprovar
                </>
              )}
            </button>
            <button
              type="button"
              className="btn-reject"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void moveCard(card, 'discarded');
              }}
            >
              {busy ? '...' : (
                <>
                  <XIcon size={14} /> Ignorar
                </>
              )}
            </button>
          </div>
        );
      }
      if (card.column === 'in_progress') {
        return (
          <div className="task-card__actions">
            <button
              type="button"
              className="btn-confirm"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void moveCard(card, 'done');
              }}
            >
              {busy ? '...' : 'Executar'}
            </button>
            <button
              type="button"
              className="btn-reject"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void moveCard(card, 'discarded');
              }}
            >
              Descartar
            </button>
          </div>
        );
      }
      return null;
    }
    // entry
    if (card.column === 'pending') {
      return (
        <div className="task-card__actions">
          <button
            type="button"
            className="btn-confirm"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void moveCard(card, 'done');
            }}
          >
            {busy ? '...' : (
              <>
                <CheckIcon size={14} /> Confirmar
              </>
            )}
          </button>
          <button
            type="button"
            className="btn-reject"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void moveCard(card, 'discarded');
            }}
          >
            {busy ? '...' : (
              <>
                <XIcon size={14} /> Rejeitar
              </>
            )}
          </button>
        </div>
      );
    }
    return null;
  };

  const renderCard = (card: Card): JSX.Element => {
    const isOpen = !!expanded[card.key];
    const isDragging = draggingKey === card.key;
    const isFocused = focusedCardKey === card.key;
    const err = cardErrors[card.key];

    let detail: JSX.Element | null = null;
    if (isOpen) {
      if (card.kind === 'task') {
        const task = card.task;
        const payload = parsePayload(task.payload);
        detail = (
          <div className="task-card__detail">
            {task.description && <p>{task.description}</p>}
            {task.due_date && (
              <p>
                <span className="task-card__detail-label">Entrega:</span> {task.due_date}
              </p>
            )}
            {payload.from && (
              <p>
                <span className="task-card__detail-label">De:</span> {payload.from}
              </p>
            )}
            {payload.subject && (
              <p>
                <span className="task-card__detail-label">Assunto:</span> {payload.subject}
              </p>
            )}
            {payload.filename && (
              <p>
                <span className="task-card__detail-label">Arquivo:</span> {payload.filename}
                {payload.needs_password && <span title="Protegido por senha"> (protegido)</span>}
              </p>
            )}
            <p className="task-card__detail-meta">
              {task.source} . {task.type} . {task.status}
            </p>
          </div>
        );
      } else {
        const e = card.entry;
        detail = (
          <div className="task-card__detail">
            <p>
              <span className="task-card__detail-label">Categoria:</span> {e.category}
            </p>
            <p>
              <span className="task-card__detail-label">Data:</span> {e.date}
            </p>
            <p>
              <span className="task-card__detail-label">Fonte:</span> {e.source}
            </p>
          </div>
        );
      }
    }

    // Confirmed entries in "Concluidas" must not be draggable — there is no
    // valid destination and the previous code permanently deleted them on a
    // drop into "Descartadas".
    const canDrag = !(card.kind === 'entry' && card.column === 'done');

    const dataTaskId =
      card.kind === 'task' && card.task.id != null ? String(card.task.id) : undefined;

    const isDone = card.column === 'done';
    const isActive = card.column === 'in_progress';
    const chip = categoryChipForCard(card);

    const classes = ['task-card'];
    if (isDragging) classes.push('dragging');
    if (!canDrag) classes.push('task-card--locked');
    if (isFocused) classes.push('task-card--focused');
    if (isDone) classes.push('task-card--done');
    if (isActive) classes.push('task-card--active');

    return (
      <div
        key={card.key}
        className={classes.join(' ')}
        data-task-id={dataTaskId}
        data-card-key={card.key}
        onPointerDown={canDrag ? handlePointerDown(card) : undefined}
        onPointerMove={canDrag ? handlePointerMove : undefined}
        onPointerUp={canDrag ? handlePointerUp : undefined}
        onPointerCancel={canDrag ? handlePointerCancel : undefined}
        onClick={canDrag ? undefined : () => toggleExpand(card.key)}
      >
        {isDone ? (
          <div className="task-card__head">
            <span className="task-card__check" aria-hidden>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0d0d11" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l4 4 10-10" /></svg>
            </span>
            <span className="task-card__done-cat">{chip ? chip.label : card.typeLabel}</span>
          </div>
        ) : (
          <div className="task-card__head">
            {chip ? (
              <span
                className="task-card__badge"
                style={{ color: chip.color, background: hexToAlpha(chip.color, 0.16) }}
              >
                {chip.label}
              </span>
            ) : (
              <span className="task-card__badge">{card.typeLabel}</span>
            )}
            <span className={`task-card__time${isActive ? ' task-card__time--due' : ''}`}>
              {timeAgo(card.createdAt)}
            </span>
          </div>
        )}
        <div className="task-card__title">
          {!isDone && card.kind === 'task' && card.task.priority && (
            <span className={`task-card__priority-dot task-card__priority-dot--${card.task.priority}`} />
          )}
          {card.title}
        </div>
        {!isDone && card.subtitle && <div className="task-card__subtitle">{card.subtitle}</div>}
        {!isDone && card.kind === 'task' && (card.task.due_date || card.task.due_time) && (
          <div className={`task-card__due${card.task.due_date && card.task.due_date < new Date().toISOString().slice(0, 10) && card.task.status !== 'completed' && card.task.status !== 'rejected' ? ' task-card__due--overdue' : ''}`}>
            {card.task.due_date && card.task.due_date.length >= 10
              ? `${card.task.due_date.slice(8, 10)}/${card.task.due_date.slice(5, 7)}`
              : ''}
            {card.task.due_time ? ` ${card.task.due_time}` : ''}
            {card.task.remind && (
              <span className="task-card__remind" title="Lembrete ativo">
                <BellIcon size={12} />
              </span>
            )}
          </div>
        )}
        {err && <div className="task-card__error" role="alert">{err}</div>}
        {detail}
        {renderCardActions(card)}
      </div>
    );
  };

  const activeCount = byColumn.pending.length + byColumn.in_progress.length;

  return (
    <div className="tasks-view">
      <header className="tasks-view__topbar">
        <div>
          <h2 className="tasks-view__title">Tarefas</h2>
          <p className="tasks-view__subtitle">
            {activeCount} {activeCount === 1 ? 'ativa' : 'ativas'} · {summary.completedToday}{' '}
            {summary.completedToday === 1 ? 'concluida hoje' : 'concluidas hoje'}
          </p>
        </div>
        <div className="tasks-view__controls">
          <div className="obs-seg" role="tablist" aria-label="Modo de visualizacao">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'kanban'}
              className={`obs-seg__opt${viewMode === 'kanban' ? ' obs-seg__opt--active' : ''}`}
              onClick={() => setViewMode('kanban')}
            >
              Kanban
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'list'}
              className={`obs-seg__opt${viewMode === 'list' ? ' obs-seg__opt--active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              Lista
            </button>
          </div>
          <button
            type="button"
            className="tasks-view__new-btn"
            onClick={() => setShowNewTask(true)}
          >
            <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
            <span>Nova tarefa</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="tasks-view__error" role="alert">
          {error}
        </div>
      )}

      {delayedFirstLoading ? (
        <div className="tasks-skeleton" aria-hidden="true">
          {COLUMNS.map((col) => (
            <div key={col.id} className="tasks-skeleton__column">
              <Skeleton variant="card" height={60} count={3} />
            </div>
          ))}
        </div>
      ) : viewMode === 'kanban' ? (
        <div className="tasks-kanban">
          {COLUMNS.map((col) => {
            const cards = byColumn[col.id];
            const isOver = dragOver === col.id;
            return (
              <div
                key={col.id}
                className={`tasks-column${isOver ? ' drag-over' : ''}`}
                data-column-id={col.id}
              >
                <div className="tasks-column__header">
                  <span className={`tasks-column__dot tasks-column__dot--${col.id}`} />
                  <span className="tasks-column__title">{col.title}</span>
                  <span className="tasks-column__count">{cards.length}</span>
                </div>
                <div className="tasks-column__body">
                  {cards.length === 0 && !loading && (
                    <div className="tasks-column__empty">Sem itens</div>
                  )}
                  {cards.map((c) => renderCard(c))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="tasks-list">
          {COLUMNS.map((col) => {
            const cards = byColumn[col.id];
            if (cards.length === 0) return null;
            const isOver = dragOver === col.id;
            return (
              <section
                key={col.id}
                className={`tasks-list__group${isOver ? ' drag-over' : ''}`}
                data-column-id={col.id}
              >
                <div className="tasks-column__header">
                  <span className={`tasks-column__dot tasks-column__dot--${col.id}`} />
                  <span className="tasks-column__title">{col.title}</span>
                  <span className="tasks-column__count">{cards.length}</span>
                </div>
                <div className="tasks-list__rows">
                  {cards.map((c) => renderCard(c))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {recurringRules.length > 0 && (
        <div className="recurring-section">
          <div className="recurring-section__header">
            <span className="recurring-section__title">Tarefas Recorrentes</span>
          </div>
          <div className="recurring-section__list">
            {recurringRules.filter((r) => r.active).map((rule) => (
              <div key={rule.id} className="recurring-card">
                <div className="recurring-card__title">{rule.title}</div>
                <div className="recurring-card__meta">
                  <span className="recurring-card__freq">
                    {FREQ_LABELS[rule.frequency] || rule.frequency}
                  </span>
                  {rule.time && <span>{rule.time}</span>}
                  {rule.frequency === 'weekly' && rule.weekday != null && (
                    <span>{WEEKDAY_LABELS[rule.weekday] || ''}</span>
                  )}
                  {rule.frequency === 'monthly' && rule.day_of_month != null && (
                    <span>dia {rule.day_of_month}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="recurring-card__delete"
                  onClick={() => void deleteRecurringRule(rule.id)}
                >
                  <XIcon size={12} /> Excluir
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {reminders.length > 0 && (
        <div className="recurring-section reminders-section">
          <div className="recurring-section__header">
            <span className="recurring-section__title">Lembretes Agendados</span>
          </div>
          <div className="recurring-section__list">
            {reminders.map((rem) => (
              <div key={rem.id} className="recurring-card reminder-card">
                <div className="reminder-card__header">
                  <BellIcon size={14} className="reminder-card__icon" />
                  <div className="recurring-card__title">{rem.message}</div>
                </div>
                <div className="recurring-card__meta">
                  {rem.next_run && (
                    <span>
                      {new Date(rem.next_run).toLocaleString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                  {rem.recurring && (
                    <span className="reminder-card__freq">
                      {RECURRING_LABELS[rem.recurring] || rem.recurring}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="recurring-card__delete"
                  onClick={() => void deleteReminder(rem.id)}
                >
                  <XIcon size={12} /> Cancelar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {passwordTask && (
        <PasswordModal
          filename={parsePayload(passwordTask.payload).filename}
          busy={busyKey === `task-${passwordTask.id}`}
          onCancel={() => {
            if (busyKey === `task-${passwordTask.id}`) return;
            setPasswordTask(null);
          }}
          onConfirm={handlePasswordConfirm}
        />
      )}

      {showNewTask && (
        <NewTaskModal
          busy={newTaskBusy}
          onCancel={() => {
            if (newTaskBusy) return;
            setShowNewTask(false);
          }}
          onConfirm={handleCreateTask}
        />
      )}

      {editingTaskId != null && (
        <TaskEditorModal
          taskId={editingTaskId}
          onClose={() => setEditingTaskId(null)}
          onDeleted={() => {
            setEditingTaskId(null);
            void refresh();
          }}
          onUpdated={() => void refresh()}
        />
      )}
    </div>
  );
}
