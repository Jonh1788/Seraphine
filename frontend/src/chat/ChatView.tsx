import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { SeraphineWS } from '../ws/client';
import type { McpApprovalRequestMessage, ServerMessage } from '../ws/types';

interface McpApproval {
  taskId: string;
  title: string;
  body: string;
  plan: string;
}

interface Turn {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
  /** If set, this turn is an inline MCP task approval request. */
  mcpApproval?: McpApproval;
}

/**
 * Parse assistant content that may contain `<think>…</think>` blocks.
 * Returns { thinking: string | null; response: string; thinkingDone: boolean }.
 */
function parseThinking(raw: string): {
  thinking: string | null;
  response: string;
  thinkingDone: boolean;
} {
  const openTag = '<think>';
  const closeTag = '</think>';
  const openIdx = raw.indexOf(openTag);
  if (openIdx === -1) return { thinking: null, response: raw, thinkingDone: false };

  const afterOpen = openIdx + openTag.length;
  const closeIdx = raw.indexOf(closeTag, afterOpen);

  if (closeIdx === -1) {
    // Still inside thinking — everything after <think> is thinking content
    return {
      thinking: raw.slice(afterOpen),
      response: '',
      thinkingDone: false,
    };
  }

  // Thinking is complete
  return {
    thinking: raw.slice(afterOpen, closeIdx),
    response: raw.slice(closeIdx + closeTag.length),
    thinkingDone: true,
  };
}

