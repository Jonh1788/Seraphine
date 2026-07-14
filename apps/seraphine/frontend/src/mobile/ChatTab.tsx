import { useEffect, useState } from 'react';
import { useAppRefs } from '../stores/RefsContext';
import { ChatView } from '../chat/ChatView';

/**
 * Phone-shell wrapper around the shared {@link ChatView}. Reuses the single
 * WebSocket created asynchronously by `AppBootstrap` (mounted on the phone
 * path too) via `useAppRefs().wsRef`. Voice / realtime affordances are
 * inert on mobile Fase 1 — only text chat is wired.
 */
export function ChatTab() {
  const { wsRef } = useAppRefs();
  const [ready, setReady] = useState(!!wsRef.current);
  const [status, setStatus] = useState<'connected' | 'disconnected'>('disconnected');

  useEffect(() => {
    // AppBootstrap cria o ws async; poll curto até existir.
    if (wsRef.current) {
      setReady(true);
      return;
    }
    const t = setInterval(() => {
      if (wsRef.current) {
        setReady(true);
        clearInterval(t);
      }
    }, 100);
    return () => clearInterval(t);
  }, [wsRef]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ready || !ws) return;
    const off = ws.onStatus((s) => setStatus(s === 'connected' ? 'connected' : 'disconnected'));
    return () => {
      off();
    };
  }, [ready, wsRef]);

  if (!ready || !wsRef.current) return <div className="mshell-pending">Conectando…</div>;

  return (
    <ChatView
      ws={wsRef.current}
      status={status}
      talking={false}
      onTalkStart={async () => {}}
      onTalkEnd={() => {}}
      onTalkCancel={() => {}}
      realtimeActive={false}
      onRealtimeToggle={() => {}}
      playback={null}
      manualMute={false}
      onManualMuteToggle={() => {}}
    />
  );
}
