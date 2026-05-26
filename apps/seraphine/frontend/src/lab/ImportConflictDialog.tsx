/**
 * Modal for resolving gesture import name conflicts.
 *
 * SDD 087: Shows which gestures already exist and lets the user pick
 * a batch strategy (Substituir / Renomear / Pular).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ConflictStrategy } from './gestureExportImport';

export interface ImportConflictDialogProps {
  open: boolean;
  /** Names of gestures that conflict with existing ones. */
  conflictNames: string[];
  /** Total gesture count in the file being imported. */
  totalCount: number;
  onResolve: (strategy: ConflictStrategy) => void;
  onCancel: () => void;
}

export function ImportConflictDialog({
  open,
  conflictNames,
  totalCount,
  onResolve,
  onCancel,
}: ImportConflictDialogProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => firstBtnRef.current?.focus());
    }
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  const newCount = totalCount - conflictNames.length;

  return (
    <div
      className="confirm-overlay"
      onClick={onCancel}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-conflict-title"
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="import-conflict-title" className="confirm-dialog__title">
          Conflito de nomes
        </h3>
        <p className="confirm-dialog__message">
          {conflictNames.length === 1
            ? `O gesto "${conflictNames[0]}" ja existe.`
            : `${conflictNames.length} gestos ja existem:`}
        </p>
        {conflictNames.length > 1 && (
          <ul
            style={{
              maxHeight: 120,
              overflow: 'auto',
              margin: '8px 0',
              paddingLeft: 20,
              fontSize: '0.85rem',
              color: 'var(--text-secondary, #aaa)',
            }}
          >
            {conflictNames.slice(0, 20).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {conflictNames.length > 20 && (
              <li>...e mais {conflictNames.length - 20}</li>
            )}
          </ul>
        )}
        {newCount > 0 && (
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary, #aaa)',
              margin: '4px 0 8px',
            }}
          >
            {newCount} gesto(s) novo(s) serao importados normalmente.
          </p>
        )}
        <div
          className="confirm-dialog__actions"
          style={{ flexWrap: 'wrap', gap: 8 }}
        >
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--confirm"
            onClick={() => onResolve('skip')}
          >
            Pular existentes
          </button>
          <button
            ref={firstBtnRef}
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--confirm"
            onClick={() => onResolve('rename')}
          >
            Renomear
          </button>
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--confirm confirm-dialog__btn--danger"
            onClick={() => onResolve('replace')}
          >
            Substituir
          </button>
        </div>
      </div>
    </div>
  );
}
