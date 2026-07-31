/**
 * Types for the mobile Inbox — a two-source message box (Gmail "important"
 * + WhatsApp chats).
 *
 * NOT to be confused with the desktop `UnifiedInboxView`, which is a six-source
 * domain aggregator (tasks, finance, insights, work, notifications, e-mail) and
 * keeps its own local `InboxItem` shape. The two are different products over
 * overlapping data and are deliberately NOT unified.
 */

export type InboxSource = 'email' | 'whatsapp';

export type InboxFilter = 'all' | InboxSource;

export interface InboxItem {
  /** The source's own id: Gmail message id, or WhatsApp chat id — so it can be
   *  used to open the item (mark-read / thread view). Unique only *within* a
   *  source: use `${source}:${id}` as a list key. */
  id: string;
  source: InboxSource;
  /** Gmail: the `From` header (falls back to the subject).
   *  WhatsApp: the chat name (falls back to the chat id).
   *  `''` when the source carries nothing — the screen owns the placeholder. */
  sender: string;
  /** Gmail: subject (falls back to the snippet). WhatsApp: last message body.
   *  `''` when the source carries nothing. */
  preview: string;
  /** ISO 8601 UTC. `''` when the source has no parseable date. */
  at: string;
  unread: boolean;
}

export interface WhatsAppMessage {
  id: string;
  body: string;
  fromMe: boolean;
  /** ISO 8601 UTC. `''` when the bridge sent no timestamp. */
  at: string;
  /** Delivery ack (1 sent, 2 delivered, 3 read). Absent unless the bridge
   *  actually sends it — today's `/whatsapp/messages/{id}` proxy does not. */
  ack?: number;
}

export interface InboxSourceError {
  source: InboxSource;
  message: string;
}

/** Partial-failure aware result: one dead source must never empty the screen. */
export interface InboxLoadResult {
  items: InboxItem[];
  errors: InboxSourceError[];
}
