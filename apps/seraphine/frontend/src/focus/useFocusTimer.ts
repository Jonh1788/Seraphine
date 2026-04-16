import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../utils/notify';

export type FocusPhase = 'work' | 'break' | 'long_break' | 'idle';

export interface FocusState {
  phase: FocusPhase;
  remaining: number;  // seconds
  cycle: number;      // 1-4
  task?: string;      // linked task title
  running: boolean;
}

export interface FocusActions {
  start: (task?: string) => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  reset: () => void;
}

const WORK_SECS = 25 * 60;
const BREAK_SECS = 5 * 60;
const LONG_BREAK_SECS = 15 * 60;

const STORAGE_KEY = 'seraphine.focus';

interface StoredFocus {
  phase: FocusPhase;
  remaining: number;
  cycle: number;
  task?: string;
  running: boolean;
  savedAt: number; // Date.now()
}

function loadState(): FocusState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const stored: StoredFocus = JSON.parse(raw);
    // If it was running, subtract elapsed time
    if (stored.running && stored.phase !== 'idle') {
      const elapsed = Math.floor((Date.now() - stored.savedAt) / 1000);
      stored.remaining = Math.max(0, stored.remaining - elapsed);
    }
    return {
      phase: stored.phase,
      remaining: stored.remaining,
      cycle: stored.cycle,
      task: stored.task,
      running: stored.running,
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: FocusState): void {
  const stored: StoredFocus = {
    ...state,
    savedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function defaultState(): FocusState {
  return { phase: 'idle', remaining: 0, cycle: 1, running: false };
}

export type PhaseTransitionCallback = (from: FocusPhase, to: FocusPhase) => void;

export function useFocusTimer(
  onPhaseTransition?: PhaseTransitionCallback,
): [FocusState, FocusActions] {
  const [state, setState] = useState<FocusState>(loadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onTransitionRef = useRef(onPhaseTransition);
  onTransitionRef.current = onPhaseTransition;

  // Persist on every state change
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Tick interval
  useEffect(() => {
    if (!state.running || state.phase === 'idle') return;

    const id = setInterval(() => {
      setState((prev) => {
        if (!prev.running || prev.remaining <= 0) return prev;
        const next = prev.remaining - 1;
        if (next > 0) return { ...prev, remaining: next };

        // Phase transition
        const fromPhase = prev.phase;
        let toPhase: FocusPhase;
        let toRemaining: number;
        let toCycle = prev.cycle;

        if (fromPhase === 'work') {
          if (prev.cycle % 4 === 0) {
            toPhase = 'long_break';
            toRemaining = LONG_BREAK_SECS;
          } else {
            toPhase = 'break';
            toRemaining = BREAK_SECS;
          }
        } else {
          // break or long_break -> work
          toPhase = 'work';
          toRemaining = WORK_SECS;
          toCycle = prev.cycle + 1;
        }

        // Notify
        const phaseLabels: Record<FocusPhase, string> = {
          work: 'Trabalho',
          break: 'Pausa',
          long_break: 'Pausa longa',
          idle: '',
        };
        const label = phaseLabels[toPhase];
        const mins = Math.floor(toRemaining / 60);
        void notify('Seraphine - Foco', `${label} - ${mins} minutos`);

        // Fire callback
        onTransitionRef.current?.(fromPhase, toPhase);

        return {
          ...prev,
          phase: toPhase,
          remaining: toRemaining,
          cycle: toCycle,
          running: true,
        };
      });
    }, 1000);

    return () => clearInterval(id);
  }, [state.running, state.phase]);

  const start = useCallback((task?: string) => {
    const newState: FocusState = {
      phase: 'work',
      remaining: WORK_SECS,
      cycle: 1,
      task,
      running: true,
    };
    setState(newState);
    void notify('Seraphine - Foco', 'Trabalho - 25 minutos');
    onTransitionRef.current?.('idle', 'work');
  }, []);

  const pause = useCallback(() => {
    setState((prev) => ({ ...prev, running: false }));
  }, []);

  const resume = useCallback(() => {
    setState((prev) => (prev.phase !== 'idle' ? { ...prev, running: true } : prev));
  }, []);

  const skip = useCallback(() => {
    setState((prev) => {
      if (prev.phase === 'idle') return prev;
      const fromPhase = prev.phase;
      let toPhase: FocusPhase;
      let toRemaining: number;
      let toCycle = prev.cycle;

      if (fromPhase === 'work') {
        if (prev.cycle % 4 === 0) {
          toPhase = 'long_break';
          toRemaining = LONG_BREAK_SECS;
        } else {
          toPhase = 'break';
          toRemaining = BREAK_SECS;
        }
      } else {
        toPhase = 'work';
        toRemaining = WORK_SECS;
        toCycle = prev.cycle + 1;
      }

      const phaseLabels: Record<FocusPhase, string> = {
        work: 'Trabalho',
        break: 'Pausa',
        long_break: 'Pausa longa',
        idle: '',
      };
      void notify('Seraphine - Foco', `${phaseLabels[toPhase]} - ${Math.floor(toRemaining / 60)} minutos`);
      onTransitionRef.current?.(fromPhase, toPhase);

      return { ...prev, phase: toPhase, remaining: toRemaining, cycle: toCycle, running: true };
    });
  }, []);

  const reset = useCallback(() => {
    setState(defaultState());
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return [state, { start, pause, resume, skip, reset }];
}
