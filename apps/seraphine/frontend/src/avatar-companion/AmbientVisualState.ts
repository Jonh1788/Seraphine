/**
 * 056 — Ambient visual feedback.
 *
 * Polls backend state (open_loops, discoveries, finance_nudges) and
 * listens to WS mood events, then reflects the net state on the
 * avatar — idle expression, aura sprites, sleep mode. Respects the
 * 050 ActiveAppReactor when it has a strong opinion (it wins for
 * non-persistent expressions).
 */

import { API_BASE } from '../api';

export interface VisualTarget {
  setExpression?: (e: string, fade?: number, hold?: number) => void;
}

interface Pending {
  openLoops: number;
  discoveries: number;
  financeNudges: number;
}

export class AmbientVisualState {
  private timer: ReturnType<typeof setInterval> | null = null;
  private overridingMood: string | null = null;
  private overrideExpires = 0;

  constructor(private ctrl: VisualTarget) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 45_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called by WS handler when a mood event arrives. */
  onMood(mood: string, durationMs: number): void {
    this.overridingMood = mood;
    this.overrideExpires = Date.now() + Math.max(durationMs, 20000);
    try { this.ctrl.setExpression?.(mood, 300, durationMs); } catch { /* */ }
  }

  private async tick(): Promise<void> {
    // If a mood override is still active, don't touch the expression.
    if (this.overridingMood && Date.now() < this.overrideExpires) return;

    const pending = await this.fetchPending();
    const expression = this.pickExpression(pending);
    if (expression) {
      try { this.ctrl.setExpression?.(expression, 500, 0); } catch { /* */ }
    }
  }

  private pickExpression(p: Pending): string | null {
    // Priority order: concern > curious > warm > soft
    if (p.openLoops > 3) return 'worried';
    if (p.financeNudges > 0) return 'concerned';
    if (p.discoveries > 0) return 'curious';
    if (p.openLoops > 0) return 'soft';
    return null;
  }

  private async fetchPending(): Promise<Pending> {
    try {
      const res = await fetch(`${API_BASE}/memory/browser`);
      if (!res.ok) return { openLoops: 0, discoveries: 0, financeNudges: 0 };
      const data = await res.json() as { counts: Record<string, number> };
      return {
        openLoops: data.counts.open_loops || 0,
        discoveries: data.counts.discoveries || 0,
        financeNudges: data.counts.finance_nudges || 0,
      };
    } catch {
      return { openLoops: 0, discoveries: 0, financeNudges: 0 };
    }
  }
}
