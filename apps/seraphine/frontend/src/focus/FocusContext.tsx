import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useFocusTimer } from './useFocusTimer';
import type { FocusState, FocusActions, FocusPhase } from './useFocusTimer';
import { useOptionalAppRefs } from '../stores/RefsContext';
import { API_BASE } from '../api';

type FocusContextValue = [FocusState, FocusActions];

const FocusCtx = createContext<FocusContextValue | null>(null);

/** Single source of truth for the Pomodoro timer. Mount once near the app root.
 *  The 1s tick re-renders only consumers of useFocus(), not the whole shell. */
export function FocusProvider({ children }: { children: ReactNode }): JSX.Element {
  // Optional so the provider can render in isolation (tests) without RefsProvider.
  const refs = useOptionalAppRefs();
  const avatarCtrlRef = refs?.avatarCtrlRef;

  // Avatar expression + music transitions on phase change (moved out of AppLayout).
  const handleFocusTransition = useCallback((from: FocusPhase, to: FocusPhase) => {
    if (to === 'work' && (from === 'idle' || from === 'break' || from === 'long_break')) {
      fetch(`${API_BASE}/music/focus-start`, { method: 'POST' }).catch(() => {});
    }
    const ctrl = avatarCtrlRef?.current;
    if (!ctrl) return;
    if (to === 'work' && from === 'idle') {
      ctrl.setExpression?.('focused', 300, 0);
    } else if (to === 'work') {
      ctrl.setExpression?.('focused', 300, 0);
    } else if (to === 'break' || to === 'long_break') {
      ctrl.setExpression?.('warm', 300, 0);
    }
    if (from === 'long_break' && to === 'work') {
      ctrl.setExpression?.('happy', 300, 3000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, actions] = useFocusTimer(handleFocusTransition);
  const value = useMemo<FocusContextValue>(() => [state, actions], [state, actions]);

  return <FocusCtx.Provider value={value}>{children}</FocusCtx.Provider>;
}

export function useFocus(): FocusContextValue {
  const v = useContext(FocusCtx);
  if (!v) throw new Error('useFocus must be used within a FocusProvider');
  return v;
}
