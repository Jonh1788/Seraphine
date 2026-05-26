/**
 * 095 — Global reactive store for contextual actions.
 *
 * The activeAppReactor writes here; ContextualPills and CommandPalette
 * subscribe. Deliberately a simple pub/sub (no heavy state library
 * needed for 3 consumers).
 */

import type { ContextualAction } from './types';

export interface ContextualState {
  appName: string;
  actions: ContextualAction[];
}

type Listener = (state: ContextualState) => void;

class ContextualStore {
  private state: ContextualState = { appName: '', actions: [] };
  private listeners = new Set<Listener>();

  get(): ContextualState {
    return this.state;
  }

  set(s: ContextualState): void {
    this.state = s;
    this.listeners.forEach((cb) => cb(s));
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

export const contextualStore = new ContextualStore();
