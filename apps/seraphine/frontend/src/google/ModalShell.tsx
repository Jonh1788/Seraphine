import { useEffect, type ReactNode } from 'react';

interface ModalShellProps {
  onClose: () => void;
  className?: string;
  children: ReactNode;
  /** ARIA label for the dialog element. */
  label?: string;
}

/**
 * Shared modal primitive: fixed overlay, Escape-to-close, overlay-click
 * close. Children render inside `.modal-content`.
 */
export function ModalShell({
  onClose,
  className,
  children,
  label,
}: ModalShellProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        className={`modal-content${className ? ` ${className}` : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
