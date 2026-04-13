import { useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  CalendarIcon,
  ChatIcon,
  FinanceIcon,
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

interface DetectedTask {
  chatId: string;
  chatName: string;
  author: string;
  summary: string;
  urgency: 'alta' | 'media' | 'baixa';
  timestamp: number;
  suggestedActions: SuggestedAction[];
}

type ActiveView = 'chat' | 'finance' | 'calendar' | 'whatsapp';
type TabKey = 'resumo' | 'tarefas' | 'chats';

interface WhatsAppPanelProps {
  messages: WhatsAppMessage[];
  onBack: () => void;
  onNavigate: (view: ActiveView) => void;
}

/* ------------------------------------------------------------------ */
/*  Smart action detection                                             */
/* ------------------------------------------------------------------ */

function detectSuggestedActions(summary: string): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const lower = summary.toLowerCase();

  if (
    /call|reuniao|reunião|meeting|encontro|horario|horário|\d{1,2}h|\d{1,2}:\d{2}|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|amanha|amanhã/.test(
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
    /pagar|pagamento|cobrar|cobranca|cobrança|r\$|reais|transferir|pix|boleto|fatura/.test(
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

function classifyUrgency(body: string): 'alta' | 'media' | 'baixa' {
  const lower = body.toLowerCase();
  if (/urgente|asap|agora|imediato|emergencia|emergência/.test(lower)) return 'alta';
  if (/hoje|amanha|amanhã|prazo|deadline/.test(lower)) return 'media';
  return 'baixa';
}

const URGENCY_LABEL: Record<string, string> = {
  alta: 'Alta',
  media: 'Media',
  baixa: 'Baixa',
};

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

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function WhatsAppPanel({ messages, onBack, onNavigate }: WhatsAppPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>('resumo');

  // Derive tasks from important messages
  const tasks = useMemo<DetectedTask[]>(() => {
    return messages
      .filter((m) => m.important && !m.fromMe)
      .map((m) => ({
        chatId: m.chatId,
        chatName: m.chatName,
        author: m.author,
        summary: m.body,
        urgency: classifyUrgency(m.body),
        timestamp: m.timestamp,
        suggestedActions: detectSuggestedActions(m.body),
      }));
  }, [messages]);

  // Group messages by chat
  const chatGroups = useMemo(() => {
    const map = new Map<string, WhatsAppMessage[]>();
    for (const msg of messages) {
      const existing = map.get(msg.chatId) ?? [];
      existing.push(msg);
      map.set(msg.chatId, existing);
    }
    return Array.from(map.entries()).map(([chatId, msgs]) => ({
      chatId,
      chatName: msgs[0].chatName,
      messages: msgs.slice(0, 10),
      lastTimestamp: msgs[0].timestamp,
    }));
  }, [messages]);

  // Summary stats
  const todayMessages = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    return messages.filter((m) => m.timestamp >= startOfDay).length;
  }, [messages]);

  const handleAction = (action: SuggestedAction) => {
    if (action.type === 'calendar') onNavigate('calendar');
    else if (action.type === 'finance') onNavigate('finance');
    else onNavigate('chat');
  };

  const TAB_ITEMS: { key: TabKey; label: string; badge?: number }[] = [
    { key: 'resumo', label: 'Resumo' },
    { key: 'tarefas', label: 'Tarefas', badge: tasks.length || undefined },
    { key: 'chats', label: 'Chats', badge: chatGroups.length || undefined },
  ];

  return (
    <div className="wa-panel">
      {/* Header */}
      <div className="wa-panel__header">
        <button className="wa-panel__back" onClick={onBack} type="button">
          <ArrowLeftIcon size={18} />
          <span>Voltar</span>
        </button>
        <div className="wa-panel__header-center">
          <div className="wa-panel__header-icon">
            <WhatsAppIcon size={28} />
          </div>
          <h2 className="wa-panel__title">WhatsApp</h2>
          <p className="wa-panel__subtitle">Mensagens e tarefas detectadas</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="wa-panel__tabs">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`wa-panel__tab${activeTab === tab.key ? ' wa-panel__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span className="wa-tab-badge">{tab.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="wa-panel__content">
        {/* ── Resumo ── */}
        {activeTab === 'resumo' && (
          <>
            <div className="wa-summary">
              <div className="wa-summary__card">
                <span className="wa-summary__card-value">{todayMessages}</span>
                <span className="wa-summary__card-label">Mensagens hoje</span>
              </div>
              <div className="wa-summary__card">
                <span className="wa-summary__card-value">{tasks.length}</span>
                <span className="wa-summary__card-label">Tarefas pendentes</span>
              </div>
              <div className="wa-summary__card">
                <span className="wa-summary__card-value">{chatGroups.length}</span>
                <span className="wa-summary__card-label">Chats ativos</span>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="wa-empty">
                <div className="wa-empty__icon">
                  <WhatsAppIcon size={48} />
                </div>
                <strong>Nenhuma mensagem ainda</strong>
                <p>Quando mensagens do WhatsApp chegarem, elas aparecerao aqui.</p>
              </div>
            ) : (
              <div className="wa-chat-groups">
                {chatGroups.map((group) => (
                  <div key={group.chatId} className="wa-chat-group">
                    <div className="wa-chat-group__name">{group.chatName}</div>
                    {group.messages.slice(0, 5).map((msg, i) => (
                      <div key={`${msg.chatId}-${msg.timestamp}-${i}`} className="wa-msg">
                        <span className="wa-msg__author">{msg.author || msg.chatName}</span>
                        <span className="wa-msg__body">{msg.body}</span>
                        <span className="wa-msg__time">{fmtTime(msg.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Tarefas ── */}
        {activeTab === 'tarefas' && (
          <>
            {tasks.length === 0 ? (
              <div className="wa-empty">
                <div className="wa-empty__icon">
                  <WhatsAppIcon size={48} />
                </div>
                <strong>Nenhuma tarefa detectada</strong>
                <p>Mensagens importantes do WhatsApp com horarios, pagamentos ou compromissos apareceriam aqui.</p>
              </div>
            ) : (
              <div className="wa-tasks">
                {tasks.map((task, i) => (
                  <div key={`${task.chatId}-${task.timestamp}-${i}`} className="wa-task">
                    <div className="wa-task__header">
                      <div>
                        <span className="wa-task__author">{task.author}</span>
                        <span className="wa-task__chat"> em {task.chatName}</span>
                      </div>
                      <span className={`wa-task__urgency wa-task__urgency--${task.urgency}`}>
                        {URGENCY_LABEL[task.urgency]}
                      </span>
                    </div>
                    <div className="wa-task__summary">{task.summary}</div>
                    <div className="wa-task__meta">
                      <span className="wa-task__time">{fmtTime(task.timestamp)}</span>
                    </div>
                    <div className="wa-task__actions">
                      {task.suggestedActions.map((action) => (
                        <button
                          key={action.type}
                          type="button"
                          className={`wa-task__action-btn wa-task__action-btn--${action.type}`}
                          onClick={() => handleAction(action)}
                        >
                          {action.icon}
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Chats ── */}
        {activeTab === 'chats' && (
          <>
            {chatGroups.length === 0 ? (
              <div className="wa-empty">
                <div className="wa-empty__icon">
                  <WhatsAppIcon size={48} />
                </div>
                <strong>Nenhum chat ativo</strong>
                <p>Mensagens recebidas aparecerao organizadas por conversa.</p>
              </div>
            ) : (
              <div className="wa-chats-list">
                {chatGroups.map((group) => (
                  <div key={group.chatId} className="wa-chat-item">
                    <div className="wa-chat-item__avatar">
                      {(group.chatName || '?')[0].toUpperCase()}
                    </div>
                    <div className="wa-chat-item__info">
                      <div className="wa-chat-item__name">{group.chatName}</div>
                      <div className="wa-chat-item__preview">
                        {group.messages[0]?.body.slice(0, 80) || '...'}
                      </div>
                    </div>
                    <div className="wa-chat-item__meta">
                      <span className="wa-chat-item__time">
                        {fmtTime(group.lastTimestamp)}
                      </span>
                      <span className="wa-chat-item__count">{group.messages.length}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
