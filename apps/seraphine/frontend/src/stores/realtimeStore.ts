import { create } from 'zustand';

interface RealtimeState {
  realtimeActive: boolean;
  manualMute: boolean;
  wakeWordEnabled: boolean;
}

interface RealtimeActions {
  setRealtimeActive: (v: boolean) => void;
  setManualMute: (v: boolean) => void;
  toggleManualMute: () => void;
  setWakeWordEnabled: (v: boolean) => void;
}

export const useRealtimeStore = create<RealtimeState & RealtimeActions>()((set) => ({
  realtimeActive: false,
  manualMute: (() => {
    try {
      return localStorage.getItem('seraphine.realtime.manualMute') === 'true';
    } catch {
      return false;
    }
  })(),
  wakeWordEnabled: (() => {
    try {
      return localStorage.getItem('seraphine.wakeWord') === 'true';
    } catch {
      return false;
    }
  })(),

  setRealtimeActive: (v) => set({ realtimeActive: v }),
  setManualMute: (v) => {
    try { localStorage.setItem('seraphine.realtime.manualMute', String(v)); } catch { /* */ }
    set({ manualMute: v });
  },
  toggleManualMute: () => set((s) => {
    const next = !s.manualMute;
    try { localStorage.setItem('seraphine.realtime.manualMute', String(next)); } catch { /* */ }
    return { manualMute: next };
  }),
  setWakeWordEnabled: (v) => {
    try { localStorage.setItem('seraphine.wakeWord', String(v)); } catch { /* */ }
    set({ wakeWordEnabled: v });
  },
}));
