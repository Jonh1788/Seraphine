import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import { getEmail, listImportantEmails, markEmailAsRead, markEmailsAsReadBatch } from './api';
import { ModalShell } from './ModalShell';
import type { EmailFull, EmailMessage } from './types';
import { chipColor, formatEmailDate, parseSender } from './utils';

interface EmailInboxModalProps {
  open: boolean;
  onClose: () => void;
  ws: SeraphineWS | null;
  /** Deep-link target: a Gmail message id to auto-open + expand. */
  messageId?: string | null;
}

const REFRESH_MS = 5 * 60 * 1000;

/**
 * Full-screen inbox for Gmail "important + unread". Click a row to
 * expand and fetch the full body. Actions trigger prefilled chat
 * messages via the WebSocket.
 */
export function EmailInboxModal({ open, onClose, ws, messageId }: EmailInboxModalProps): JSX.Element | null {
  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullById, setFullById] = useState<Map<string, EmailFull>>(new Map());
  const [loadingFull, setLoadingFull] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState<boolean>(false);
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

  // Deep-link: when opened with a target messageId (from a WhatsApp
  // urgency push, ?inbox=<id>), fetch that message and expand it — even
  // if it isn't in the "important + unread" list.
  useEffect(() => {
    if (!open || !messageId) return;
    let cancelled = false;
    setExpandedId(messageId);
    void (async () => {
      try {
        const full = await getEmail(messageId);
        if (cancelled) return;
        setFullById((prev) => {
          const next = new Map(prev);
          next.set(messageId, full);
          return next;
        });
        setEmails((prev) => {
          if (prev.some((m) => m.id === messageId)) return prev;
          const row: EmailMessage = {
            id: full.id,
            threadId: '',
            from: full.from,
            subject: full.subject,
            snippet: '',
            date: full.date,
            isUnread: true,
            isImportant: false,
          };
          return [row, ...prev];
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, messageId]);

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

  const markAllRead = async () => {
    const unreadIds = emails.filter((m) => m.isUnread).map((m) => m.id);
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    setError(null);
    try {
      await markEmailsAsReadBatch(unreadIds);
      setEmails((prev) =>
        prev.map((m) => (unreadIds.includes(m.id) ? { ...m, isUnread: false } : m)),
      );
    } catch (e) {
      setError(`Falha ao marcar todos: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMarkingAll(false);
    }
  };

  const markRead = async (email: EmailMessage) => {
    setMarkingId(email.id);
    setError(null);
    try {
      await markEmailAsRead(email.id);
      // Optimistic local update: drop unread flag, collapse row.
      setEmails((prev) =>
        prev.map((m) => (m.id === email.id ? { ...m, isUnread: false } : m)),
      );
      if (expandedId === email.id) setExpandedId(null);
    } catch (e) {
      setError(`Falha ao marcar como lido: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMarkingId(null);
    }
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
          {emails.some((m) => m.isUnread) && (
            <button
              type="button"
              className="btn-ghost email-inbox-header__mark-all"
              onClick={() => void markAllRead()}
              disabled={markingAll}
              title="Marcar todos como lidos"
            >
              {markingAll ? 'Marcando...' : 'Marcar todos como lidos'}
            </button>
          )}
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
                  {full && (full.bodyHtml ? (
                    <iframe
                      className="email-row__body-frame"
                      title={`email-${email.id}`}
                      sandbox=""
                      srcDoc={full.bodyHtml}
                    />
                  ) : (
                    <pre className="email-row__body-text">{full.body}</pre>
                  ))}
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
                      onClick={() => void markRead(email)}
                      disabled={markingId === email.id}
                    >
                      {markingId === email.id ? 'Marcando...' : 'Marcar como lido'}
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
