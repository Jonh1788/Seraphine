import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';

interface QuickCaptureProps {
  open: boolean;
  onClose: () => void;
}

type Priority = 'baixa' | 'media' | 'alta';

export function QuickCapture({ open, onClose }: QuickCaptureProps): JSX.Element | null {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [priority, setPriority] = useState<Priority | null>(null);
  const [success, setSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear pending auto-close timer on unmount so a closed overlay doesn't
  // call onClose after the parent has already torn it down.
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setTitle('');
      setDueDate('');
      setDueTime('');
      setPriority(null);
      setSuccess(false);
      // Auto-focus after a frame so the DOM is rendered
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;

    const body: Record<string, unknown> = { title: trimmed };
    if (dueDate) {
      body.due_date = dueTime ? `${dueDate}T${dueTime}` : dueDate;
    }
    if (priority) {
      body.priority = priority;
    }

    try {
      await fetch(`${API_BASE}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Silently fail -- task list will sync on next refresh
    }

    setSuccess(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 500);
  }, [title, dueDate, dueTime, priority, onClose]);

  // Desktop-only: mobile webviews (iOS/Android) don't have the global
  // Cmd+Shift+S shortcut and the UX for a floating capture overlay
  // doesn't translate to touch. Skip rendering on mobile entirely.
  const isMobileWebview =
    typeof navigator !== 'undefined' &&
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (!open || isMobileWebview) return null;

  if (success) {
    return (
      <div className="quick-capture-overlay" onClick={onClose}>
        <div className="quick-capture" onClick={(e) => e.stopPropagation()}>
          <div className="quick-capture__success">Criado!</div>
        </div>
      </div>
    );
  }

  return (
    <div className="quick-capture-overlay" onClick={onClose}>
      <div
        className="quick-capture"
        onClick={(e) => e.stopPropagation()}
        data-tauri-drag-region
      >
        <input
          ref={inputRef}
          className="quick-capture__input"
          type="text"
          placeholder="Captura rapida..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />

        <div className="quick-capture__row">
          <input
            className="quick-capture__date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <input
            className="quick-capture__time"
            type="time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />

          <div className="quick-capture__spacer" />

          {(['baixa', 'media', 'alta'] as Priority[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`quick-capture__prio${priority === p ? ' quick-capture__prio--active' : ''} quick-capture__prio--${p}`}
              onClick={() => setPriority(priority === p ? null : p)}
              title={p.charAt(0).toUpperCase() + p.slice(1)}
            >
              {p === 'baixa' ? 'B' : p === 'media' ? 'M' : 'A'}
            </button>
          ))}
        </div>

        <div className="quick-capture__hint">
          Enter para criar &middot; Esc para cancelar
        </div>
      </div>
    </div>
  );
}
