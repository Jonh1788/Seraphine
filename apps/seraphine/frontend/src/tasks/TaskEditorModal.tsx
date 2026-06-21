import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon, BellIcon, CalendarIcon, ClockIcon } from '../icons/Icons';
import type { SeraphineTask } from '../finance/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../finance/types';
import { API_BASE } from '../api';

// Category options reuse the finance taxonomy (same keys the card chip
// maps against). Labels carry an emoji prefix in finance/types — strip
// leading non-letter glyphs since the design system forbids emojis.
const CATEGORY_OPTIONS: { value: string; label: string; color?: string }[] = [
  { value: '', label: 'Selecionar' },
  ...Object.keys(CATEGORY_COLORS).map((key) => ({
    value: key,
    label: (CATEGORY_LABELS[key] || key).replace(/^[^\p{L}]+/u, '').trim(),
    color: CATEGORY_COLORS[key],
  })),
];

const STATUS_COLORS: Record<string, string> = {
  pending: '#9a93ff',
  approved: '#22d3ee',
  completed: '#4ade80',
  rejected: '#64748b',
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending', label: 'Pendente' },
  { value: 'approved', label: 'Em andamento' },
  { value: 'completed', label: 'Concluido' },
  { value: 'rejected', label: 'Descartado' },
];

const PRIORITY_OPTIONS: { value: string; label: string; color?: string }[] = [
  { value: '', label: 'Selecionar' },
  { value: 'low', label: 'Baixa', color: '#4ade80' },
  { value: 'med', label: 'Media', color: '#f59e0b' },
  { value: 'high', label: 'Alta', color: '#ef4444' },
];

const PRIORITY_COLORS: Record<string, string> = {
  low: '#4ade80',
  med: '#f59e0b',
  high: '#ef4444',
};

const REMIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Nao lembrar' },
  { value: 'at_time', label: 'Na hora' },
  { value: '1h_before', label: '1 hora antes' },
  { value: '1d_before', label: '1 dia antes' },
];

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface TaskEditorModalProps {
  taskId: number | string;
  onClose: () => void;
  onDeleted?: () => void;
  onUpdated?: () => void;
}

