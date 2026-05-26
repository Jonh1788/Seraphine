/**
 * 050 — Reactive animations per active macOS app.
 * 095 — Extended: also fetches contextual actions from backend and
 *       publishes them to the contextualStore for pills + command palette.
 *
 * Polls `active_app_local` every 5 seconds and maps the result to an
 * expression/gesture combo on the VrmAvatarController. Debounced so
 * back-and-forth focus doesn't thrash animations.
 */

import { API_BASE } from '../api';
import { contextualStore } from '../contextual/store';
import type { ContextualAction } from '../contextual/types';

export interface AvatarLike {
  setExpression?: (emotion: string, fade?: number, hold?: number) => void;
  playGesture?: (name: string) => void | Promise<void>;
}

interface AppReaction {
  match: (name: string) => boolean;
  expression: string;
  gesture?: string;
}

const REACTIONS: AppReaction[] = [
  { match: (n) => /code|cursor|xcode|android studio/i.test(n),
    expression: 'focused' },
  { match: (n) => /arc|chrome|safari|firefox|brave/i.test(n),
    expression: 'curious' },
  { match: (n) => /slack|discord|messages|telegram|whatsapp/i.test(n),
    expression: 'warm', gesture: 'wave' },
  { match: (n) => /spotify|music|apple music|vlc/i.test(n),
    expression: 'playful' },
  { match: (n) => /terminal|iterm|warp|ghostty|tabby/i.test(n),
    expression: 'thinking' },
  { match: (n) => /finder/i.test(n),
    expression: 'curious' },
  { match: (n) => /mail|gmail|outlook/i.test(n),
    expression: 'soft' },
  { match: (n) => /notion|obsidian|notes/i.test(n),
    expression: 'focused' },
  { match: (n) => /figma|sketch|photoshop/i.test(n),
    expression: 'playful' },
];

const DEFAULT_REACTION: AppReaction = {
  match: () => true,
  expression: 'soft',
};

function pick(appName: string): AppReaction {
  for (const r of REACTIONS) {
    if (r.match(appName)) return r;
  }
  return DEFAULT_REACTION;
}

export class ActiveAppReactor {
  private lastApp = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private waveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctrl: AvatarLike) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.waveTimer) clearTimeout(this.waveTimer);
    this.waveTimer = null;
  }

  /** 095 — Fetch contextual actions from the backend and publish to store. */
  private async fetchContextualActions(appName: string): Promise<void> {
    try {
      const res = await fetch(
        `${API_BASE}/contextual/actions?app=${encodeURIComponent(appName)}`,
      );
      if (!res.ok) {
        contextualStore.set({ appName, actions: [] });
        return;
      }
      const data = (await res.json()) as { actions: ContextualAction[] };
      contextualStore.set({ appName, actions: data.actions ?? [] });
    } catch {
      contextualStore.set({ appName, actions: [] });
    }
  }

  private async tick(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const info = await invoke<{ app_name: string; window_title: string }>(
        'active_app_local',
      );
      const app = info.app_name || '';
      if (app === this.lastApp) return;
      this.lastApp = app;
      const reaction = pick(app);
      try {
        this.ctrl.setExpression?.(reaction.expression, 400, 0);
      } catch { /* ready yet? */ }

      // 095 — fetch contextual actions for the new active app
      void this.fetchContextualActions(app);

      if (reaction.gesture) {
        try { await this.ctrl.playGesture?.(reaction.gesture); } catch { /* */ }
        // Slack/Discord wave every 60s while still active.
        if (reaction.gesture === 'wave') {
          if (this.waveTimer) clearTimeout(this.waveTimer);
          this.waveTimer = setTimeout(() => {
            if (this.lastApp === app) {
              try { void this.ctrl.playGesture?.('wave'); } catch { /* */ }
            }
          }, 60_000);
        }
      }
    } catch {
      // not in Tauri or permission denied — stay quiet
    }
  }
}
