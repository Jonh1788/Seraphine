import { create } from 'zustand';
import { onAgentEvent, onAgentExit } from './api';
import type { AgentEvent } from './types';

interface AgentStreamState {
  events: AgentEvent[];
  subscribed: boolean;
  ensureSubscribed: () => void;
}

/**
 * Global, persistent accumulator for the Maestro agent-event stream.
 *
 * The Tauri listener is set up exactly once and never torn down for the app
 * session, so events survive Maestro view/tab unmounts. The previous
 * per-component `useAgentStream` hook reset `events` to `[]` on every remount,
 * which silently dropped the in-progress session list activity AND the
 * self-improve run the user had going (leave the tab, come back, "sumiu tudo").
 */
export const useAgentStreamStore = create<AgentStreamState>((set, get) => ({
  events: [],
  subscribed: false,
  ensureSubscribed: () => {
    if (get().subscribed) return;
    set({ subscribed: true });
    void onAgentEvent((e) => set((s) => ({ events: [...s.events, e] })));
    void onAgentExit((id) =>
      set((s) => ({ events: [...s.events, { agent_id: id, kind: { kind: 'other' }, raw: { exit: true } }] })));
  },
}));
