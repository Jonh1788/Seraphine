import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from '../icons/Icons';
import type { SeraphineTask } from '../finance/types';
import { API_BASE } from '../api';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending', label: 'Pendente' },
  { value: 'approved', label: 'Em andamento' },
  { value: 'completed', label: 'Concluido' },
  { value: 'rejected', label: 'Descartado' },
];

const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Nenhuma' },
  { value: 'low', label: 'Baixa' },
  { value: 'med', label: 'Media' },
  { value: 'high', label: 'Alta' },
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const saveLabel =
    saveStatus === 'saving'
      ? 'salvando...'
      : saveStatus === 'saved'
        ? 'salvo'
        : saveStatus === 'error'
          ? 'erro ao salvar'
          : '';

  if (loadError) {
    return (
      <div className="password-modal-backdrop" onClick={onClose}>
        <div className="password-modal task-editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="task-editor-modal__header">
            <h4 className="password-modal__title">Erro</h4>
            <button type="button" className="task-editor-modal__close" onClick={onClose}>
              <XIcon size={18} />
            </button>
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

  return (
    <div className="password-modal-backdrop" onClick={onClose}>
      <div
        className="password-modal task-editor-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-editor-modal__header">
          <h4 className="password-modal__title">Editar tarefa</h4>
          <button type="button" className="task-editor-modal__close" onClick={onClose}>
            <XIcon size={18} />
          </button>
        </div>

        <label className="new-task-modal__label">
          Titulo
          <input
            type="text"
            className="password-modal__input task-editor-modal__title-input"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
          />
        </label>

        <div className="new-task-modal__row">
          <label className="new-task-modal__label">
            Status
            <select
              className="password-modal__input"
              value={status}
              onChange={(e) => handleStatusChange(e.target.value)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="new-task-modal__label">
            Prioridade
            <select
              className="password-modal__input"
              value={priority}
              onChange={(e) => handlePriorityChange(e.target.value)}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="new-task-modal__row">
          <label className="new-task-modal__label">
            Data de entrega
            <input
              type="date"
              className="password-modal__input"
              value={dueDate}
              onChange={(e) => handleDueDateChange(e.target.value)}
            />
          </label>
          <label className="new-task-modal__label">
            Horario
            <input
              type="time"
              className="password-modal__input"
              value={dueTime}
              onChange={(e) => handleDueTimeChange(e.target.value)}
            />
          </label>
        </div>

        <label className="new-task-modal__label">
          Descricao
          <textarea
            className="password-modal__input new-task-modal__textarea"
            value={description}
            onChange={(e) => handleDescriptionChange(e.target.value)}
            rows={4}
            placeholder="Notas ou detalhes..."
          />
        </label>

        <div className="task-editor-modal__footer">
          <div className="task-editor-modal__save-status">
            {saveLabel && (
              <span className={`task-editor-modal__save-indicator task-editor-modal__save-indicator--${saveStatus}`}>
                {saveLabel}
              </span>
            )}
          </div>
          <div className="task-editor-modal__danger">
            {confirmDelete ? (
              <>
                <span className="task-editor-modal__confirm-text">Tem certeza?</span>
                <button
                  type="button"
                  className="btn-reject"
                  disabled={deleting}
                  onClick={handleDelete}
                >
                  {deleting ? 'Excluindo...' : 'Sim, excluir'}
                </button>
                <button
                  type="button"
                  className="btn-confirm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancelar
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-reject"
                onClick={() => setConfirmDelete(true)}
              >
                Excluir tarefa
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