/** Collapsible thinking block shown inside assistant bubbles. */
function ThinkingBlock({
  thinking,
  done,
  streaming,
}: {
  thinking: string;
  done: boolean;
  streaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse when thinking finishes
  const prevDone = useRef(done);
  useEffect(() => {
    if (done && !prevDone.current) setCollapsed(true);
    prevDone.current = done;
  }, [done]);

  return (
    <div className={`thinking-block${done ? ' thinking-block--done' : ''}`}>
      <button
        type="button"
        className="thinking-block__header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`thinking-block__arrow${collapsed ? '' : ' thinking-block__arrow--open'}`}>
          {'\u25B6'}
        </span>
        <span>Pensando...</span>
        {!done && streaming && <span className="thinking-indicator"><span /><span /><span /></span>}
      </button>
      <div
        className={`thinking-block__content${collapsed ? ' thinking-block__content--collapsed' : ''}`}
      >
        {thinking}
      </div>
    </div>
  );
}

/** Inline MCP approval request rendered inside an assistant bubble. */
function McpApprovalBlock({
  approval,
  resolved,
  onRespond,
}: {
  approval: McpApproval;
  resolved: 'approved' | 'rejected' | null;
  onRespond: (approved: boolean) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails = !!(approval.body || approval.plan);

  return (
    <div className="mcp-approval">
      <div className="mcp-approval__title">{approval.title}</div>
      {hasDetails && (
        <button
          type="button"
          className="mcp-approval__toggle"
          onClick={() => setDetailsOpen((v) => !v)}
        >
          <span className={`mcp-approval__arrow${detailsOpen ? ' mcp-approval__arrow--open' : ''}`}>
            {'\u25B6'}
          </span>
          Detalhes
        </button>
      )}
      {hasDetails && detailsOpen && (
        <div className="mcp-approval__details">
          {approval.body && <p>{approval.body}</p>}
          {approval.plan && (
            <pre className="mcp-approval__plan">{approval.plan}</pre>
          )}
        </div>
      )}
      {resolved === null ? (
        <div className="mcp-approval__buttons">
          <button
            type="button"
            className="btn mcp-approval__btn-approve"
            onClick={() => onRespond(true)}
          >
            Aprovar
          </button>
          <button
            type="button"
            className="btn mcp-approval__btn-reject"
            onClick={() => onRespond(false)}
          >
            Rejeitar
          </button>
        </div>
      ) : (
        <div className={`mcp-approval__resolved mcp-approval__resolved--${resolved}`}>
          {resolved === 'approved' ? 'Aprovado' : 'Rejeitado'}
        </div>
      )}
    </div>
  );
}

interface ChatViewProps {
  ws: SeraphineWS;
  status: 'connected' | 'disconnected';
  speak?: boolean;
  think?: boolean;
  talking: boolean;
  onTalkStart: () => Promise<void>;
  onTalkEnd: () => void;
  onTalkCancel: () => void;
}

/** Threshold (px) the user must drag upward to lock recording */
const LOCK_DRAG_THRESHOLD = 60;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ChatView({
  ws,
  status,
  speak = false,
  think = false,
  talking,
  onTalkStart,
  onTalkEnd,
  onTalkCancel,
}: ChatViewProps): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  /** Track MCP approval decisions: taskId -> 'approved' | 'rejected' */
  const [mcpDecisions, setMcpDecisions] = useState<Map<string, 'approved' | 'rejected'>>(new Map());
  const CONV_KEY = 'seraphine_conversation_id';
  const conversationIdRef = useRef<string | undefined>(
    localStorage.getItem(CONV_KEY) || undefined
  );
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // Restore chat history from backend on mount
  useEffect(() => {
    const convId = conversationIdRef.current;
    if (!convId) return;
    fetch(`/conversations/${convId}/turns`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: Array<{ id: string; role: string; content: string }>) => {
        if (data.length > 0) {
          setTurns(data.map((t) => ({
            id: t.id,
            role: t.role as 'user' | 'assistant',
            content: t.content,
          })));
        }
      })
      .catch(() => {});
  }, []);

  // Recording UI state
  const [locked, setLocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startYRef = useRef(0);
  const didLockRef = useRef(false);

  // Start elapsed timer when recording begins, clear when it stops
  useEffect(() => {
    if (talking) {
      setElapsed(0);
      elapsedRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      if (elapsedRef.current) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
      setLocked(false);
      didLockRef.current = false;
    }
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [talking]);

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      if (msg.type === 'token') {
        if (!conversationIdRef.current) {
          conversationIdRef.current = msg.conversation_id;
          localStorage.setItem(CONV_KEY, msg.conversation_id);
        }
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
      } else if (msg.type === 'mcp_approval_request') {
        const req = msg as McpApprovalRequestMessage;
        const approvalData: McpApproval = {
          taskId: req.task_id,
          title: req.title,
          body: req.body,
          plan: req.plan,
        };
        setTurns((prev) => {
          // Try to attach to the most recent assistant turn (the notification message)
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'assistant' && !prev[i].mcpApproval) {
              const next = prev.slice();
              next[i] = { ...next[i], mcpApproval: approvalData };
              return next;
            }
          }
          // Fallback: create a standalone approval turn
          return [
            ...prev,
            {
              id: `mcp-approval-${req.task_id}`,
              role: 'assistant',
              content: `Task "${req.title}" aguardando aprovacao.`,
              mcpApproval: approvalData,
            },
          ];
        });
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
      think,
    });
    setDraft('');
  };

  const handleMcpApproval = useCallback(
    (taskId: string, approved: boolean) => {
      ws.send({
        type: 'mcp_approval_response',
        task_id: taskId,
        approved,
      });
      setMcpDecisions((prev) => {
        const next = new Map(prev);
        next.set(taskId, approved ? 'approved' : 'rejected');
        return next;
      });
    },
    [ws],
  );

  // --- Mic button press & drag handlers ---

  const handleMicPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (status !== 'connected' || talking) return;
      // setPointerCapture tracks move/up even if finger moves off button
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      startYRef.current = e.clientY;
      didLockRef.current = false;
      // Call onTalkStart synchronously from the gesture handler —
      // getUserMedia requires a direct user-gesture call chain on mobile.
      void onTalkStart();
    },
    [status, talking, onTalkStart],
  );

  const handleMicPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!talking || locked || didLockRef.current) return;
      const deltaY = startYRef.current - e.clientY;
      if (deltaY > LOCK_DRAG_THRESHOLD) {
        didLockRef.current = true;
        setLocked(true);
      }
    },
    [talking, locked],
  );

  const handleMicPointerUp = useCallback(() => {
    if (!talking) return;
    if (didLockRef.current || locked) {
      // Already locked -- don't stop, user will use stop/cancel buttons
      return;
    }
    // Normal release: send
    onTalkEnd();
  }, [talking, locked, onTalkEnd]);

  const handleLockedSend = useCallback(() => {
    onTalkEnd();
  }, [onTalkEnd]);

  const handleLockedCancel = useCallback(() => {
    onTalkCancel();
  }, [onTalkCancel]);

  const connected = status === 'connected';

  const handleNewConversation = () => {
    localStorage.removeItem(CONV_KEY);
    conversationIdRef.current = undefined;
    setTurns([]);
    setStreamingTurnId(null);
    setMcpDecisions(new Map());
  };

  return (
    <>
      {turns.length > 0 && (
        <div className="chat__toolbar">
          <button type="button" className="btn-new-chat" onClick={handleNewConversation}>
            Nova conversa
          </button>
        </div>
      )}
      <div ref={messagesRef} className="chat__messages">
        {turns.length === 0 && (
          <div className="chat__empty">
            <strong>Comece a conversa</strong>
            Digite uma mensagem ou segure o microfone pra falar.
          </div>
        )}
        {turns.map((t) => {
          const parsed =
            t.role === 'assistant' ? parseThinking(t.content) : null;

          return (
            <div key={t.id} className={`bubble bubble--${t.role}`}>
              <div className="bubble__avatar">
                {t.role === 'user' ? 'V' : t.role === 'assistant' ? 'S' : '!'}
              </div>
              <div className="bubble__body">
                <div className="bubble__name">
                  {t.role === 'user' ? 'Voce' : t.role === 'assistant' ? 'Seraphine' : 'Erro'}
                </div>
                <div className="bubble__content">
                  {parsed && parsed.thinking !== null && (
                    <ThinkingBlock
                      thinking={parsed.thinking}
                      done={parsed.thinkingDone}
                      streaming={!!t.streaming}
                    />
                  )}
                  {t.role === 'assistant' ? (
                    <Markdown>{parsed ? parsed.response : t.content}</Markdown>
                  ) : (
                    parsed ? parsed.response : t.content
                  )}
                  {t.streaming && <span className="cursor" />}
                  {t.mcpApproval && (
                    <McpApprovalBlock
                      approval={t.mcpApproval}
                      resolved={mcpDecisions.get(t.mcpApproval.taskId) ?? null}
                      onRespond={(approved) => handleMcpApproval(t.mcpApproval!.taskId, approved)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recording indicator bar -- shown above composer while recording */}
      {talking && (
        <div className={`rec-bar${locked ? ' rec-bar--locked' : ''}`}>
          <span className="rec-bar__dot" />
          <span className="rec-bar__time">{formatElapsed(elapsed)}</span>
          {locked ? (
            <span className="rec-bar__hint">Gravacao travada</span>
          ) : (
            <>
              <span className="rec-bar__waveform">
                <span /><span /><span /><span /><span />
              </span>
              <span className="rec-bar__hint">Deslize pra cima pra travar</span>
            </>
          )}
        </div>
      )}

      <div className="chat__composer">
        {talking ? (
          /* While recording, replace the input with recording controls */
          locked ? (
            <div className="rec-locked-controls">
              <button
                type="button"
                className="btn rec-locked-controls__cancel"
                onClick={handleLockedCancel}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn rec-locked-controls__send"
                onClick={handleLockedSend}
              >
                Enviar
              </button>
            </div>
          ) : (
            <div className="rec-hold-hint">
              Solte pra enviar
            </div>
          )
        ) : (
          /* Normal text input */
          <>
            <input
              type="text"
              className="chat__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              placeholder={
                connected
                  ? isStreaming
                    ? 'Aguarde a resposta...'
                    : 'Digite e Enter...'
                  : 'Desconectado'
              }
              disabled={!connected || isStreaming}
            />
            <button type="button" className="btn btn-primary" onClick={send} disabled={!canSend}>
              Enviar
            </button>
          </>
        )}

        {/* Mic button -- always visible in composer */}
        <button
          type="button"
          className={`btn-mic${talking ? ' btn-mic--active' : ''}`}
          disabled={!connected}
          onPointerDown={handleMicPointerDown}
          onPointerMove={handleMicPointerMove}
          onPointerUp={handleMicPointerUp}
          onTouchStart={(e) => {
            // Prevent text selection on long-press without blocking getUserMedia
            e.stopPropagation();
          }}
          onContextMenu={(e) => e.preventDefault()}
          title="Segure para gravar (ou Space)"
        >
          {/* SVG mic icon */}
          <svg
            className="btn-mic__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="1" width="6" height="13" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="17" x2="12" y2="21" />
            <line x1="8" y1="21" x2="16" y2="21" />
          </svg>
        </button>
      </div>
    </>
  );
}
