import { useEffect, useRef, useState } from 'react';
import type { FinanceEntry, SeraphineTask, FinanceImportPayload } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from './types';
import { CheckIcon, XIcon } from '../icons/Icons';

function fmtBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

const SOURCE_LABELS: Record<string, string> = {
  pdf: 'PDF',
  email: 'Email',
  chat: 'Chat',
  manual: 'Manual',
};

function parsePayload(payload: SeraphineTask['payload']): FinanceImportPayload {
  if (!payload) return {};
  if (typeof payload === 'object') return payload as FinanceImportPayload;
  try {
    return JSON.parse(payload) as FinanceImportPayload;
  } catch {
    return {};
  }
}

interface PendingReviewProps {
  entries: FinanceEntry[];
  tasks?: SeraphineTask[];
  onRefresh: () => void;
}

interface PasswordModalProps {
  filename?: string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
  busy: boolean;
}

function PasswordModal({ filename, onCancel, onConfirm, busy }: PasswordModalProps): JSX.Element {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const submit = (e?: React.FormEvent) => {
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
        {filename && (
          <p className="password-modal__file">{filename}</p>
        )}
        <p className="password-modal__hint">
          Este PDF e protegido. Informe a senha para importar.
        </p>
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
          <button
            type="button"
            className="btn-reject"
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="btn-confirm"
            disabled={busy || !password}
          >
            {busy ? 'Importando...' : 'Confirmar'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function PendingReview({ entries, tasks, onRefresh }: PendingReviewProps): JSX.Element {
  const [actioningId, setActioningId] = useState<number | null>(null);
  // Track dismissed items locally for instant removal animation
  const [dismissedEntries, setDismissedEntries] = useState<Set<number>>(new Set());
  const [dismissedTasks, setDismissedTasks] = useState<Set<number>>(new Set());
  const [taskErrors, setTaskErrors] = useState<Record<number, string>>({});
  const [passwordTask, setPasswordTask] = useState<SeraphineTask | null>(null);

  const visibleEntries = entries.filter(e => !dismissedEntries.has(e.id));
  const visibleTasks = (tasks || []).filter(t => !dismissedTasks.has(t.id));
  const hasTasks = visibleTasks.length > 0;
  const hasEntries = visibleEntries.length > 0;

  if (!hasTasks && !hasEntries) {
    return (
      <div className="finance-pending-empty">
        Nenhum item pendente de revisao
      </div>
    );
  }

  const dismissEntry = (id: number) => {
    setDismissedEntries(prev => new Set(prev).add(id));
    setTimeout(() => onRefresh(), 500);
  };

  const dismissTask = (id: number) => {
    setDismissedTasks(prev => new Set(prev).add(id));
    setTimeout(() => onRefresh(), 500);
  };

  const setTaskError = (id: number, msg: string | null) => {
    setTaskErrors(prev => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  };

  const handleConfirm = async (id: number): Promise<void> => {
    setActioningId(id);
    try {
      const res = await fetch(`/finance/entries/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      if (!res.ok) throw new Error('Falha ao confirmar');
      dismissEntry(id);
    } catch (err) {
      console.error('Erro ao confirmar entrada:', err);
    } finally {
      setActioningId(null);
    }
  };

  const handleReject = async (id: number): Promise<void> => {
    setActioningId(id);
    try {
      const res = await fetch(`/finance/entries/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Falha ao rejeitar');
      dismissEntry(id);
    } catch (err) {
      console.error('Erro ao rejeitar entrada:', err);
    } finally {
      setActioningId(null);
    }
  };

  const executeTask = async (
    taskId: number,
    params?: Record<string, unknown>,
  ): Promise<boolean> => {
    setActioningId(taskId);
    setTaskError(taskId, null);
    try {
      const body = params ? { params } : {};
      const res = await fetch(`/tasks/${taskId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = 'Falha ao importar';
        try {
          const data = await res.json();
          if (data?.detail) msg = typeof data.detail === 'string' ? data.detail : msg;
          else if (data?.error) msg = String(data.error);
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      dismissTask(taskId);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao importar';
      console.error('Task execute error:', err);
      setTaskError(taskId, msg);
      return false;
    } finally {
      setActioningId(null);
    }
  };

  const handleImportTask = async (task: SeraphineTask): Promise<void> => {
    const payload = parsePayload(task.payload);
    if (payload.needs_password) {
      setPasswordTask(task);
      return;
    }
    await executeTask(task.id);
  };

  const handlePasswordConfirm = async (password: string): Promise<void> => {
    if (!passwordTask) return;
    const ok = await executeTask(passwordTask.id, { password });
    if (ok) setPasswordTask(null);
  };

  const handleRejectTask = async (taskId: number): Promise<void> => {
    setActioningId(taskId);
    setTaskError(taskId, null);
    try {
      const res = await fetch(`/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      });
      if (!res.ok) throw new Error('Falha ao ignorar');
      dismissTask(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao ignorar';
      console.error('Task reject error:', err);
      setTaskError(taskId, msg);
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="finance-pending-list">
      {/* Seraphine Tasks / Suggestions */}
      {hasTasks && (
        <div className="finance-pending-section finance-suggestions">
          <h3 className="finance-pending-section__title">Sugestoes da Seraphine</h3>
          {visibleTasks.map((task) => {
            const payload = parsePayload(task.payload);
            const busy = actioningId === task.id;
            const err = taskErrors[task.id];

            return (
              <div
                key={`task-${task.id}`}
                className="finance-pending-card finance-pending-card--task suggestion-card"
              >
                <div className="finance-pending-card__header">
                  <span className="finance-pending-card__desc">
                    <span className="suggestion-card__icon" aria-hidden="true">📧</span>
                    {task.title}
                  </span>
                  <span className="finance-pending-card__source-badge">{task.source}</span>
                </div>
                {task.description && (
                  <p className="finance-pending-card__detail">{task.description}</p>
                )}
                {task.type === 'finance_import' && payload.from && (
                  <p className="suggestion-card__from">De: {payload.from}</p>
                )}
                {task.type === 'finance_import' && payload.filename && (
                  <p className="finance-pending-card__file">
                    Arquivo: {payload.filename}
                    {payload.needs_password && (
                      <span className="suggestion-card__lock" title="Arquivo protegido por senha">
                        {' '}🔒
                      </span>
                    )}
                  </p>
                )}
                {err && (
                  <p className="suggestion-card__error" role="alert">{err}</p>
                )}
                <div className="finance-pending-card__actions suggestion-actions">
                  <button
                    type="button"
                    className="btn-confirm"
                    disabled={busy}
                    onClick={() => handleImportTask(task)}
                  >
                    {busy ? 'Importando...' : <><CheckIcon size={14} /> Importar</>}
                  </button>
                  <button
                    type="button"
                    className="btn-reject"
                    disabled={busy}
                    onClick={() => handleRejectTask(task.id)}
                  >
                    {busy ? '...' : <><XIcon size={14} /> Ignorar</>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Divider if both tasks and entries exist */}
      {hasTasks && hasEntries && (
        <div className="finance-pending-divider" />
      )}

      {/* Existing entry cards */}
      {visibleEntries.map((entry) => {
        const isIncome = entry.type === 'income';
        const color = CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.outros;
        const catLabel = CATEGORY_LABELS[entry.category] ?? entry.category;
        const sourceLabel = SOURCE_LABELS[entry.source] ?? entry.source;
        const busy = actioningId === entry.id;

        return (
          <div key={entry.id} className="finance-pending-card">
            <div className="finance-pending-card__header">
              <span className="finance-pending-card__desc">
                {entry.description}
              </span>
              <span
                className={`finance-pending-card__amount ${
                  isIncome
                    ? 'finance-pending-card__amount--income'
                    : 'finance-pending-card__amount--expense'
                }`}
              >
                {isIncome ? '+' : '-'}{fmtBRL(entry.amount)}
              </span>
            </div>
            <div className="finance-pending-card__meta">
              <span
                className="finance-badge"
                style={{
                  background: color + '22',
                  color,
                  borderColor: color + '44',
                }}
              >
                {catLabel}
              </span>
              <span>{fmtDate(entry.date)}</span>
              <span>{sourceLabel}</span>
            </div>
            <div className="finance-pending-card__actions">
              <button
                type="button"
                className="btn-confirm"
                disabled={busy}
                onClick={() => handleConfirm(entry.id)}
              >
                {busy ? '...' : <><CheckIcon size={14} /> Confirmar</>}
              </button>
              <button
                type="button"
                className="btn-reject"
                disabled={busy}
                onClick={() => handleReject(entry.id)}
              >
                {busy ? '...' : <><XIcon size={14} /> Rejeitar</>}
              </button>
            </div>
          </div>
        );
      })}

      {passwordTask && (
        <PasswordModal
          filename={parsePayload(passwordTask.payload).filename}
          busy={actioningId === passwordTask.id}
          onCancel={() => {
            if (actioningId === passwordTask.id) return;
            setPasswordTask(null);
          }}
          onConfirm={handlePasswordConfirm}
        />
      )}
    </div>
  );
}
