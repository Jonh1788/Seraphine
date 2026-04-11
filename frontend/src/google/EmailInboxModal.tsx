import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import { getEmail, listImportantEmails } from './api';
import { ModalShell } from './ModalShell';
import type { EmailFull, EmailMessage } from './types';
import { chipColor, formatEmailDate, parseSender } from './utils';

interface EmailInboxModalProps {
  open: boolean;
  onClose: () => void;
  ws: SeraphineWS | null;
}

const REFRESH_MS = 5 * 60 * 1000;

/**
 * Full-screen inbox for Gmail "important + unread". Click a row to
 * expand and fetch the full body. Actions trigger prefilled chat
 * messages via the WebSocket.
 */
export function EmailInboxModal({ open, onClose, ws }: EmailInboxModalProps): JSX.Element | null {
  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullById, setFullById] = useState<Map<string, EmailFull>>(new Map());
  const [loadingFull, setLoadingFull] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEmails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listImportantEmails(20);
      setEmails(list);
    } catch (e) {
      setError(String(e));
      setEmails([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchEmails();
    timerRef.current = setInterval(() => void fetchEmails(), REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [open, fetchEmails]);

  useEffect(() => {
    if (!open) return;
    const handler = () => void fetchEmails();
    window.addEventListener('google-authed', handler);
    return () => window.removeEventListener('google-authed', handler);
  }, [open, fetchEmails]);

  const toggleExpand = async (email: EmailMessage) => {
    if (expandedId === email.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(email.id);
    if (!fullById.has(email.id)) {
      setLoadingFull(email.id);
      try {
        const full = await getEmail(email.id);
        setFullById((prev) => {
          const next = new Map(prev);
          next.set(email.id, full);
          return next;
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setLoadingFull(null);
      }
    }
  };

  const sendUserMessage = (content: string) => {
    if (!ws) return;
    ws.send({ type: 'user_message', content, speak: false });
  };

  const startReply = (email: EmailMessage) => {
    setReplyingId(email.id);
    setReplyText(`Responde ao email '${email.subject}': `);
  };

  const submitReply = () => {
    const text = replyText.trim();
    if (!text) return;
    sendUserMessage(text);
    setReplyingId(null);
    setReplyText('');
  };

  const cancelReply = () => {
    setReplyingId(null);
    setReplyText('');
  };

  const markRead = (email: EmailMessage) => {
    sendUserMessage(`Marca como lido o email '${email.subject}' de ${email.from}`);
  };

  if (!open) return null;

  return (
    <ModalShell
      onClose={onClose}
      className="email-inbox-modal"
      label="Emails importantes nao lidos"
    >
      <header className="email-inbox-header">
        <h2>Emails importantes nao lidos</h2>
        <div className="email-inbox-header__actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void fetchEmails()}
            aria-label="Atualizar"
            title="Atualizar"
          >
            &#8635;
          </button>
          <button
            type="button"
            className="btn-ghost email-inbox-header__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            &times;
          </button>
        </div>
      </header>

      {error && <div className="email-inbox-error">{error}</div>}

      {loading && emails.length === 0 && (
        <div className="email-inbox-loading">Carregando...</div>
      )}

      {!loading && emails.length === 0 && !error && (
        <div className="email-inbox-empty">
          <div className="email-inbox-empty__icon" aria-hidden>
            &#9993;
          </div>
          <p>Sem emails importantes no momento.</p>
        </div>
      )}

      <ul className="email-list">
        {emails.map((email) => {
          const expanded = expandedId === email.id;
          const sender = parseSender(email.from);
          const initial = (sender.name[0] || sender.email[0] || '?').toUpperCase();
          const avatarColor = chipColor(sender.email || email.id);
          const full = fullById.get(email.id);
          const isLoadingBody = loadingFull === email.id;
          const rowClasses = ['email-row'];
          if (email.isUnread) rowClasses.push('email-row--unread');
          if (expanded) rowClasses.push('email-row--expanded');
          return (
            <li key={email.id} className={rowClasses.join(' ')}>
              <button
                type="button"
                className="email-row__main"
                onClick={() => void toggleExpand(email)}
              >
                <div
                  className="email-avatar"
                  style={{ background: avatarColor }}
                  aria-hidden
                >
                  {initial}
                </div>
                <div className="email-row__sender">
                  <span className="email-row__name">{sender.name}</span>
                  <span className="email-row__subject">{email.subject || '(sem assunto)'}</span>
                  <span className="email-row__snippet">{email.snippet}</span>
                </div>
                <div className="email-row__date">{formatEmailDate(email.date)}</div>
              </button>

              {expanded && (
                <div className="email-row__body">
                  {isLoadingBody && <div className="email-row__loading">Carregando corpo...</div>}
                  {full && (
                    <pre className="email-row__body-text">{full.body}</pre>
                  )}
                  <div className="email-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => startReply(email)}
                      disabled={!ws}
                    >
                      Responder
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => markRead(email)}
                      disabled={!ws}
                    >
                      Marcar como lido
                    </button>
                  </div>
                  {replyingId === email.id && (
                    <div className="email-reply">
                      <textarea
                        autoFocus
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        rows={3}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') cancelReply();
                        }}
                      />
                      <div className="email-reply__actions">
                        <button type="button" className="btn btn-primary" onClick={submitReply}>
                          Enviar
                        </button>
                        <button type="button" className="btn-ghost" onClick={cancelReply}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </ModalShell>
  );
}
