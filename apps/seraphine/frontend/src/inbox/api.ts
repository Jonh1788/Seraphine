/**
 * Data layer for the Inbox module. Zero React — views (mobile screen and the
 * desktop `UnifiedInboxView`) call these instead of `fetch`.
 *
 * There is no `/inbox` endpoint: the inbox is composed client-side from exactly
 * TWO message sources —
 *   - e-mail    -> GET /google/gmail/important?limit=10
 *   - whatsapp  -> GET /whatsapp/chats
 * The desktop aggregator's other four domain sources (tasks, finance, insights,
 * work) are deliberately out of scope here; they stay in `UnifiedInboxView`.
 */
import { API_BASE } from '../api';
import { listImportantEmails } from '../google/api';
import type { EmailMessage } from '../google/types';
import type {
  InboxFilter,
  InboxItem,
  InboxLoadResult,
  InboxSource,
  InboxSourceError,
  WhatsAppMessage,
} from './types';

/** Matches the desktop panel's Gmail budget. */
const EMAIL_LIMIT = 10;

/** Default page size of the bridge history proxy. */
const HISTORY_LIMIT = 30;

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wire shapes (whatsapp-bridge, proxied verbatim by the backend)
// ---------------------------------------------------------------------------

interface BridgeChat {
  id?: string;
  name?: string;
  unreadCount?: number;
  lastMessage?: { body?: string; timestamp?: number; author?: string; fromMe?: boolean } | null;
}

interface BridgeMessage {
  id?: string;
  body?: string;
  timestamp?: number;
  fromMe?: boolean;
  ack?: number;
}

interface BridgeHistory {
  chatId?: string;
  chatName?: string;
  messages?: BridgeMessage[];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Bridge timestamps are epoch SECONDS (see whatsapp-bridge/src/routes/*.ts). */
function isoFromEpochSeconds(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts * 1000).toISOString();
}

/** Gmail ships the raw `Date` header (RFC 2822), not ISO. */
function isoFromHeaderDate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

/** Broadcast/newsletter pseudo-chats are not conversations — same exclusion the
 *  WhatsApp panel applies (src/whatsapp/api.ts). */
function isNoiseChat(chatId: string): boolean {
  return (
    !chatId
    || chatId === 'status'
    || chatId.endsWith('@broadcast')
    || chatId.endsWith('@newsletter')
  );
}

function emailToItem(msg: EmailMessage): InboxItem {
  return {
    id: msg.id,
    source: 'email',
    sender: msg.from || msg.subject || '',
    preview: msg.subject || msg.snippet || '',
    at: isoFromHeaderDate(msg.date),
    // The endpoint is "important AND unread", so a missing flag means unread.
    unread: msg.isUnread ?? true,
  };
}

function chatToItem(chat: BridgeChat): InboxItem | null {
  const id = chat.id || '';
  if (isNoiseChat(id)) return null;
  // A chat with no last message has nothing to show in a message box.
  if (!chat.lastMessage) return null;
  return {
    id,
    source: 'whatsapp',
    sender: chat.name || id,
    preview: chat.lastMessage.body || '',
    at: isoFromEpochSeconds(chat.lastMessage.timestamp),
    unread: (chat.unreadCount ?? 0) > 0,
  };
}

/** Newest first; items without a parseable date sink to the bottom. */
function byDateDesc(a: InboxItem, b: InboxItem): number {
  const ta = a.at ? Date.parse(a.at) : 0;
  const tb = b.at ? Date.parse(b.at) : 0;
  return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchEmailItems(): Promise<InboxItem[]> {
  const messages = await listImportantEmails(EMAIL_LIMIT);
  return (Array.isArray(messages) ? messages : []).map(emailToItem);
}

async function fetchWhatsAppItems(): Promise<InboxItem[]> {
  const chats = await request<BridgeChat[]>('/whatsapp/chats');
  const out: InboxItem[] = [];
  for (const chat of Array.isArray(chats) ? chats : []) {
    const item = chatToItem(chat);
    if (item) out.push(item);
  }
  return out;
}

const SOURCES: Record<InboxSource, () => Promise<InboxItem[]>> = {
  email: fetchEmailItems,
  whatsapp: fetchWhatsAppItems,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the inbox and report per-source failures instead of throwing: a dead
 * WhatsApp bridge must still let the e-mails render (and vice-versa).
 */
export async function listInboxDetailed(filter: InboxFilter): Promise<InboxLoadResult> {
  const wanted: InboxSource[] = filter === 'all' ? ['email', 'whatsapp'] : [filter];
  const settled = await Promise.allSettled(wanted.map((source) => SOURCES[source]()));

  const items: InboxItem[] = [];
  const errors: InboxSourceError[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      const reason = result.reason;
      errors.push({
        source: wanted[index],
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });

  // Only the composed view needs a merged ordering; a single source already
  // arrives in its own (newest-first) server order and is left untouched.
  if (wanted.length > 1) items.sort(byDateDesc);
  return { items, errors };
}

/**
 * Items for the inbox screen. Throws only when EVERY requested source failed —
 * a partial failure returns what did load (use `listInboxDetailed` to also show
 * which source is down).
 */
export async function listInbox(filter: InboxFilter): Promise<InboxItem[]> {
  const { items, errors } = await listInboxDetailed(filter);
  const requested = filter === 'all' ? 2 : 1;
  if (errors.length === requested) {
    throw new Error(errors.map((e) => `${e.source}: ${e.message}`).join(' · '));
  }
  return items;
}

/** Recent history of one WhatsApp chat, oldest → newest (thread order). */
export async function listWhatsAppMessages(
  chatId: string,
  limit = HISTORY_LIMIT,
): Promise<WhatsAppMessage[]> {
  const data = await request<BridgeHistory>(
    `/whatsapp/messages/${encodeURIComponent(chatId)}?limit=${limit}`,
  );
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return messages
    .map((msg) => ({
      id: msg.id || '',
      body: msg.body || '',
      fromMe: Boolean(msg.fromMe),
      at: isoFromEpochSeconds(msg.timestamp),
      // Pass `ack` through only when the bridge sent it — no invented field.
      ...(typeof msg.ack === 'number' ? { ack: msg.ack } : {}),
    }))
    .sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0));
}
