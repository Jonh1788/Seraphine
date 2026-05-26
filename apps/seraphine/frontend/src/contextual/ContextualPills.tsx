/**
 * 095 — Contextual action pills for the companion window.
 *
 * Renders up to 3 glass-style pills below the avatar. They fade in
 * after 2 seconds of a stable app (no rapid switching) and fade out
 * after 30 seconds without interaction. Clicking a pill sends the
 * action as a user message over WebSocket and records usage on the
 * backend.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';
import { contextualStore, type ContextualState } from './store';
import type { ContextualAction } from './types';
import type { SeraphineWS } from '../ws/client';

/** Max pills visible at once. */
const MAX_PILLS = 3;
/** Delay before showing pills after a stable app is detected (ms). */
const STABLE_DELAY_MS = 2000;
/** Auto-hide timeout after no interaction (ms). */
const AUTO_HIDE_MS = 30_000;

interface ContextualPillsProps {
  ws: SeraphineWS | null;
  conversationId?: string;
}

export function ContextualPills({ ws, conversationId }: ContextualPillsProps): JSX.Element | null {
  const [actions, setActions] = useState<ContextualAction[]>([]);
  const [appName, setAppName] = useState('');
  const [visible, setVisible] = useState(false);
  const stableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to store changes
  useEffect(() => {
    const handle = (s: ContextualState): void => {
      // Clear any pending stable timer — new app change restarts debounce
      if (stableTimer.current) {
        clearTimeout(stableTimer.current);
        stableTimer.current = null;
      }

      if (s.actions.length === 0) {
        setActions([]);
        setVisible(false);
        return;
      }

      // Debounce: only show after the app has been stable for STABLE_DELAY_MS
      stableTimer.current = setTimeout(() => {
        setActions(s.actions.slice(0, MAX_PILLS));
        setAppName(s.appName);
        setVisible(true);
        resetHideTimer();
      }, STABLE_DELAY_MS);
    };

    const off = contextualStore.subscribe(handle);
    // Init from current state
    const init = contextualStore.get();
    if (init.actions.length > 0) {
      handle(init);
    }

    return () => {
      off();
      if (stableTimer.current) clearTimeout(stableTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const resetHideTimer = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
    }, AUTO_HIDE_MS);
  }, []);

  const handleClick = useCallback(
    (action: ContextualAction) => {
      if (!ws) return;

      // Send as a chat message — the backend's conversation engine will
      // route it to the right tool based on context.
      ws.send({
        type: 'user_message',
        conversation_id: conversationId,
        content: action.label,
        speak: true,
      } as never);

      // Record usage for ranking
      void fetch(`${API_BASE}/contextual/actions/${action.id}/used`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_name: appName }),
      }).catch(() => { /* best effort */ });

      // Reset hide timer after interaction
      resetHideTimer();
    },
    [ws, conversationId, appName, resetHideTimer],
  );

  if (!visible || actions.length === 0) return null;

  return (
    <div className="ctx-pills">
      {actions.map((a) => (
        <button
          key={a.id}
          className="ctx-pills__btn"
          onClick={() => handleClick(a)}
          title={a.description}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
