import { useEffect, useMemo } from 'react';
import { detectClipboard } from './detect';
import type { ClipboardDetection, ClipboardKind } from './detect';
import { XIcon } from '../icons/Icons';

export interface ClipboardAssistModalProps {
  open: boolean;
  content: string;
  onClose: () => void;
  /** Send a chat message straight through the WS. */
  onSendMessage: (message: string) => void;
  /** Drop raw text into the chat composer without auto-sending. */
  onInsertInComposer: (text: string) => void;
}

const KIND_LABEL: Record<ClipboardKind, string> = {
  url: 'Link',
  email: 'Email',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  pix: 'PIX',
  code: 'Codigo',
  generic: 'Texto',
};

interface Suggestion {
  label: string;
  message: string;
}

/**
 * Build the kind-specific primary suggestion. Keeping it pure makes it
 * trivial to unit-test and keeps the modal render simple.
 */
function primarySuggestion(det: ClipboardDetection): Suggestion {
  const v = det.value;
  switch (det.kind) {
    case 'url':
      return { label: 'Resumir este link', message: `Resume este link: ${v}` };
    case 'email':
      return {
        label: `Enviar email pra ${v}`,
        message: `Quero enviar email pra ${v}`,
      };
    case 'cpf':
      return {
        label: 'Salvar este documento',
        message: `Anota este CPF: ${v}`,
      };
    case 'cnpj':
      return {
        label: 'Salvar este documento',
        message: `Anota este CNPJ: ${v}`,
      };
    case 'pix':
      return {
        label: 'Fazer este pagamento',
        message: `Quero pagar este PIX: ${v}`,
      };
    case 'code':
      return {
        label: 'Explicar este codigo',
        message: `Explica este codigo:\n${v}`,
      };
    case 'generic':
    default:
      return {
        label: 'Me ajuda com isto',
        message: `Me ajuda com isto:\n${v}`,
      };
  }
}

const PREVIEW_CHAR_LIMIT = 400;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export function ClipboardAssistModal({
  open,
  content,
  onClose,
  onSendMessage,
  onInsertInComposer,
}: ClipboardAssistModalProps): JSX.Element | null {
  const detection = useMemo(() => detectClipboard(content), [content]);
  const primary = useMemo(() => primarySuggestion(detection), [detection]);
  const isEmpty = content.trim().length === 0;

  // Escape closes. Registered as capture so it wins over other handlers.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const previewText = truncate(content, PREVIEW_CHAR_LIMIT);
  const isCode = detection.kind === 'code';

  return (
    <div
      className="clipboard-modal__backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="clipboard-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Acoes da area de transferencia"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="clipboard-modal__header">
          <div className="clipboard-modal__heading">
            <span className="clipboard-modal__badge">{KIND_LABEL[detection.kind]}</span>
            <h2 className="clipboard-modal__title">Area de transferencia</h2>
          </div>
          <button
            type="button"
            className="clipboard-modal__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            <XIcon size={16} />
          </button>
        </header>

        {isEmpty ? (
          <div className="clipboard-modal__empty">
            A area de transferencia esta vazia ou nao tem texto.
          </div>
        ) : (
          <>
            <pre
              className={`clipboard-modal__preview${
                isCode ? ' clipboard-modal__preview--code' : ''
              }`}
            >
              {previewText}
            </pre>

            <div className="clipboard-modal__actions">
              <button
                type="button"
                className="btn btn-primary clipboard-modal__btn-primary"
                onClick={() => onSendMessage(primary.message)}
              >
                {primary.label}
              </button>

              {detection.kind !== 'generic' && (
                <button
                  type="button"
                  className="btn clipboard-modal__btn-secondary"
                  onClick={() =>
                    onSendMessage(`Me ajuda com isto:\n${content}`)
                  }
                >
                  Me ajuda com isto
                </button>
              )}

              <button
                type="button"
                className="btn clipboard-modal__btn-secondary"
                onClick={() => onInsertInComposer(content)}
              >
                Colar no chat
              </button>

              <button
                type="button"
                className="btn clipboard-modal__btn-ghost"
                onClick={onClose}
              >
                Cancelar
              </button>
            </div>

            <div className="clipboard-modal__hint">
              Esc para fechar
            </div>
          </>
        )}
      </div>
    </div>
  );
}
