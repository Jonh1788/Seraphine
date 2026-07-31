import { useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { Orb } from './Orb';
import { greeting, monthExpenses } from './hoje';
import { useFetchJson } from './useFetchJson';
import { listHabits } from '../habits/api';
import type { HabitWithStatus } from '../habits/types';
import { SparkleIcon, CheckIcon } from '../icons/Icons';

type Notif = { id: string; type: string; title: string; body: string };
type Task = { id: number; title: string; status?: string; due_date?: string | null };
type Open = (p: { key: string; title: string }) => void;

// Statuses that mean a task is closed and should not surface on Hoje.
const CLOSED = new Set(['completed', 'rejected', 'failed', 'discarded']);
const DISMISS_KEY = 'seraphine.mobile.sugere.dismissed';

export function HojeScreen({ onOpen }: { onOpen: Open }) {
  return (
    <div className="mhoje">
      <header className="mhoje__head">
        <Orb size={38} float halo />
        <div>
          <p className="mhoje__hi">{greeting(new Date().getHours())}</p>
          <p className="mhoje__sub">aqui está o seu dia</p>
        </div>
      </header>
      <SugereCard onOpen={onOpen} />
      <AgendaBlock onOpen={onOpen} />
      <div className="mhoje__row">
        <TarefasBlock onOpen={onOpen} />
        <HabitosBlock onOpen={onOpen} />
      </div>
      <OrcamentoBlock onOpen={onOpen} />
    </div>
  );
}

function SugereCard({ onOpen }: { onOpen: Open }) {
  const { data } = useFetchJson<{ queue: Notif[] }>(`${API_BASE}/notifications/queue`);
  const [dismissed, setDismissed] = useState<string>(() => localStorage.getItem(DISMISS_KEY) ?? '');
  const today = new Date().toISOString().slice(0, 10);
  const item = (data?.queue ?? []).find((n) => dismissed !== `${n.id}:${today}`);
  if (!item) return null;
  const later = () => { localStorage.setItem(DISMISS_KEY, `${item.id}:${today}`); setDismissed(`${item.id}:${today}`); };
  return (
    <section className="msugere">
      <span className="msugere__icon"><SparkleIcon size={18} /></span>
      <div className="msugere__text">
        <p className="msugere__title">{item.title}</p>
        {item.body && <p className="msugere__body">{item.body}</p>}
      </div>
      <div className="msugere__actions">
        <button type="button" className="msugere__go" onClick={() => onOpen(targetFor(item))}>Resolver</button>
        <button type="button" className="msugere__later" onClick={later}>Depois</button>
      </div>
    </section>
  );
}

// mapeia tipo de notificação → módulo (fallback: inbox)
function targetFor(n: Notif): { key: string; title: string } {
  const t = n.type || '';
  if (t.includes('task')) return { key: 'tarefas-view', title: 'Tarefas' };
  if (t.includes('finance') || t.includes('budget')) return { key: 'financas', title: 'Finanças' };
  if (t.includes('habit')) return { key: 'habitos', title: 'Hábitos' };
  if (t.includes('calendar') || t.includes('event')) return { key: 'calendario', title: 'Calendário' };
  return { key: 'inbox', title: 'Inbox' };
}

// Backend expõe /calendar/aggregate?start&end (day_map com events por dia);
// não existe /calendar/today — buscamos o dia de hoje e lemos days[0].events.
type AggEvent = { title: string; start?: string; end?: string };
type AggDay = { date: string; events?: AggEvent[] };

function AgendaBlock({ onOpen }: { onOpen: Open }) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = useFetchJson<{ days?: AggDay[] }>(
    `${API_BASE}/calendar/aggregate?start=${today}&end=${today}`,
  );
  const events = (data?.days?.[0]?.events ?? []).slice(0, 4);
  if (!events.length) return null;
  return (
    <section className="mshell-card mhoje-agenda" onClick={() => onOpen({ key: 'calendario', title: 'Calendário' })}>
      <p className="mshell-eyebrow">Agenda</p>
      {events.map((e, i) => (
        <div key={`${e.title}-${i}`} className="mhoje-agenda__row">
          <span className="mhoje-agenda__time">{(e.start ?? '').slice(11, 16)}</span>
          <span className="mhoje-agenda__title">{e.title}</span>
        </div>
      ))}
    </section>
  );
}

function TarefasBlock({ onOpen }: { onOpen: Open }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let ok = true;
    fetch(`${API_BASE}/tasks?limit=200`).then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((d) => { if (ok) setTasks((d.tasks ?? []).filter((t: Task) => !CLOSED.has(t.status ?? '')).slice(0, 3)); })
      .catch(() => {});
    return () => { ok = false; };
  }, []);
  if (!tasks.length) return null;
  const complete = async (id: number) => {
    setTasks((ts) => ts.filter((t) => t.id !== id));
    try {
      await fetch(`${API_BASE}/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
    } catch { /* otimista; a view completa corrige */ }
  };
  return (
    <section className="mshell-card mhoje-tarefas">
      <p className="mshell-eyebrow" onClick={() => onOpen({ key: 'tarefas-view', title: 'Tarefas' })}>Tarefas</p>
      {tasks.map((t) => (
        <label key={t.id} className="mhoje-tarefas__row">
          <button type="button" className="mhoje-tarefas__check" aria-label="Concluir" onClick={() => complete(t.id)}>
            <CheckIcon size={13} />
          </button>
          <span>{t.title}</span>
        </label>
      ))}
    </section>
  );
}

function HabitosBlock({ onOpen }: { onOpen: Open }) {
  const [habits, setHabits] = useState<HabitWithStatus[] | null>(null);
  useEffect(() => { listHabits().then(setHabits).catch(() => setHabits(null)); }, []);
  if (!habits || !habits.length) return null;
  const done = habits.filter((h) => h.today_completed).length;
  const pct = Math.round((done / habits.length) * 100);
  return (
    <section className="mshell-card mhoje-habitos" onClick={() => onOpen({ key: 'habitos', title: 'Hábitos' })}>
      <p className="mshell-eyebrow">Hábitos</p>
      <div className="mhoje-habitos__ring" style={{ background: `conic-gradient(var(--accent, #9a93ff) ${pct}%, rgba(255,255,255,.08) 0)` }}>
        <span>{done}/{habits.length}</span>
      </div>
    </section>
  );
}

function OrcamentoBlock({ onOpen }: { onOpen: Open }) {
  const { data } = useFetchJson<{ entries?: { amount: number; kind?: string; type?: string; date?: string; ts?: string }[] }>(
    `${API_BASE}/finance/entries?status=confirmed&limit=100`,
  );
  const total = monthExpenses(data?.entries ?? [], new Date());
  if (!total) return null;
  return (
    <section className="mshell-card mhoje-orcamento" onClick={() => onOpen({ key: 'financas', title: 'Finanças' })}>
      <p className="mshell-eyebrow">Gasto do mês</p>
      <p className="mhoje-orcamento__value">R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
    </section>
  );
}
