import { useEffect, useRef, useState } from 'react';
import { SeraphineWS } from './ws/client';
import type { ServerMessage } from './ws/types';

export function App(): JSX.Element {
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const [lastMessage, setLastMessage] = useState<string>('');
  const wsRef = useRef<SeraphineWS | null>(null);

  useEffect(() => {
    const ws = new SeraphineWS();
    wsRef.current = ws;

    ws.onStatus((s) => setStatus(s));
    ws.onMessage((msg: ServerMessage) => {
      setLastMessage(JSON.stringify(msg));
    });
    ws.connect();

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const sendPing = (): void => {
    wsRef.current?.send({ type: 'ping' });
  };

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640 }}>
      <h1>Seraphine</h1>
      <p>
        Status:{' '}
        <strong style={{ color: status === 'connected' ? 'green' : 'crimson' }}>{status}</strong>
      </p>
      <button onClick={sendPing} disabled={status !== 'connected'}>
        Send ping
      </button>
      {lastMessage && (
        <pre style={{ marginTop: '1rem', background: '#f5f5f5', padding: '0.75rem' }}>
          {lastMessage}
        </pre>
      )}
    </main>
  );
}
