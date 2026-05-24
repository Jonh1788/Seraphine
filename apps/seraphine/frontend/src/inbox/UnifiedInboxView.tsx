import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';
import {
  ArrowLeftIcon,
  BrainIcon,
  CalendarIcon,
  FinanceIcon,
  InboxIcon,
  LightbulbIcon,
  RefreshIcon,
  TasksIcon,
} from '../icons/Icons';

type InboxKind = 'task' | 'email' | 'finance' | 'insight' | 'memory';

interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  detail: string;
  urgency: 'high' | 'medium' | 'low';
  actionLabel: string;
  action?: () => void | Promise<void>;
}

interface UnifiedInboxViewProps {
  onBack: () => void;
  onNavigate: (view: string) => void;
}

function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function taskUrgency(task: { due_date?: string | null; priority?: string | null }): InboxItem['urgency'] {
  if (task.priority === 'high') return 'high';
  if (task.due_date && task.due_date < todayISO()) return 'high';
  if (task.due_date === todayISO()) return 'medium';
  return 'low';
}

function iconFor(kind: InboxKind): JSX.Element {
  switch (kind) {
    case 'task': return <TasksIcon size={18} />;
    case 'email': return <InboxIcon size={18} />;
    case 'finance': return <FinanceIcon size={18} />;
    case 'insight': return <LightbulbIcon size={18} />;
    case 'memory': return <BrainIcon size={18} />;
  }
}

export function UnifiedInboxView({ onBack, onNavigate }: UnifiedInboxViewProps): JSX.Element {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | InboxKind>('all');

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
    ]);

    const tasks = settle[0].status === 'fulfilled' ? (settle[0].value.tasks || []) : [];
    for (const task of tasks) {
      if (task.status === 'completed' || task.status === 'rejected') continue;
      const due = task.due_date ? `vence ${task.due_date}${task.due_time ? ` as ${task.due_time}` : ''}` : 'sem prazo';
      next.push({
        id: `task-${task.id}`,
        kind: 'task',
        title: task.title || 'Tarefa sem titulo',
        detail: `${due}${task.priority ? ` · ${task.priority}` : ''}`,
        urgency: taskUrgency(task),
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
        title: email.subject || 'Email importante',
        detail: email.from || email.snippet || 'Gmail',
        urgency: 'medium',
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
        title: entry.description || 'Lancamento pendente',
        detail: `${entry.type || 'entrada'} · R$ ${Number(entry.amount || 0).toLocaleString('pt-BR')}`,
        urgency: 'medium',
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
        title: insight.title || 'Insight ativo',
        detail: insight.summary || insight.description || 'Padrao detectado',
        urgency: insight.severity === 'high' ? 'high' : 'low',
        actionLabel: 'Dispensar',
        action: () => resolveItem(`insight-${insight.id}`, `/insights/${insight.id}/dismiss`, {
          method: 'POST',
        }),
      });
    }

    const notifications = settle[4].status === 'fulfilled' && Array.isArray(settle[4].value) ? settle[4].value : [];
    for (const note of notifications) {
      next.push({
        id: `memory-${note.id}`,
        kind: 'memory',
        title: note.title || note.summary || 'Notificacao',
        detail: note.body || note.message || 'Memoria',
        urgency: 'low',
        actionLabel: 'Marcar lida',
        action: () => resolveItem(`memory-${note.id}`, '/memory/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [note.id] }),
        }),
      });
    }

    if (settle.every((r) => r.status === 'rejected')) {
      setError('Nao foi possivel carregar a inbox.');
    }
    setItems(next);
    setLoading(false);
  }, [resolveItem]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(
    () => filter === 'all' ? items : items.filter((item) => item.kind === filter),
    [filter, items],
  );

  const counts = useMemo(() => ({
    all: items.length,
    task: items.filter((i) => i.kind === 'task').length,
    email: items.filter((i) => i.kind === 'email').length,
    finance: items.filter((i) => i.kind === 'finance').length,
    insight: items.filter((i) => i.kind === 'insight').length,
    memory: items.filter((i) => i.kind === 'memory').length,
  }), [items]);

  return (
    <div className="inbox-view">
      <div className="inbox-view__header">
        <button className="inbox-view__back" type="button" onClick={onBack}>
          <ArrowLeftIcon size={18} />
          <span>Voltar</span>
        </button>
        <div className="inbox-view__title-wrap">
          <div className="inbox-view__icon"><InboxIcon size={22} /></div>
          <div>
            <h2 className="inbox-view__title">Inbox</h2>
            <p className="inbox-view__subtitle">{items.length} itens pedindo atencao</p>
          </div>
        </div>
        <button className="inbox-view__refresh" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshIcon size={16} />
          <span>{loading ? 'Atualizando' : 'Atualizar'}</span>
        </button>
      </div>

      <div className="inbox-filter">
        {(['all', 'task', 'email', 'finance', 'insight', 'memory'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={filter === key ? 'is-active' : ''}
            onClick={() => setFilter(key)}
          >
            {key === 'all' ? 'Tudo' : key}
            <span>{counts[key]}</span>
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

      <div className="inbox-list">
        {filtered.map((item) => (
          <div key={item.id} className={`inbox-item inbox-item--${item.urgency}`}>
            <div className={`inbox-item__icon inbox-item__icon--${item.kind}`}>
              {iconFor(item.kind)}
            </div>
            <div className="inbox-item__body">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
            <div className="inbox-item__actions">
              <button
                type="button"
                onClick={() => void item.action?.()}
                disabled={actingId === item.id}
              >
                {actingId === item.id ? '...' : item.actionLabel}
              </button>
              <button type="button" onClick={() => onNavigate(item.kind === 'email' ? 'chat' : item.kind === 'memory' ? 'memory' : item.kind === 'insight' ? 'insights' : item.kind === 'finance' ? 'finance' : 'tasks')}>
                Abrir
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
