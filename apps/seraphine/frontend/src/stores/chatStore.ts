import { create } from 'zustand';

interface ChatState {
  status: 'disconnected' | 'connected';
  speak: boolean;
  think: boolean;
  talking: boolean;
}

interface ChatActions {
  setStatus: (s: 'disconnected' | 'connected') => void;
  setSpeak: (v: boolean) => void;
  setThink: (v: boolean) => void;
  setTalking: (v: boolean) => void;
}

export const useChatStore = create<ChatState & ChatActions>()((set) => ({
  status: 'disconnected',
  speak: (() => {
    try {
      const v = localStorage.getItem('seraphine.speak');
      return v === null ? true : v === 'true';
    } catch {
      return true;
    }
  })(),
  think: (() => {
    try {
      const v = localStorage.getItem('seraphine.think');
      return v === null ? false : v === 'true';
    } catch {
      return false;
    }
  })(),
  talking: false,

  setStatus: (s) => set({ status: s }),
  setSpeak: (v) => {
    try { localStorage.setItem('seraphine.speak', String(v)); } catch { /* */ }
    set({ speak: v });
  },
  setThink: (v) => {
    try { localStorage.setItem('seraphine.think', String(v)); } catch { /* */ }
    set({ think: v });
  },
  setTalking: (v) => set({ talking: v }),
}));
