import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, TasksIcon, CheckIcon, XIcon } from '../icons/Icons';
import type { FinanceEntry, SeraphineTask, FinanceImportPayload } from '../finance/types';

// Same origin — Vite proxies backend routes.
const API_BASE = '';

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
  { id: 'pending', title: 'Pendentes' },
  { id: 'in_progress', title: 'Em andamento' },
  { id: 'done', title: 'Concluidas' },
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

export function TasksView({ onBack }: TasksViewProps): JSX.Element {
  const [tasks, setTasks] = useState<SeraphineTask[]>([]);
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [confirmedEntries, setConfirmedEntries] = useState<FinanceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<ColumnId | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [passwordTask, setPasswordTask] = useState<SeraphineTask | null>(null);
  // Optimistic overrides: key -> column (to move cards instantly on drop)
  const [overrides, setOverrides] = useState<Record<string, ColumnId>>({});
  // Guards click-after-drag: dragStart sets it; onClick checks/resets so an
  // accidental toggleExpand doesn't fire after a cancelled/completed drag.
  const dragOccurredRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [tasksRes, pendingEntriesRes, confirmedEntriesRes] = await Promise.all([
        fetch(`${API_BASE}/tasks?limit=200`).then((r) => (r.ok ? r.json() : { tasks: [] })),
        fetch(`${API_BASE}/finance/entries?status=pending_review&limit=100`).then((r) =>
          r.ok ? r.json() : { entries: [] },
        ),
        fetch(`${API_BASE}/finance/entries?status=confirmed&limit=100`).then((r) =>
          r.ok ? r.json() : { entries: [] },
        ),
      ]);
      setTasks(Array.isArray(tasksRes.tasks) ? tasksRes.tasks : []);
      setEntries(Array.isArray(pendingEntriesRes.entries) ? pendingEntriesRes.entries : []);
      setConfirmedEntries(
        Array.isArray(confirmedEntriesRes.entries) ? confirmedEntriesRes.entries : [],
      );
      setOverrides({});
      setCardErrors({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    const pendingCount = byColumn.pending.length;
    const approvedCount = byColumn.in_progress.length;
    const completedToday = cardsWithOverrides.filter(
      (c) => c.column === 'done' && isWithinDays(c.createdAt, 1),
    ).length;
    const failedCount = cardsWithOverrides.filter(
      (c) => c.kind === 'task' && c.task.status === 'failed' && isWithinDays(c.createdAt, 7),
    ).length;
    return { pendingCount, approvedCount, completedToday, failedCount };
  }, [byColumn, cardsWithOverrides]);

  const setCardError = (key: string, msg: string | null): void => {
    setCardErrors((prev) => {
      const next = { ...prev };
      if (msg) next[key] = msg;
      else delete next[key];
      return next;
    });
  };

  const patchTaskStatus = async (taskId: number, status: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      let msg = `Falha HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data?.detail) msg = typeof data.detail === 'string' ? data.detail : msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
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

    // Optimistic override
    setOverrides((prev) => ({ ...prev, [key]: target }));
    setBusyKey(key);

    try {
      if (card.kind === 'task') {
        const task = card.task;
        if (target === 'pending') {
          await patchTaskStatus(task.id, 'pending');
        } else if (target === 'in_progress') {
          await patchTaskStatus(task.id, 'approved');
        } else if (target === 'discarded') {
          await patchTaskStatus(task.id, 'rejected');
        } else if (target === 'done') {
          const payload = parsePayload(task.payload);
          if (task.type === 'finance_import' && payload.needs_password) {
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
      setBusyKey((curr) => (curr === key ? null : curr));
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

  const handleDragStart = (card: Card) => (e: React.DragEvent): void => {
    dragOccurredRef.current = true;
    setDraggingKey(card.key);
    try {
      e.dataTransfer.setData('text/plain', card.key);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* ignore */
    }
  };

  const handleDragEnd = (): void => {
    setDraggingKey(null);
    setDragOver(null);
  };

  const handleDragOver = (col: ColumnId) => (e: React.DragEvent): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== col) setDragOver(col);
  };

  const handleDragLeave = (col: ColumnId) => (): void => {
    if (dragOver === col) setDragOver(null);
  };

  const handleDrop = (col: ColumnId) => (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(null);
    const key = draggingKey || e.dataTransfer.getData('text/plain');
    if (!key) return;
    const card = cardsWithOverrides.find((c) => c.key === key);
    if (!card) return;
    setDraggingKey(null);
    void moveCard(card, col);
  };

  const toggleExpand = (key: string): void => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
    const err = cardErrors[card.key];

    let detail: JSX.Element | null = null;
    if (isOpen) {
      if (card.kind === 'task') {
        const task = card.task;
        const payload = parsePayload(task.payload);
        detail = (
          <div className="task-card__detail">
            {task.description && <p>{task.description}</p>}
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

    return (
      <div
        key={card.key}
        className={`task-card${isDragging ? ' dragging' : ''}${canDrag ? '' : ' task-card--locked'}`}
        draggable={canDrag}
        onDragStart={canDrag ? handleDragStart(card) : undefined}
        onDragEnd={canDrag ? handleDragEnd : undefined}
        onClick={() => {
          if (dragOccurredRef.current) {
            dragOccurredRef.current = false;
            return;
          }
          toggleExpand(card.key);
        }}
      >
        <div className="task-card__head">
          <span className="task-card__badge">{card.typeLabel}</span>
          <span className="task-card__time">{timeAgo(card.createdAt)}</span>
        </div>
        <div className="task-card__title">{card.title}</div>
        {card.subtitle && <div className="task-card__subtitle">{card.subtitle}</div>}
        {err && <div className="task-card__error" role="alert">{err}</div>}
        {detail}
        {renderCardActions(card)}
      </div>
    );
  };

  return (
    <div className="tasks-view">
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
            <TasksIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Tarefas</h2>
            <p className="memory-view__subtitle">Kanban de tarefas e itens pendentes</p>
          </div>
        </div>
      </div>

      <div className="tasks-view__summary">
        <div className="tasks-summary-pill">
          <span className="tasks-summary-pill__value">{summary.pendingCount}</span>
          <span className="tasks-summary-pill__label">pendentes</span>
        </div>
        <div className="tasks-summary-pill">
          <span className="tasks-summary-pill__value">{summary.approvedCount}</span>
          <span className="tasks-summary-pill__label">em andamento</span>
        </div>
        <div className="tasks-summary-pill">
          <span className="tasks-summary-pill__value">{summary.completedToday}</span>
          <span className="tasks-summary-pill__label">concluidas hoje</span>
        </div>
        <div className="tasks-summary-pill">
          <span className="tasks-summary-pill__value">{summary.failedCount}</span>
          <span className="tasks-summary-pill__label">falharam</span>
        </div>
      </div>

      {error && (
        <div className="tasks-view__error" role="alert">
          {error}
        </div>
      )}

      <div className="tasks-kanban">
        {COLUMNS.map((col) => {
          const cards = byColumn[col.id];
          const isOver = dragOver === col.id;
          return (
            <div
              key={col.id}
              className={`tasks-column${isOver ? ' drag-over' : ''}`}
              onDragOver={handleDragOver(col.id)}
              onDragLeave={handleDragLeave(col.id)}
              onDrop={handleDrop(col.id)}
            >
              <div className="tasks-column__header">
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
    </div>
  );
}
