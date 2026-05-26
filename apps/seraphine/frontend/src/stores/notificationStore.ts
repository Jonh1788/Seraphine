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
    whatsappMessages: [msg, ...s.whatsappMessages].slice(0, 100),
  })),
  setTasksPendingCount: (v) => set({ tasksPendingCount: v }),
  setPushStatus: (v) => set({ pushStatus: v }),
  setPushMsg: (v) => set({ pushMsg: v }),
}));
