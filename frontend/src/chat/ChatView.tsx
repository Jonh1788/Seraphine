import { useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

interface ChatViewProps {
  ws: SeraphineWS;
  status: 'connected' | 'disconnected';
  /** If true, every user_message is sent with speak=true so the backend
   *  also synthesizes the assistant reply via the TTS adapter. */
  speak?: boolean;
}

export function ChatView({ ws, status, speak = false }: ChatViewProps): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const conversationIdRef = useRef<string | undefined>(undefined);
  const streamingTurnIdRef = useRef<string | null>(null);

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type === 'token') {
        if (!conversationIdRef.current) conversationIdRef.current = msg.conversation_id;
        const turnId = msg.turn_id;
        streamingTurnIdRef.current = turnId;
        setTurns((prev) => {
          const idx = prev.findIndex((t) => t.id === turnId);
          if (idx === -1) {
            return [
              ...prev,
              { id: turnId, role: 'assistant', content: msg.text, streaming: true },
            ];
          }
          const next = prev.slice();
          next[idx] = { ...next[idx], content: next[idx].content + msg.text };
          return next;
        });
      } else if (msg.type === 'turn_end') {
        const turnId = msg.turn_id;
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)),
        );
        streamingTurnIdRef.current = null;
      } else if (msg.type === 'error') {
        setTurns((prev) => [
          ...prev.filter((t) => !t.streaming),
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: `[error: ${msg.code}] ${msg.message}`,
          },
        ]);
        streamingTurnIdRef.current = null;
      }
    });
  }, [ws]);

  const isStreaming = streamingTurnIdRef.current !== null;
  const canSend = status === 'connected' && !isStreaming && draft.trim().length > 0;

  const send = (): void => {
    if (!canSend) return;
    const content = draft.trim();
    setTurns((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content },
    ]);
    ws.send({
      type: 'user_message',
      conversation_id: conversationIdRef.current,
      content,
      speak,
    });
    setDraft('');
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div
        style={{
          minHeight: 240,
          maxHeight: 480,
          overflowY: 'auto',
          background: '#fafafa',
          border: '1px solid #ddd',
          padding: '0.75rem',
          borderRadius: 6,
        }}
      >
        {turns.length === 0 && <em style={{ color: '#888' }}>Comece a conversa…</em>}
        {turns.map((t) => (
          <div key={t.id} style={{ marginBottom: '0.5rem' }}>
            <strong>{t.role === 'user' ? 'Você' : 'Seraphine'}:</strong>{' '}
            <span>{t.content}</span>
            {t.streaming && <span style={{ color: '#888' }}> ▍</span>}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder={status === 'connected' ? 'Digite e Enter…' : 'Desconectado'}
          disabled={status !== 'connected'}
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button onClick={send} disabled={!canSend}>
          Enviar
        </button>
      </div>
    </section>
  );
}
