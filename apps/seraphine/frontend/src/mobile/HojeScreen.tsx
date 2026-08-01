import { useEffect, useState, type ReactNode } from 'react';
import { API_BASE } from '../api';
import { Orb } from './Orb';
import { greeting, monthExpenses } from './hoje';
import { useFetchJson } from './useFetchJson';
import { listHabits } from '../habits/api';
import type { HabitWithStatus } from '../habits/types';
import { SparkleIcon, CheckIcon, PlanningIcon } from '../icons/Icons';
import './screens/Hoje.css';

type Notif = { id: string; type: string; title: string; body: string };
type Task = { id: number; title: string; status?: string; due_date?: string | null };
type Open = (p: { key: string; title: string }) => void;

// Statuses that mean a task is closed and should not surface on Hoje.
const CLOSED = new Set(['completed', 'rejected', 'failed', 'discarded']);
const DISMISS_KEY = 'seraphine.mobile.sugere.dismissed';

// REGRA DA TELA: nenhum bloco devolve `null`. Todo bloco tem três saídas —
// dado, vazio desenhado e erro — porque foi exatamente o `return null` que fez
// o Hoje aparecer "só com hábitos": o dia sem eventos e a falha de rede
// terminavam no mesmo lugar, um cartão que não existe.
//
// Cada bloco erra com a SUA frase, e não com um texto genérico repetido cinco
// vezes: além de ler melhor, é o que permite ao teste apontar para um bloco só.
export function HojeScreen({ onOpen }: { onOpen: Open }) {
  return (
    <div className="mhoje">
      <header className="mhoje__head">
        <Orb size={38} float halo />
        <div>
          <p className="mhoje__hi">{greeting(new Date().getHours())}</p>
          <p className="mhoje__sub">aqui está o seu dia</p>
        </div>
        {/* A única porta do Planejamento, e ela fica aqui porque é a MESMA
            matéria do cabeçalho: o Hoje diz "aqui está o seu dia" e mostra o
            dia que já existe; o Planejamento ("Seu dia") é onde ele se monta.
            Nos blocos abaixo o botão brigaria com o toque do cartão, que já
            abre o módulo inteiro. */}
        <button
          type="button"
          className="mhoje__planejar"
          onClick={() => onOpen({ key: 'planejamento', title: 'Seu dia' })}
        >
          <PlanningIcon size={15} />
          Planejar
        </button>
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

/** Linha de "não há nada" — o cartão continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-hoje-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-hoje-erro" role="alert">{children}</p>;
}

/** Espera sem texto: barras cinzentas no lugar do conteúdo que vem. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-hoje-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SugereCard({ onOpen }: { onOpen: Open }) {
  const { data, error, loading } = useFetchJson<{ queue: Notif[] }>(`${API_BASE}/notifications/queue`);
  const [dismissed, setDismissed] = useState<string>(() => localStorage.getItem(DISMISS_KEY) ?? '');
  const today = new Date().toISOString().slice(0, 10);
  const item = (data?.queue ?? []).find((n) => dismissed !== `${n.id}:${today}`);

  if (loading || error || !item) {
    return (
      <section className="msugere msugere--quiet">
        <span className="msugere__icon"><SparkleIcon size={18} /></span>
        <div className="msugere__text">
          {loading ? <Skel linhas={1} />
            : error ? <Erro>Não consegui buscar as sugestões.</Erro>
            : <Vazio>Nada urgente agora — eu te aviso se surgir algo.</Vazio>}
        </div>
      </section>
    );
  }

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
  const { data, error, loading } = useFetchJson<{ days?: AggDay[] }>(
    `${API_BASE}/calendar/aggregate?start=${today}&end=${today}`,
  );
  const events = (data?.days?.[0]?.events ?? []).slice(0, 4);
  return (
    <section className="mshell-card mhoje-agenda" onClick={() => onOpen({ key: 'calendario', title: 'Calendário' })}>
      <p className="mshell-eyebrow">Agenda</p>
      {loading ? <Skel />
        : error ? <Erro>Não consegui carregar a agenda.</Erro>
        : events.length ? events.map((e, i) => (
          <div key={`${e.title}-${i}`} className="mhoje-agenda__row">
            <span className="mhoje-agenda__time">{(e.start ?? '').slice(11, 16)}</span>
            <span className="mhoje-agenda__title">{e.title}</span>
          </div>
        ))
        : <Vazio>Nada na agenda hoje.</Vazio>}
    </section>
  );
}

function TarefasBlock({ onOpen }: { onOpen: Open }) {
  const { data, error, loading } = useFetchJson<{ tasks?: Task[] }>(`${API_BASE}/tasks?limit=200`);
  // /tasks devolve TODO status: o corte de abertas é nosso. A marcação otimista
  // mora aqui à parte porque o dado do hook é do servidor, não nosso para mutar.
  const [riscadas, setRiscadas] = useState<number[]>([]);
  const abertas = (data?.tasks ?? [])
    .filter((t) => !CLOSED.has(t.status ?? '') && !riscadas.includes(t.id))
    .slice(0, 3);

  const complete = async (id: number) => {
    setRiscadas((r) => [...r, id]);
    try {
      await fetch(`${API_BASE}/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
    } catch { /* otimista; a view completa corrige */ }
  };

  return (
    <section className="mshell-card mhoje-tarefas">
      <p className="mshell-eyebrow" onClick={() => onOpen({ key: 'tarefas-view', title: 'Tarefas' })}>Tarefas</p>
      {loading ? <Skel />
        : error ? <Erro>Não consegui buscar suas tarefas.</Erro>
        : abertas.length ? abertas.map((t) => (
          <label key={t.id} className="mhoje-tarefas__row">
            <button type="button" className="mhoje-tarefas__check" aria-label="Concluir" onClick={() => complete(t.id)}>
              <CheckIcon size={13} />
            </button>
            <span>{t.title}</span>
          </label>
        ))
        : <Vazio>Tudo em dia — nenhuma tarefa aberta.</Vazio>}
    </section>
  );
}

