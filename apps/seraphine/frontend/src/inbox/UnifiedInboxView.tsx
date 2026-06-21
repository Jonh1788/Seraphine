import './obsidian.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';
import { CalendarIcon } from '../icons/Icons';

type InboxKind = 'task' | 'email' | 'finance' | 'insight' | 'memory' | 'work';
type InboxSource = 'whatsapp' | 'email' | 'seraphine';
type SourceFilter = 'all' | InboxSource;

interface InboxItem {
  id: string;
  kind: InboxKind;
  /** Communications source bucket. Drives the filter chip + per-row badge.
   * Bound from the real source of the row (email = Gmail, whatsapp = WhatsApp
   * webhook notification, seraphine = every other domain/notification item).
   * NOT derived from kind, because WhatsApp rows share kind 'memory'. */
  source: InboxSource;
  title: string;
  detail: string;
  urgency: 'high' | 'medium' | 'low';
  decision?: boolean;
  actionLabel: string;
  action?: () => void | Promise<void>;
  secondaryActions?: Array<{
    label: string;
    action: () => void | Promise<void>;
  }>;
  /** Epoch ms used to derive the relative timestamp; falls back to now. */
  receivedAt?: number;
}

interface UnifiedInboxViewProps {
  onBack: () => void;
  onNavigate: (view: string) => void;
}

/** Human label for the per-row source badge chip. */
function sourceBadge(item: InboxItem): string {
  if (item.source === 'email') return 'E-mail';
  if (item.source === 'whatsapp') return 'WhatsApp';
  if (item.kind === 'insight') return 'Resumo';
  return 'Lembrete';
}

/** PT-BR urgency keywords mirroring the backend WhatsApp importance heuristic
 * (whatsapp/routes.py:_is_important). The backend computes importance on the
 * webhook but only ships it over WS — it is NOT persisted in the stored
 * notification payload, so we re-derive it client-side from the same signals. */
const WHATSAPP_URGENCY_RE = /\b(?:urgente|importante|ajuda|socorro|emerg[eê]ncia|agora|preciso|por\s+favor\s+respond[ea])\b/i;

interface WhatsAppNote {
  source: 'whatsapp';
  sender: string;
  body: string;
  important: boolean;
}

/** Detect + decode a WhatsApp notification row from /memory/notifications.
 * WhatsApp rows arrive with event='whatsapp.*' and title='WhatsApp: {author}';
 * the full webhook JSON is in the `payload` string column. Returns null for
 * non-WhatsApp notifications so they fall through to the generic branch. */
function parseWhatsApp(note: {
  event?: string;
  title?: string;
  summary?: string;
  payload?: string;
}): WhatsAppNote | null {
  const isWhatsApp = (note.event?.startsWith('whatsapp') ?? false)
    || (note.title?.startsWith('WhatsApp:') ?? false);
  if (!isWhatsApp) return null;

  let chatId = '';
  let fromMe = false;
  let author = '';
  let body = note.summary || '';
  let chatName = '';
  if (typeof note.payload === 'string' && note.payload.length > 0) {
    try {
      const data = JSON.parse(note.payload) as {
        chatId?: string;
        chatName?: string;
        message?: { author?: string; body?: string; fromMe?: boolean };
      };
      chatId = data.chatId || '';
      chatName = data.chatName || '';
      author = data.message?.author || '';
      fromMe = Boolean(data.message?.fromMe);
      if (data.message?.body) body = data.message.body;
    } catch {
      // malformed payload — fall back to the title/summary below.
    }
  }
  // Prefer the parsed author/chatName; else strip the 'WhatsApp: ' title prefix.
  const sender = author || chatName || (note.title || '').replace(/^WhatsApp:\s*/, '') || 'WhatsApp';
  // Re-derive importance with the same rules as the backend heuristic.
  const isDirect = chatId.length > 0 && !chatId.endsWith('@g.us');
  const important = !fromMe && (isDirect || WHATSAPP_URGENCY_RE.test(body));
  return { source: 'whatsapp', sender, body, important };
}

