import { useEffect, useRef, useState } from 'react';
import { SeraphineWS } from './ws/client';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';

export function App(): JSX.Element {
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const wsRef = useRef<SeraphineWS | null>(null);

  useEffect(() => {
    const ws = new SeraphineWS();
    wsRef.current = ws;
    const off = ws.onStatus((s) => setStatus(s));
    ws.connect();
    return () => {
      off();
      ws.close();
      wsRef.current = null;
    };
  }, []);

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        display: 'grid',
        gridTemplateColumns: '420px 1fr',
        gap: '2rem',
        maxWidth: 1200,
        margin: '0 auto',
      }}
    >
      <aside>
        <h1 style={{ marginTop: 0 }}>Seraphine</h1>
        <p>
          Status:{' '}
          <strong style={{ color: status === 'connected' ? 'green' : 'crimson' }}>
            {status}
          </strong>
        </p>
        <VrmAvatar avatarUrl="/avatars/seraphine.vrm" />
      </aside>
      <section>{wsRef.current && <ChatView ws={wsRef.current} status={status} />}</section>
    </main>
  );
}
