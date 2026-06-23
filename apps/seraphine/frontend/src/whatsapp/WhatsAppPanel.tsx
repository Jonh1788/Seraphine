import './obsidian.css';
import { useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  CalendarIcon,
  ChatIcon,
  FinanceIcon,
  SearchIcon,
  SparkleIcon,
  WhatsAppIcon,
} from '../icons/Icons';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface WhatsAppMessage {
  chatId: string;
  chatName: string;
  author: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  important: boolean;
}

interface SuggestedAction {
  type: 'calendar' | 'finance' | 'reply';
  label: string;
  icon: JSX.Element;
}

type ActiveView = 'chat' | 'finance' | 'calendar' | 'whatsapp';

interface WhatsAppPanelProps {
  messages: WhatsAppMessage[];
  onBack: () => void;
  onNavigate: (view: ActiveView) => void;
}

/* ------------------------------------------------------------------ */
/*  Smart action detection (drives the lilac suggestion bar)           */
/* ------------------------------------------------------------------ */

function detectSuggestedActions(summary: string): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const lower = summary.toLowerCase();

  if (
    /call|reuniao|reunião|meeting|encontro|horario|horário|\d{1,2}\s?h|\d{1,2}:\d{2}|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|amanha|amanhã|hoje|agendar|marcar|marcamos|combinar|combinamos|que\s+horas|quando|às|as\s+\d/.test(
      lower,
    )
  ) {
    actions.push({
      type: 'calendar',
      label: 'Adicionar a Agenda',
      icon: <CalendarIcon size={14} />,
    });
  }

  if (
    /pagar|pagamento|cobrar|cobranca|cobrança|r\$|reais|transferir|transfer[êe]ncia|pix|boleto|fatura|dever|devo|conta|dinheiro|valor|grana|emprest/.test(
      lower,
    )
  ) {
    actions.push({
      type: 'finance',
      label: 'Registrar no Financeiro',
      icon: <FinanceIcon size={14} />,
    });
  }

  actions.push({
    type: 'reply',
    label: 'Responder',
    icon: <ChatIcon size={14} />,
  });

  return actions;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Per-contact deterministic gradient, keyed by chatId/name. */
const AVATAR_GRADIENTS: [string, string][] = [
  ['#f472b6', '#ec4899'],
  ['#42a5f5', '#2979ff'],
  ['#9a93ff', '#6c63d6'],
  ['#26a69a', '#00897b'],
  ['#ff7043', '#f4511e'],
];

function gradientFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const [a, b] = AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function initialsFor(name: string): string {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function WhatsAppPanel({ messages, onBack, onNavigate }: WhatsAppPanelProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Group messages by chat (most recent first), preserve original message data.
  const chatGroups = useMemo(() => {
    const map = new Map<string, WhatsAppMessage[]>();
    for (const msg of messages) {
      const existing = map.get(msg.chatId) ?? [];
      existing.push(msg);
      map.set(msg.chatId, existing);
    }
    return Array.from(map.entries())
      .map(([chatId, msgs]) => {
        const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp);
        const last = sorted[sorted.length - 1];
        const unread = sorted.filter((m) => !m.fromMe && m.important).length;
        return {
          chatId,
          chatName: sorted[0].chatName,
          messages: sorted,
          lastMessage: last,
          lastTimestamp: last.timestamp,
          unread,
        };
      })
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }, [messages]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chatGroups;
    return chatGroups.filter(
      (g) =>
        g.chatName.toLowerCase().includes(q) ||
        g.lastMessage.body.toLowerCase().includes(q),
    );
  }, [chatGroups, search]);

  // Default selected conversation = first available.
  const selectedId = activeChatId ?? chatGroups[0]?.chatId ?? null;
  const activeChat = useMemo(
    () => chatGroups.find((g) => g.chatId === selectedId) ?? null,
    [chatGroups, selectedId],
  );

  // Suggestion bar: derive smart actions from the latest incoming message.
  const suggestion = useMemo(() => {
    if (!activeChat) return null;
    const lastIncoming = [...activeChat.messages].reverse().find((m) => !m.fromMe);
    if (!lastIncoming) return null;
    // Detect over the recent INCOMING thread (last 5), not just the final
    // message — intent ("amanhã às 15h", "me manda o pix") often sits a couple
    // lines back, so single-message matching almost always fell to "Responder".
    const recentText = activeChat.messages
      .filter((m) => !m.fromMe)
      .slice(-5)
      .map((m) => m.body)
      .join('\n');
    const actions = detectSuggestedActions(recentText);
    const primary = actions.find((a) => a.type !== 'reply') ?? actions[0];
    return { primary, label: primary.label };
  }, [activeChat]);

  const handleSuggest = () => {
    if (!suggestion) return;
    if (suggestion.primary.type === 'calendar') onNavigate('calendar');
    else if (suggestion.primary.type === 'finance') onNavigate('finance');
    else onNavigate('chat');
  };

  const handleSend = () => {
    if (!draft.trim()) return;
    // No send backend on this read-only feed yet — clear the draft locally.
    setDraft('');
  };

  return (
    <div className="wa-shell">
      {/* ── Conversation list ── */}
      <aside className="wa-aside">
        <div className="wa-aside__head">
          <div className="wa-aside__top">
            <button
              className="wa-aside__back"
              onClick={onBack}
              type="button"
              aria-label="Voltar"
            >
              <ArrowLeftIcon size={18} />
            </button>
            <h2 className="wa-aside__title">WhatsApp</h2>
          </div>
          <div className="wa-search">
            <SearchIcon size={15} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar conversa…"
            />
          </div>
        </div>

        <div className="wa-list">
          {filteredGroups.length === 0 ? (
            <div className="wa-list-empty">Nenhuma conversa</div>
          ) : (
            filteredGroups.map((group) => {
              const isActive = group.chatId === selectedId;
              const unread = group.unread > 0;
              return (
                <button
                  key={group.chatId}
                  type="button"
                  className={`wa-chat-item${isActive ? ' wa-chat-item--active' : ''}`}
                  onClick={() => setActiveChatId(group.chatId)}
                >
                  <span
                    className="wa-chat-item__avatar"
                    style={{ backgroundImage: gradientFor(group.chatId || group.chatName) }}
                  >
                    {initialsFor(group.chatName)}
                  </span>
                  <span className="wa-chat-item__info">
                    <span className="wa-chat-item__top">
                      <span
                        className={`wa-chat-item__name${unread ? ' wa-chat-item__name--unread' : ''}`}
                      >
                        {group.chatName}
                      </span>
                      <span
                        className={`wa-chat-item__time${unread ? ' wa-chat-item__time--unread' : ''}`}
                      >
                        {fmtTime(group.lastTimestamp)}
                      </span>
                    </span>
                    <span className="wa-chat-item__row">
                      <span className="wa-chat-item__preview">
                        {group.lastMessage.body}
                      </span>
                      {unread && (
                        <span className="wa-chat-item__badge">{group.unread}</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Thread ── */}
      <section className="wa-thread">
        {activeChat ? (
          <>
            <div className="wa-thread__header">
              <span
                className="wa-thread__avatar"
                style={{ backgroundImage: gradientFor(activeChat.chatId || activeChat.chatName) }}
              >
                {initialsFor(activeChat.chatName)}
              </span>
              <div>
                <div className="wa-thread__name">{activeChat.chatName}</div>
                <div className="wa-thread__status">
                  <span className="wa-thread__status-dot" />
                  online
                </div>
              </div>
            </div>

            <div className="wa-thread__body">
              <div className="wa-day-pill">Hoje</div>
              {activeChat.messages.map((msg, i) => (
                <div
                  key={`${msg.chatId}-${msg.timestamp}-${i}`}
                  className={`wa-bubble ${msg.fromMe ? 'wa-bubble--out' : 'wa-bubble--in'}`}
                >
                  <div className="wa-bubble__body">{msg.body}</div>
                  <div className="wa-bubble__time">
                    {fmtClock(msg.timestamp)}
                    {msg.fromMe ? ' ✓✓' : ''}
                  </div>
                </div>
              ))}
            </div>

            {suggestion && (
              <div className="wa-suggest-wrap">
                <div className="wa-suggest">
                  <span className="wa-suggest__icon">
                    <SparkleIcon size={16} />
                  </span>
                  <span className="wa-suggest__text">
                    Seraphine sugere: <em>"{suggestion.label}"</em>
                  </span>
                  <button
                    type="button"
                    className="wa-suggest__send"
                    onClick={handleSuggest}
                  >
                    Enviar
                  </button>
                </div>
              </div>
            )}

            <div className="wa-composer">
              <div className="wa-composer__row">
                <input
                  className="wa-composer__input"
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSend();
                  }}
                  placeholder="Mensagem…"
                />
                <button
                  type="button"
                  className="wa-composer__send"
                  onClick={handleSend}
                  disabled={!draft.trim()}
                  aria-label="Enviar mensagem"
                >
                  <svg
                    width={19}
                    height={19}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="wa-empty">
            <div className="wa-empty__icon">
              <WhatsAppIcon size={32} />
            </div>
            <span className="wa-empty__title">
              {chatGroups.length === 0 ? 'Nenhuma conversa ainda' : 'Selecione uma conversa'}
            </span>
            <p className="wa-empty__text">
              {chatGroups.length === 0
                ? 'Quando mensagens do WhatsApp chegarem, elas aparecerao aqui.'
                : 'Escolha uma conversa na lista para ver as mensagens.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
