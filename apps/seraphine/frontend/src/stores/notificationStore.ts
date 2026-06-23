import { create } from 'zustand';
import type { WhatsAppMessage } from '../whatsapp';

interface NotificationState {
  googleAuthed: boolean;
  unreadCount: number;
  whatsappUnread: number;
  whatsappMessages: WhatsAppMessage[];
  tasksPendingCount: number;
  pushStatus: 'idle' | 'subscribing' | 'subscribed' | 'error' | 'denied' | 'unsupported';
  pushMsg: string | null;
}

interface NotificationActions {
  setGoogleAuthed: (v: boolean) => void;
  setUnreadCount: (v: number) => void;
  setWhatsappUnread: (v: number) => void;
  incrementWhatsappUnread: () => void;
  pushWhatsappMessage: (msg: WhatsAppMessage) => void;
  /** Merge a batch (chat history / chat-list seeds) into the store, deduped by
   *  chatId+timestamp+body. Incoming entries win on collision, so a full-history
   *  message (correct fromMe) replaces a chat-list seed of the same message. */
  mergeWhatsappMessages: (msgs: WhatsAppMessage[]) => void;
  setTasksPendingCount: (v: number) => void;
  setPushStatus: (v: NotificationState['pushStatus']) => void;
  setPushMsg: (v: string | null) => void;
}

export const useNotificationStore = create<NotificationState & NotificationActions>()((set) => ({
  googleAuthed: false,
  unreadCount: 0,
  whatsappUnread: 0,
  whatsappMessages: [],
  tasksPendingCount: 0,
  pushStatus: 'idle',
  pushMsg: null,

  setGoogleAuthed: (v) => set({ googleAuthed: v }),
  setUnreadCount: (v) => set({ unreadCount: v }),
  setWhatsappUnread: (v) => set({ whatsappUnread: v }),
  incrementWhatsappUnread: () => set((s) => ({ whatsappUnread: s.whatsappUnread + 1 })),
  pushWhatsappMessage: (msg) => set((s) => ({
    whatsappMessages: [msg, ...s.whatsappMessages].slice(0, 400),
  })),
  mergeWhatsappMessages: (msgs) => set((s) => {
    const byKey = new Map<string, WhatsAppMessage>();
    const key = (m: WhatsAppMessage): string => `${m.chatId}|${m.timestamp}|${m.body}`;
    for (const m of s.whatsappMessages) byKey.set(key(m), m);
    for (const m of msgs) byKey.set(key(m), m); // incoming wins (history > seed)
    const merged = [...byKey.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 400);
    return { whatsappMessages: merged };
  }),
  setTasksPendingCount: (v) => set({ tasksPendingCount: v }),
  setPushStatus: (v) => set({ pushStatus: v }),
  setPushMsg: (v) => set({ pushMsg: v }),
}));