export function TaskEditorModal({ taskId, onClose, onDeleted, onUpdated }: TaskEditorModalProps): JSX.Element {
  const [task, setTask] = useState<SeraphineTask | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('pending');
  const [priority, setPriority] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [remind, setRemind] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch task on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/tasks/${taskId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: SeraphineTask = await res.json();
        if (cancelled) return;
        setTask(data);
        setTitle(data.title || '');
        setDescription(data.description || '');
        setStatus(data.status || 'pending');
        setPriority(data.priority || '');
        setDueDate(data.due_date || '');
        setDueTime(data.due_time || '');
        setRemind(data.remind || '');
        setCategory((data.category || '').toLowerCase());
        setTags(Array.isArray(data.tags) ? data.tags : []);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  // Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clear debounce timer on unmount so a closed modal doesn't fire a stale PATCH.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const patchField = useCallback(
    (body: Record<string, unknown>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setSaveStatus('saving');
        try {
          const res = await fetch(`${API_BASE}/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!mountedRef.current) return;
          if (!res.ok) {
            setSaveStatus('error');
            return;
          }
          setSaveStatus('saved');
          onUpdated?.();
          setTimeout(() => {
            if (mountedRef.current) setSaveStatus('idle');
          }, 2000);
        } catch {
          if (mountedRef.current) setSaveStatus('error');
        }
      }, 800);
    },
    [taskId, onUpdated],
  );

  const handleTitleChange = (v: string): void => {
    setTitle(v);
    if (v.trim()) patchField({ title: v.trim() });
  };

  const handleDescriptionChange = (v: string): void => {
    setDescription(v);
    patchField({ description: v });
  };

  const handleStatusChange = (v: string): void => {
    setStatus(v);
    patchField({ status: v });
  };

  const handlePriorityChange = (v: string): void => {
    setPriority(v);
    patchField({ priority: v || '' });
  };

  const handleDueDateChange = (v: string): void => {
    setDueDate(v);
    patchField({ due_date: v || '' });
  };

  const handleDueTimeChange = (v: string): void => {
    setDueTime(v);
    patchField({ due_time: v || '' });
  };

  const handleRemindChange = (v: string): void => {
    setRemind(v);
    patchField({ remind: v || '' });
  };

  const handleCategoryChange = (v: string): void => {
    setCategory(v);
    // PATCH /tasks/{id} accepts category; "" clears it end-to-end.
    patchField({ category: v || '' });
  };

  const commitTags = (next: string[]): void => {
    setTags(next);
    // PATCH /tasks/{id} accepts a tags list; [] clears it end-to-end.
    patchField({ tags: next });
  };

  const addTag = (raw: string): void => {
    const clean = raw.trim().replace(/^#+/, '').trim();
    if (!clean) return;
    const exists = tags.some((t) => t.toLowerCase() === clean.toLowerCase());
    if (exists) {
      setTagDraft('');
      return;
    }
    commitTags([...tags, clean]);
    setTagDraft('');
  };

  const removeTag = (tag: string): void => {
    commitTags(tags.filter((t) => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && tags.length > 0) {
      e.preventDefault();
      removeTag(tags[tags.length - 1]);
    }
  };

  const handleDelete = async (): Promise<void> => {
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/tasks/${taskId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleted?.();
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loadError) {
    return (
      <div className="password-modal-backdrop" onClick={onClose}>
        <div className="task-editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="te__header">
            <span className="te__title" style={{ cursor: 'default' }}>Erro</span>
            <div className="te__actions">
              <button type="button" className="te__action" onClick={onClose}><XIcon size={16} /></button>
            </div>
          </div>
          <p className="task-editor-modal__error">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="password-modal-backdrop">
        <div className="password-modal task-editor-modal">
          <p className="task-editor-modal__loading">Carregando...</p>
        </div>
      </div>
    );
  }

  const fmtDateLabel = dueDate
    ? (() => {
        const [, m, d] = dueDate.split('-').map(Number);
        const months = ['', 'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
        return `${d} de ${months[m] || m}`;
      })()
    : '';

  const createdLabel = task?.created_at
    ? (() => {
        const dt = new Date(task.created_at);
        return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
      })()
    : '';

  return (
    <div className="password-modal-backdrop" onClick={onClose}>
      <div
        className="task-editor-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: title + action buttons */}
        <div className="te__header">
          <input
            type="text"
            className="te__title"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Titulo da tarefa..."
          />
          <div className="te__actions">
            {confirmDelete ? (
              <>
                <button type="button" className="te__action te__action--danger" disabled={deleting} onClick={handleDelete}>
                  {deleting ? '...' : 'Sim'}
                </button>
                <button type="button" className="te__action" onClick={() => setConfirmDelete(false)}>
                  Nao
                </button>
              </>
            ) : (
              <button type="button" className="te__action te__action--danger" onClick={() => setConfirmDelete(true)} title="Excluir">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            )}
            <button type="button" className="te__action" onClick={onClose} title="Fechar">
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {/* Metadata rows */}
        <div className="te__fields">
          <div className="te__row">
            <span className="te__label">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              Status
            </span>
            <span className="te__dot" style={{ background: STATUS_COLORS[status] || '#888' }} />
            <select
              className="te__value te__select"
              value={status}
              onChange={(e) => handleStatusChange(e.target.value)}
              style={{ color: STATUS_COLORS[status] || 'var(--text)' }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="te__row">
            <span className="te__label">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>
              Prioridade
            </span>
            <select
              className="te__value te__select"
              value={priority}
              onChange={(e) => handlePriorityChange(e.target.value)}
              style={{ color: PRIORITY_COLORS[priority] || 'var(--text)' }}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={{ color: o.color || 'var(--text)' }}>{o.label}</option>
              ))}
            </select>
            {priority && <span className="te__dot" style={{ background: PRIORITY_COLORS[priority] }} />}
          </div>

          <div className="te__row">
            <span className="te__label">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
              Categoria
            </span>
            <select
              className="te__value te__select"
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value)}
              style={{ color: CATEGORY_COLORS[category] || 'var(--text)' }}
            >
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={{ color: o.color || 'var(--text)' }}>{o.label}</option>
              ))}
            </select>
            {category && CATEGORY_COLORS[category] && (
              <span className="te__dot" style={{ background: CATEGORY_COLORS[category] }} />
            )}
          </div>

          <div className="te__row">
            <span className="te__label">
              <CalendarIcon size={14} />
              Data
            </span>
            <span className="te__value te__date-group">
              <input ref={dateInputRef} type="date" className="te__date-input" value={dueDate} onChange={(e) => handleDueDateChange(e.target.value)} />
              <span className="te__date-label" onClick={() => dateInputRef.current?.showPicker?.()}>{fmtDateLabel || 'Selecionar'}</span>
              <span className="te__time-group">
                <ClockIcon size={14} />
                <input type="time" className="te__time-input" value={dueTime} onChange={(e) => handleDueTimeChange(e.target.value)} />
              </span>
            </span>
          </div>

          <div className="te__row">
            <span className="te__label">
              <BellIcon size={14} />
              Lembrete
            </span>
            <select className="te__value te__select" value={remind} onChange={(e) => handleRemindChange(e.target.value)}>
              {REMIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="te__row">
            <span className="te__label">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>
              Tags
            </span>
            <span
              className="te__value"
              style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}
            >
              {tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 13,
                    fontWeight: 500,
                    padding: '3px 4px 3px 9px',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                  }}
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    title="Remover tag"
                    aria-label={`Remover tag ${tag}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 16,
                      height: 16,
                      padding: 0,
                      border: 'none',
                      borderRadius: 4,
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      opacity: 0.75,
                    }}
                  >
                    <XIcon size={12} />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={() => addTag(tagDraft)}
                placeholder={tags.length ? 'adicionar...' : 'adicionar tag...'}
                style={{
                  flex: '1 1 90px',
                  minWidth: 90,
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--text)',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  padding: '2px 0',
                }}
              />
            </span>
          </div>
        </div>

        {/* Description area */}
        <textarea
          className="te__description"
          value={description}
          onChange={(e) => handleDescriptionChange(e.target.value)}
          placeholder="Escreva os detalhes..."
        />

        {/* Footer */}
        <div className="te__footer">
          <span className="te__created">{createdLabel}</span>
          <span className={`te__save te__save--${saveStatus}`}>
            {saveStatus === 'saving' && 'salvando...'}
            {saveStatus === 'saved' && 'salvo'}
            {saveStatus === 'error' && 'erro ao salvar'}
          </span>
        </div>
      </div>
    </div>
  );
}
