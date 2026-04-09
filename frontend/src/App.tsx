import { useEffect, useRef, useState } from 'react';
import { SeraphineWS } from './ws/client';
import { ChatView } from './chat/ChatView';

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
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720, margin: '0 auto' }}>
      <h1>Seraphine</h1>
      <p>
        Status:{' '}
        <strong style={{ color: status === 'connected' ? 'green' : 'crimson' }}>{status}</strong>
      </p>
      {wsRef.current && <ChatView ws={wsRef.current} status={status} />}
    </main>
  );
}
