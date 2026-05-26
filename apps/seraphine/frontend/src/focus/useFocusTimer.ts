import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../utils/notify';
import { logFocusSession, setFocusActive } from './api';

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
  /** ISO timestamp of when this phase started — used for backend logging. */
  phaseStartedAt?: string;
}

/** Map internal phase names to the backend session type. */
function sessionType(phase: FocusPhase): 'work' | 'short_break' | 'long_break' {
  if (phase === 'break') return 'short_break';
  if (phase === 'long_break') return 'long_break';
  return 'work';
}

/** Fire-and-forget: persist a completed/cancelled focus phase to the backend.
 *  Falls back silently on network errors — localStorage already has the data. */
function persistSession(
  phase: FocusPhase,
  startedAt: string,
  completed: boolean,
  notes?: string,
): void {
  // Only log work sessions and breaks — idle is not a session.
  if (phase === 'idle') return;
  const endedAt = new Date().toISOString();
  logFocusSession({
    started_at: startedAt,
    ended_at: endedAt,
    type: sessionType(phase),
    completed,
    interruptions: 0,
    notes,
  }).catch(() => {
    // Backend offline — session lost to the backend but the user can
    // still see timer state in localStorage. Acceptable trade-off.
    if (import.meta.env.DEV) console.warn('[focus] failed to persist session to backend');
  });
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

/** Read persisted phaseStartedAt from localStorage. */
function loadPhaseStartedAt(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored: StoredFocus = JSON.parse(raw);
    return stored.phaseStartedAt ?? null;
  } catch {
    return null;
  }
}

function saveState(state: FocusState, phaseStartedAt: string | null): void {
  const stored: StoredFocus = {
    ...state,
    savedAt: Date.now(),
    phaseStartedAt: phaseStartedAt ?? undefined,
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

  // Track when the current phase started (ISO string).
  const phaseStartedAtRef = useRef<string | null>(loadPhaseStartedAt());

  // Persist on every state change
  useEffect(() => {
    saveState(state, phaseStartedAtRef.current);
  }, [state]);

  // Tick interval
  useEffect(() => {
    if (!state.running || state.phase === 'idle') return;

    const id = setInterval(() => {
      setState((prev) => {
        if (!prev.running || prev.remaining <= 0) return prev;
        const next = prev.remaining - 1;
        if (next > 0) return { ...prev, remaining: next };

        // Phase transition — the phase completed naturally
        const fromPhase = prev.phase;

        // Persist the completed phase to the backend
        if (phaseStartedAtRef.current) {
          persistSession(fromPhase, phaseStartedAtRef.current, true, prev.task);
        }

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

        // Update phase start time for the new phase
        phaseStartedAtRef.current = new Date().toISOString();

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
    phaseStartedAtRef.current = new Date().toISOString();
    const newState: FocusState = {
      phase: 'work',
      remaining: WORK_SECS,
      cycle: 1,
      task,
      running: true,
    };
    setState(newState);
    void notify('Seraphine - Foco', 'Trabalho - 25 minutos');
    void setFocusActive(true).catch(() => {});
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

      // Skipping a work phase = cancelled session. Skipping a break = completed break.
      if (phaseStartedAtRef.current) {
        const completed = fromPhase !== 'work';
        persistSession(fromPhase, phaseStartedAtRef.current, completed, prev.task);
      }

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

      phaseStartedAtRef.current = new Date().toISOString();

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
    // Log the current phase as cancelled when the user stops the timer
    const cur = stateRef.current;
    if (cur.phase !== 'idle' && phaseStartedAtRef.current) {
      persistSession(cur.phase, phaseStartedAtRef.current, false, cur.task);
    }
    phaseStartedAtRef.current = null;
    setState(defaultState());
    localStorage.removeItem(STORAGE_KEY);
    void setFocusActive(false).catch(() => {});
  }, []);

  return [state, { start, pause, resume, skip, reset }];
}
