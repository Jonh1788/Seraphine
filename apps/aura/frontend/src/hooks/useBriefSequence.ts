import { useEffect, useRef, useState } from "react";

/**
 * Reveal a sequence of items one at a time, mirroring the mockup's
 * 175ms-step entrance for the briefing screen.
 *
 * Usage:
 *   const seq = useBriefSequence({ count: 9, stepMs: 175, leadMs: 50 });
 *   <div className={seq.classOf(0)} />   // "brief-item is-in" once revealed
 *   seq.pulseTick                        // increments each insertion (use as React key)
 *   seq.completed                        // true once all items revealed
 */
interface UseBriefSequenceOpts {
  count: number;
  stepMs?: number;
  leadMs?: number;
  /** Restart the sequence whenever this value changes */
  resetKey?: unknown;
}

interface UseBriefSequence {
  classOf: (index: number) => string;
  isRevealed: (index: number) => boolean;
  pulseTick: number;
  completed: boolean;
  /** Skip ahead to fully revealed (used by tap-to-skip) */
  finish: () => void;
}

export function useBriefSequence(opts: UseBriefSequenceOpts): UseBriefSequence {
  const { count, stepMs = 175, leadMs = 50, resetKey } = opts;
  const [revealed, setRevealed] = useState(0);
  const [pulseTick, setPulseTick] = useState(0);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    // Clear any pending reveals from a prior run
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
    setRevealed(0);
    setPulseTick(0);

    if (count <= 0) return;

    for (let i = 0; i < count; i++) {
      const id = window.setTimeout(() => {
        setRevealed((r) => Math.max(r, i + 1));
        // Pulse the orb on every item *after* the first (the orb itself
        // is index 0 — pulsing on its own arrival would feel awkward).
        if (i > 0) setPulseTick((p) => p + 1);
      }, leadMs + i * stepMs);
      timersRef.current.push(id);
    }

    return () => {
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current = [];
    };
  }, [count, stepMs, leadMs, resetKey]);

  const finish = () => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
    setRevealed(count);
  };

  return {
    classOf: (i: number) => (i < revealed ? "brief-item is-in" : "brief-item"),
    isRevealed: (i: number) => i < revealed,
    pulseTick,
    completed: revealed >= count,
    finish,
  };
}
