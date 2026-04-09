import { useEffect, useRef, useState } from 'react';
import { SeraphineWS } from './ws/client';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';
import { MicCapture, PCMPlayback } from './audio';

export function App(): JSX.Element {
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const wsRef = useRef<SeraphineWS | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playbackRef = useRef<PCMPlayback | null>(null);
  const chunkOffRef = useRef<(() => void) | null>(null);
  const msgOffRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const ws = new SeraphineWS();
    wsRef.current = ws;
    const off = ws.onStatus((s) => setStatus(s));
    ws.connect();
    return () => {
      off();
      chunkOffRef.current?.();
      msgOffRef.current?.();
      micRef.current?.stop();
      playbackRef.current?.dispose();
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const handleTalkStart = async (): Promise<void> => {
    const ws = wsRef.current;
    if (!ws || status !== 'connected') return;
    if (!playbackRef.current) playbackRef.current = new PCMPlayback();
    if (!micRef.current) micRef.current = new MicCapture();

    msgOffRef.current?.();
    msgOffRef.current = ws.onMessage((msg) => {
      if (msg instanceof ArrayBuffer) {
        playbackRef.current?.pushChunk(msg);
        return;
      }
      if ((msg as { type?: string }).type === 'tts_end') {
        void playbackRef.current?.flush();
      }
    });

    ws.send({ type: 'audio_start', sample_rate: 16000 });
    await micRef.current.start();
    chunkOffRef.current = micRef.current.onChunk((pcm) => {
      const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      ws.sendBinary(slice);
    });
  };

  const handleTalkEnd = (): void => {
    const ws = wsRef.current;
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    if (ws && status === 'connected') {
      ws.send({ type: 'audio_end' });
    }
  };

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
        <button
          type="button"
          disabled={status !== 'connected'}
          onMouseDown={() => {
            void handleTalkStart();
          }}
          onMouseUp={handleTalkEnd}
          onMouseLeave={handleTalkEnd}
          onTouchStart={() => {
            void handleTalkStart();
          }}
          onTouchEnd={handleTalkEnd}
          style={{ marginTop: '1rem', padding: '0.75rem 1.25rem' }}
        >
          Falar (segure)
        </button>
      </aside>
      <section>{wsRef.current && <ChatView ws={wsRef.current} status={status} />}</section>
    </main>
  );
}