function HabitosBlock({ onOpen }: { onOpen: Open }) {
  // listHabits não é uma URL simples, então os três estados são montados à mão —
  // o antigo `.catch(() => setHabits(null))` transformava falha em cartão sumido.
  const [habits, setHabits] = useState<HabitWithStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    listHabits()
      .then((h) => { if (alive) { setHabits(h); setError(null); setLoading(false); } })
      .catch((e: unknown) => {
        if (alive) { setHabits(null); setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      });
    return () => { alive = false; };
  }, []);

  const done = (habits ?? []).filter((h) => h.today_completed).length;
  const pct = habits?.length ? Math.round((done / habits.length) * 100) : 0;
  return (
    <section className="mshell-card mhoje-habitos" onClick={() => onOpen({ key: 'habitos', title: 'Hábitos' })}>
      <p className="mshell-eyebrow">Hábitos</p>
      {loading ? <Skel />
        : error ? <Erro>Não consegui buscar seus hábitos.</Erro>
        : habits?.length ? (
          <div className="mhoje-habitos__ring" style={{ background: `conic-gradient(var(--accent, #9a93ff) ${pct}%, rgba(255,255,255,.08) 0)` }}>
            <span>{done}/{habits.length}</span>
          </div>
        )
        : <Vazio>Nenhum hábito por enquanto.</Vazio>}
    </section>
  );
}

function OrcamentoBlock({ onOpen }: { onOpen: Open }) {
  const { data, error, loading } = useFetchJson<{ entries?: { amount: number; kind?: string; type?: string; date?: string; ts?: string }[] }>(
    `${API_BASE}/finance/entries?status=confirmed&limit=100`,
  );
  const total = monthExpenses(data?.entries ?? [], new Date());
  return (
    <section className="mshell-card mhoje-orcamento" onClick={() => onOpen({ key: 'financas', title: 'Finanças' })}>
      <p className="mshell-eyebrow">Gasto do mês</p>
      {loading ? <Skel linhas={1} />
        : error ? <Erro>Não consegui buscar seus gastos.</Erro>
        : total ? <p className="mhoje-orcamento__value">R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
        : <Vazio>Nenhum gasto registrado neste mês.</Vazio>}
    </section>
  );
}
