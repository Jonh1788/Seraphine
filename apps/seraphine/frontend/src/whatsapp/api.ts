// Thin REST client for the WhatsApp bridge proxy routes. Used by WhatsAppPanel
// to seed the chat list + load a conversation's history on open (the live WS
// feed only carries messages that arrive while the panel is mounted).
import { API_BASE } from '../api';
import type { WhatsAppMessage } from './WhatsAppPanel';

function isNoiseChat(chatId: string): boolean {
  return (
    !chatId ||
    chatId === 'status@broadcast' ||
    chatId === 'status' ||
    chatId.endsWith('@broadcast') ||
    chatId.endsWith('@newsletter')
  );
}

interface BridgeChat {
  id: string;
  name?: string;
  unreadCount?: number;
  lastMessage?: { body?: string; timestamp?: number; author?: string } | null;
}

interface BridgeMessage {
  id?: string;
  body?: string;
  timestamp?: number;
  fromMe?: boolean;
  author?: string;
}

/** Recent chats → one SEED message each (the chat's last message) so the panel's
 *  chat list populates even before any live message arrives. */
export async function fetchWhatsappChats(): Promise<WhatsAppMessage[]> {
  const res = await fetch(`${API_BASE}/whatsapp/chats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const chats = (await res.json()) as BridgeChat[];
  const out: WhatsAppMessage[] = [];
  for (const c of chats || []) {
    const chatId = c.id || '';
    if (isNoiseChat(chatId) || !c.lastMessage) continue;
    out.push({
      chatId,
      chatName: c.name || chatId,
      author: c.lastMessage.author || c.name || chatId,
      body: c.lastMessage.body || '',
      timestamp: c.lastMessage.timestamp || 0,
      fromMe: false, // chat-list preview has no direction; corrected when history loads
      important: (c.unreadCount || 0) > 0,
    });
  }
  return out;
}

/** Full recent history of one chat (with correct fromMe per message). */
export async function fetchWhatsappHistory(chatId: string, limit = 30): Promise<WhatsAppMessage[]> {
  const res = await fetch(
    `${API_BASE}/whatsapp/messages/${encodeURIComponent(chatId)}?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { chatName?: string; messages?: BridgeMessage[] };
  const chatName = data.chatName || chatId;
  return (data.messages || []).map((m) => ({
    chatId,
    chatName,
    author: m.author || chatName,
    body: m.body || '',
    timestamp: m.timestamp || 0,
    fromMe: Boolean(m.fromMe),
    important: false,
  }));
}