function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Best-effort relative timestamp derived from receivedAt (PT-BR). */
function relativeTime(receivedAt?: number): string {
  if (!receivedAt) return 'agora';
  const diff = Date.now() - receivedAt;
  if (diff < 60_000) return 'agora';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min`;
  const sameDay = new Date(receivedAt).toDateString() === new Date().toDateString();
  if (sameDay) {
    return new Date(receivedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days <= 1) return 'ontem';
  if (days < 7) return `${days} d`;
  return new Date(receivedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function taskUrgency(task: { due_date?: string | null; priority?: string | null }): InboxItem['urgency'] {
  if (task.priority === 'high') return 'high';
  if (task.due_date && task.due_date < todayISO()) return 'high';
  if (task.due_date === todayISO()) return 'medium';
  return 'low';
}

/** Source-tinted glyph (inline svg, stroke currentColor inherited from tile color). */
function sourceIcon(source: InboxSource): JSX.Element {
  if (source === 'whatsapp') {
    return (
      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.7L3 21l1.8-5.8A8.5 8.5 0 1 1 21 11.5z" />
      </svg>
    );
  }
  if (source === 'email') {
    return (
      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    );
  }
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function UnifiedInboxView({ onBack, onNavigate }: UnifiedInboxViewProps): JSX.Element {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());

  // Esc returns to the previous view (the visible back button is gone in the
  // Obsidian layout — navigation lives in the global left rail).
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  const resolveItem = useCallback(async (
    itemId: string,
    path: string,
    init?: RequestInit,
  ): Promise<void> => {
    setActingId(itemId);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${path}`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }, []);

  const resolveAutopilot = useCallback(async (
    itemId: string,
    suggestionId: string,
    action: 'apply' | 'dismiss' | 'snooze',
  ): Promise<void> => {
    setActingId(itemId);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/work/autopilot/${encodeURIComponent(suggestionId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'snooze' ? JSON.stringify({ hours: 24 }) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const next: InboxItem[] = [];

    const settle = await Promise.allSettled([
      fetch(`${API_BASE}/tasks?limit=80`).then((r) => r.ok ? r.json() : { tasks: [] }),
      fetch(`${API_BASE}/google/gmail/important?limit=10`).then((r) => r.ok ? r.json() : []),
      fetch(`${API_BASE}/finance/entries?status=pending_review`).then((r) => r.ok ? r.json() : { entries: [] }),
      fetch(`${API_BASE}/insights`).then((r) => r.ok ? r.json() : { insights: [] }),
      fetch(`${API_BASE}/memory/notifications?limit=20`).then((r) => r.ok ? r.json() : []),
      fetch(`${API_BASE}/work/briefing`).then((r) => r.ok ? r.json() : { due_projects: [], projects: [] }),
      fetch(`${API_BASE}/work/autopilot`).then((r) => r.ok ? r.json() : { suggestions: [] }),
    ]);

    const parseTime = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1000;
      }
      if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? undefined : ms;
      }
      return undefined;
    };

    const tasks = settle[0].status === 'fulfilled' ? (settle[0].value.tasks || []) : [];
    for (const task of tasks) {
      if (task.status === 'completed' || task.status === 'rejected') continue;
      const due = task.due_date ? `vence ${task.due_date}${task.due_time ? ` as ${task.due_time}` : ''}` : 'sem prazo';
      next.push({
        id: `task-${task.id}`,
        kind: 'task',
        source: 'seraphine',
        title: task.title || 'Tarefa sem titulo',
        detail: `${due}${task.priority ? ` · ${task.priority}` : ''}`,
        urgency: taskUrgency(task),
        receivedAt: parseTime(task.created_at ?? task.updated_at),
        actionLabel: 'Concluir',
        action: () => resolveItem(`task-${task.id}`, `/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'completed' }),
        }),
      });
    }

    const emails = settle[1].status === 'fulfilled' && Array.isArray(settle[1].value) ? settle[1].value : [];
    for (const email of emails) {
      next.push({
        id: `email-${email.id}`,
        kind: 'email',
        source: 'email',
        title: email.from || email.subject || 'Email importante',
        detail: email.subject || email.snippet || 'Gmail',
        urgency: 'medium',
        receivedAt: parseTime(email.date ?? email.received_at ?? email.internal_date),
        actionLabel: 'Marcar lido',
        action: () => resolveItem(`email-${email.id}`, `/google/gmail/messages/${email.id}/mark-read`, {
          method: 'POST',
        }),
      });
    }

    const finance = settle[2].status === 'fulfilled' ? (settle[2].value.entries || []) : [];
    for (const entry of finance) {
      next.push({
        id: `finance-${entry.id}`,
        kind: 'finance',
        source: 'seraphine',
        title: entry.description || 'Lancamento pendente',
        detail: `${entry.type || 'entrada'} · R$ ${Number(entry.amount || 0).toLocaleString('pt-BR')}`,
        urgency: 'medium',
        decision: true,
        receivedAt: parseTime(entry.created_at ?? entry.date),
        actionLabel: 'Aprovar',
        action: () => resolveItem(`finance-${entry.id}`, `/finance/entries/${entry.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed' }),
        }),
      });
    }

    const insights = settle[3].status === 'fulfilled' ? (settle[3].value.insights || []) : [];
    for (const insight of insights.slice(0, 8)) {
      next.push({
        id: `insight-${insight.id}`,
        kind: 'insight',
        source: 'seraphine',
        title: insight.title || 'Insight ativo',
        detail: insight.summary || insight.description || 'Padrao detectado',
        urgency: insight.severity === 'high' ? 'high' : 'low',
        receivedAt: parseTime(insight.created_at),
        actionLabel: 'Dispensar',
        action: () => resolveItem(`insight-${insight.id}`, `/insights/${insight.id}/dismiss`, {
          method: 'POST',
        }),
      });
    }

    const notifications = settle[4].status === 'fulfilled' && Array.isArray(settle[4].value) ? settle[4].value : [];
    for (const note of notifications) {
      const wa = parseWhatsApp(note);
      if (wa) {
        // WhatsApp message: real source + sender + body live in the payload.
        next.push({
          id: `memory-${note.id}`,
          kind: 'memory',
          source: 'whatsapp',
          title: wa.sender,
          // `summary` is the real backend field (was wrongly read as `body`).
          detail: wa.body || note.summary || 'Mensagem do WhatsApp',
          urgency: wa.important ? 'high' : 'low',
          receivedAt: parseTime(note.created_at),
          actionLabel: 'Marcar lida',
          action: () => resolveItem(`memory-${note.id}`, '/memory/notifications/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [note.id] }),
          }),
        });
        continue;
      }
      next.push({
        id: `memory-${note.id}`,
        kind: 'memory',
        source: 'seraphine',
        title: note.title || note.summary || 'Notificacao',
        // Backend row shape is {title, summary, ...} — the previous read of
        // `note.body`/`note.message` never existed and always hit the fallback.
        detail: note.summary || 'Memoria',
        urgency: 'low',
        // Backend supplies `created_at` (ISO UTC); there is no `timestamp` field.
        receivedAt: parseTime(note.created_at),
        actionLabel: 'Marcar lida',
        action: () => resolveItem(`memory-${note.id}`, '/memory/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [note.id] }),
        }),
      });
    }

    const work = settle[5].status === 'fulfilled' ? settle[5].value : { due_projects: [], projects: [] };
    const workProjects = [
      ...(work.due_projects || []),
      ...(work.projects || []).filter((project: { priority?: string; id?: string }) => project.priority === 'high'),
    ];
    const seenProjects = new Set<string>();
    for (const project of workProjects) {
      if (!project?.id || seenProjects.has(project.id)) continue;
      seenProjects.add(project.id);
      next.push({
        id: `work-${project.id}`,
        kind: 'work',
        source: 'seraphine',
        title: project.name || 'Projeto de trabalho',
        detail: `${project.area || 'Trabalho'}${project.due_date ? ` · prazo ${project.due_date}` : ''}`,
        urgency: project.due_date && project.due_date < todayISO() ? 'high' : project.priority === 'high' ? 'medium' : 'low',
        decision: true,
        receivedAt: parseTime(project.updated_at ?? project.created_at),
        actionLabel: 'Abrir',
        action: () => onNavigate('trabalhos'),
      });
    }

    const autopilot = settle[6].status === 'fulfilled' ? settle[6].value : { suggestions: [] };
    for (const suggestion of (autopilot.suggestions || []).slice(0, 8)) {
      const itemId = `decision-${suggestion.id}`;
      next.push({
        id: itemId,
        kind: 'work',
        source: 'seraphine',
        title: suggestion.title || 'Decisao de trabalho',
        detail: suggestion.detail || 'Autopilot de trabalho',
        urgency: suggestion.severity === 'high' ? 'high' : suggestion.severity === 'medium' ? 'medium' : 'low',
        decision: true,
        receivedAt: parseTime(suggestion.created_at),
        actionLabel: suggestion.action_label || 'Aplicar',
        action: () => resolveAutopilot(itemId, suggestion.id, 'apply'),
        secondaryActions: [
          { label: 'Adiar', action: () => resolveAutopilot(itemId, suggestion.id, 'snooze') },
          { label: 'Dispensar', action: () => resolveAutopilot(itemId, suggestion.id, 'dismiss') },
        ],
      });
    }

    if (settle.every((r) => r.status === 'rejected')) {
      setError('Nao foi possivel carregar a inbox.');
    }
    setItems(next);
    setReadIds(new Set());
    setLoading(false);
  }, [onNavigate, resolveAutopilot, resolveItem]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(
    () => (filter === 'all'
      ? items
      : items.filter((item) => item.source === filter)),
    [filter, items],
  );

  const unreadCount = useMemo(
    () => items.filter((item) => !readIds.has(item.id)).length,
    [items, readIds],
  );

  const markAllRead = useCallback(async () => {
    // Optimistic: every visible item reads as read immediately.
    setReadIds(new Set(items.map((item) => item.id)));

    // Persist the two buckets that have a real server-side read flag.
    // - memory + WhatsApp rows -> notifications.read=1 (POST /memory/notifications/read)
    // - Gmail "important" rows -> remove UNREAD label (POST batch-mark-read)
    // Domain items (task/finance/work/insight) have no server read concept;
    // they rely on their existing resolve/dismiss actions and are skipped here.
    const notificationIds = items
      .filter((item) => item.kind === 'memory')
      .map((item) => item.id.replace(/^memory-/, ''));
    const emailIds = items
      .filter((item) => item.kind === 'email')
      .map((item) => item.id.replace(/^email-/, ''));

    const calls: Array<Promise<unknown>> = [];
    if (notificationIds.length > 0) {
      calls.push(fetch(`${API_BASE}/memory/notifications/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: notificationIds }),
      }));
    }
    if (emailIds.length > 0) {
      calls.push(fetch(`${API_BASE}/google/gmail/messages/batch-mark-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: emailIds }),
      }));
    }
    if (calls.length === 0) return;
    try {
      await Promise.allSettled(calls);
      // Re-pull so server truth (now read) removes these from the feed.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [items, refresh]);

  const openItem = useCallback((item: InboxItem) => {
    setReadIds((prev) => {
      if (prev.has(item.id)) return prev;
      const nextSet = new Set(prev);
      nextSet.add(item.id);
      return nextSet;
    });
    onNavigate(
      item.kind === 'email' ? 'chat'
        : item.kind === 'memory' ? 'memory'
        : item.kind === 'insight' ? 'insights'
        : item.kind === 'finance' ? 'finance'
        : item.kind === 'work' ? 'trabalhos'
        : 'tasks',
    );
  }, [onNavigate]);

  const sourceFilters: Array<{ key: SourceFilter; label: string; dot?: string }> = [
    { key: 'all', label: 'Tudo' },
    { key: 'email', label: 'E-mail', dot: '#42a5f5' },
    { key: 'whatsapp', label: 'WhatsApp', dot: '#25d366' },
    { key: 'seraphine', label: 'Notificações', dot: '#9a93ff' },
  ];

  return (
    <div className="inbox-view">
      <div className="inbox-view__header">
        <div className="inbox-view__titles">
          <h2 className="inbox-view__title">Inbox</h2>
          <p className="inbox-view__subtitle">{unreadCount} não lidos · tudo num lugar só</p>
        </div>
        <button
          className="inbox-view__markall"
          type="button"
          onClick={() => { void markAllRead(); }}
          disabled={loading || unreadCount === 0}
        >
          Marcar tudo como lido
        </button>
      </div>

      <div className="inbox-filter">
        {sourceFilters.map(({ key, label, dot }) => (
          <button
            key={key}
            type="button"
            className={filter === key ? 'is-active' : ''}
            onClick={() => setFilter(key)}
          >
            {dot && <span className="inbox-filter__dot" style={{ background: dot }} />}
            {label}
          </button>
        ))}
      </div>

      {error && <div className="inbox-empty">{error}</div>}
      {!error && !loading && filtered.length === 0 && (
        <div className="inbox-empty">
          <CalendarIcon size={40} />
          <strong>Nada urgente por aqui</strong>
          <p>Quando tarefas, emails, insights ou pendencias aparecerem, elas entram nessa fila.</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="inbox-list">
          {filtered.map((item) => {
            const source = item.source;
            const unread = !readIds.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`inbox-item inbox-item--${unread ? 'unread' : 'read'}`}
                onClick={() => openItem(item)}
                disabled={actingId === item.id}
              >
                <span className={`inbox-item__icon inbox-item__icon--${source}`}>
                  {sourceIcon(source)}
                </span>
                <span className="inbox-item__body">
                  <span className="inbox-item__top">
                    <span className="inbox-item__sender">{item.title}</span>
                    <span className={`inbox-item__badge inbox-item__badge--${source}`}>
                      {sourceBadge(item)}
                    </span>
                    <span className="inbox-item__time">{relativeTime(item.receivedAt)}</span>
                  </span>
                  <span className="inbox-item__preview">{item.detail}</span>
                </span>
                {unread && <span className="inbox-item__dot" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
