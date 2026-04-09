import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';

interface Turn {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
}

interface ChatViewProps {
  ws: SeraphineWS;
  status: 'connected' | 'disconnected';
  speak?: boolean;
}

export function ChatView({ ws, status, speak = false }: ChatViewProps): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      if (msg.type === 'token') {
        if (!conversationIdRef.current) conversationIdRef.current = msg.conversation_id;
        const turnId = msg.turn_id;
        setStreamingTurnId(turnId);
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
        setStreamingTurnId(null);
      } else if (msg.type === 'error') {
        setTurns((prev) => [
          ...prev.filter((t) => !t.streaming),
          {
            id: `err-${Date.now()}`,
            role: 'error',
            content: `${msg.code}: ${msg.message}`,
          },
        ]);
        setStreamingTurnId(null);
      }
    });
  }, [ws]);

  // Auto-scroll to bottom whenever turns change.
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const isStreaming = streamingTurnId !== null;
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
    <>
      <div ref={messagesRef} className="chat__messages">
        {turns.length === 0 && (
          <div className="chat__empty">
            <strong>Comece a conversa</strong>
            Digite uma mensagem ou segure o botão pra falar.
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`bubble bubble--${t.role}`}>
            <div className="bubble__avatar">
              {t.role === 'user' ? 'V' : t.role === 'assistant' ? 'S' : '!'}
            </div>
            <div className="bubble__body">
              <div className="bubble__name">
                {t.role === 'user' ? 'Você' : t.role === 'assistant' ? 'Seraphine' : 'Erro'}
              </div>
              <div className="bubble__content">
                {t.content}
                {t.streaming && <span className="cursor" />}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="chat__composer">
        <input
          type="text"
          className="chat__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder={
            status === 'connected'
              ? isStreaming
                ? 'Aguarde a resposta…'
                : 'Digite e Enter…'
              : 'Desconectado'
          }
          disabled={status !== 'connected' || isStreaming}
        />
        <button type="button" className="btn btn-primary" onClick={send} disabled={!canSend}>
          Enviar
        </button>
      </div>
    </>
  );
}
