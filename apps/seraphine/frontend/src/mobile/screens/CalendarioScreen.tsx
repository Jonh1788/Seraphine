import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchAggregate, fetchTasksByRange } from '../../calendar/api';
import type { AggregateDay, Task } from '../../calendar/types';
import { ArrowLeftIcon, PlusIcon } from '../../icons/Icons';
import { ModalEvento } from './ModalEvento';
import type { ScreenProps } from './registry';
import './CalendarioScreen.css';

/* Tela CALENDÁRIO (handoff linha 518) — empurrada: ‹ + mês, grade do mês com
   hoje em accent e bolinhas de categoria, lista do dia com border-left colorida.
 *
 * A grade desenha o MÊS INTEIRO. É de propósito: montar o `CalendarView` de
 * desktop dentro de 390px cortava o mês no dia 18 (o usuário via "o calendário
 * só vai até o 18"). Aqui as células nascem do calendário, não do layout, e o
 * teste fixa a contagem — truncar de novo quebra vermelho.
 *
 * Regra da onda: nenhum bloco some por falta de dado. Vazio, erro e carregando
 * são estados desenhados, cada bloco com a SUA frase. */

type CatId = 'eventos' | 'tarefas' | 'habitos' | 'foco' | 'diario';

/** Ordem das bolinhas e das linhas do dia. A cor mora no CSS (`--<cat>`). */
const CATEGORIAS: CatId[] = ['eventos', 'tarefas', 'habitos', 'foco', 'diario'];

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const SEMANA_CURTA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/** Status que fecham uma tarefa (mesmo conjunto que o Hoje usa). */
const FECHADAS = new Set(['completed', 'rejected', 'failed', 'discarded']);

const doisDigitos = (n: number) => String(n).padStart(2, '0');
const isoDe = (ano: number, mes: number, dia: number) => `${ano}-${doisDigitos(mes + 1)}-${doisDigitos(dia)}`;
const isoLocal = (d: Date) => isoDe(d.getFullYear(), d.getMonth(), d.getDate());
/** "2026-06-20T09:00:00" → "09:00". Sem `new Date`: o servidor manda a hora
 *  local do evento e reinterpretá-la como UTC deslocaria o horário. */
const hora = (s: string | undefined) => (s && s.includes('T') ? s.slice(11, 16) : '');

function faixa(inicio?: string, fim?: string): string {
  const a = hora(inicio);
  const b = hora(fim);
  if (a && b) return `${a} – ${b}`;
  if (a) return a;
  return 'Dia inteiro';
}

const plural = (n: number, um: string, muitos: string) => `${n} ${n === 1 ? um : muitos}`;

interface Item {
  chave: string;
  cat: CatId;
  titulo: string;
  sub: string;
}

/** O que aconteceu (ou está marcado) num dia, na ordem das categorias.
 *  As bolinhas da grade saem DESTA mesma função, então bolinha e lista nunca
 *  discordam: um dia com bolinha sempre tem linha. */
function itensDoDia(dia: AggregateDay | undefined, tarefas: Map<number, Task>): Item[] {
  if (!dia) return [];
  const itens: Item[] = [];

  dia.events.forEach((e, i) => {
    itens.push({ chave: `ev-${i}`, cat: 'eventos', titulo: e.title, sub: faixa(e.start, e.end) });
  });

  dia.tasks.forEach((t) => {
    const cheia = tarefas.get(t.id);
    const rotulo = FECHADAS.has(t.status) ? 'Tarefa concluída' : 'Tarefa';
    const h = cheia?.due_time ?? '';
    itens.push({ chave: `tf-${t.id}`, cat: 'tarefas', titulo: t.title, sub: h ? `${rotulo} · ${h}` : rotulo });
  });

  dia.habits.filter((h) => h.completed).forEach((h) => {
    itens.push({ chave: `hb-${h.habit_id}`, cat: 'habitos', titulo: h.name, sub: 'Hábito concluído' });
  });

  if (dia.focus && dia.focus.total_min > 0) {
    itens.push({
      chave: 'fc',
      cat: 'foco',
      titulo: `${dia.focus.total_min} min de foco`,
      sub: plural(dia.focus.sessions_count, 'sessão', 'sessões'),
    });
  }

  if (dia.journal && dia.journal.count > 0) {
    itens.push({
      chave: 'dr',
      cat: 'diario',
      titulo: `${plural(dia.journal.count, 'anotação', 'anotações')} no diário`,
      sub: 'Diário',
    });
  }

  return itens;
}

export function CalendarioScreen({ onBack }: ScreenProps) {
  // O mês exibido é o corrente; `hoje` é fixado no primeiro render para o
  // destaque não escorregar se a tela ficar aberta pela virada do dia.
  const hoje = useMemo(() => new Date(), []);
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  const inicio = isoDe(ano, mes, 1);
  const fim = isoDe(ano, mes, ultimoDia);
  const isoHoje = isoLocal(hoje);

  const [dias, setDias] = useState<AggregateDay[] | null>(null);
  const [tarefas, setTarefas] = useState<Task[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [sel, setSel] = useState(isoHoje);
  const [criando, setCriando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    Promise.all([fetchAggregate(inicio, fim), fetchTasksByRange(inicio, fim)])
      .then(([d, t]) => {
        if (!vivo) return;
        setDias(d); setTarefas(t); setErro(null); setCarregando(false);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setDias(null); setTarefas([]);
        setErro(e instanceof Error ? e.message : String(e));
        setCarregando(false);
      });
    return () => { vivo = false; };
  }, [inicio, fim, recarga]);

  // dia (YYYY-MM-DD) → linhas daquele dia. Uma passada só serve grade e lista.
  const porDia = useMemo(() => {
    const mapaTarefas = new Map(tarefas.map((t) => [t.id, t]));
    const m = new Map<string, Item[]>();
    (dias ?? []).forEach((d) => m.set(d.date, itensDoDia(d, mapaTarefas)));
    return m;
  }, [dias, tarefas]);

  // Semanas do mês: cada uma com 7 posições, `null` no que é de outro mês.
  const semanas = useMemo(() => {
    const desloca = new Date(ano, mes, 1).getDay();
    const celulas = Math.ceil((desloca + ultimoDia) / 7) * 7;
    const out: (number | null)[][] = [];
    for (let i = 0; i < celulas; i += 7) {
      out.push(Array.from({ length: 7 }, (_, k) => {
        const dia = i + k - desloca + 1;
        return dia >= 1 && dia <= ultimoDia ? dia : null;
      }));
    }
    return out;
  }, [ano, mes, ultimoDia]);

  const itensSel = porDia.get(sel) ?? [];
  const eventosHoje = (porDia.get(isoHoje) ?? []).filter((i) => i.cat === 'eventos').length;
  const mesVazio = !carregando && !erro && Array.from(porDia.values()).every((i) => i.length === 0);
  const dataSel = new Date(Number(sel.slice(0, 4)), Number(sel.slice(5, 7)) - 1, Number(sel.slice(8, 10)));

  return (
    <div className="ms-calendario">
      <header className="ms-calendario-head">
        <button type="button" className="ms-calendario-voltar" aria-label="Voltar" onClick={onBack}>
          <ArrowLeftIcon size={18} />
        </button>
        <div className="ms-calendario-head__texto">
          <h1 className="ms-calendario-mes">{MESES[mes]}</h1>
          {carregando ? <Skel linhas={1} />
            : erro ? <Erro>Não consegui ler a agenda de hoje.</Erro>
            : <p className="ms-calendario-sub">
                {eventosHoje ? `${plural(eventosHoje, 'evento', 'eventos')} hoje` : 'nada marcado hoje'}
              </p>}
        </div>
        {/* O "+" desta tela cria EVENTO, não tarefa. Ele apontava para a lista
            de tarefas porque a criação de evento não tinha rota: existia só
            como ferramenta do modelo. Com `POST /google/calendar/events` de pé
            (e `criarEvento` na camada), o controle passou a fazer o que a tela
            em que ele está sugere. A porta para `tarefas-view` não se perdeu:
            o Hoje continua abrindo a lista de tarefas por dois caminhos. */}
        <button
          type="button"
          className="ms-calendario-novo"
          aria-label="Novo evento"
          aria-haspopup="dialog"
          onClick={() => setCriando(true)}
        >
          <PlusIcon size={18} />
        </button>
      </header>

      <div className="ms-calendario-grade-wrap">
        <div className="ms-calendario-card">
          <div className="ms-calendario-linha">
            {SEMANA_CURTA.map((d, i) => (
              <span key={i} className="ms-calendario-rotulo" aria-hidden="true">{d}</span>
            ))}
          </div>

          {semanas.map((semana, i) => (
            <div key={i} className="ms-calendario-semana">
              <div className="ms-calendario-linha">
                {semana.map((dia, k) => {
                  if (dia === null) return <span key={k} className="ms-calendario-fora" />;
                  const data = isoDe(ano, mes, dia);
                  const ehHoje = data === isoHoje;
                  return (
                    <button
                      key={k}
                      type="button"
                      data-dia={dia}
                      aria-current={ehHoje ? 'date' : undefined}
                      aria-pressed={data === sel}
                      aria-label={`${dia} de ${MESES[mes]}`}
                      onClick={() => setSel(data)}
                      className={[
                        'ms-calendario-dia',
                        ehHoje ? 'ms-calendario-dia--hoje' : '',
                        data === sel && !ehHoje ? 'ms-calendario-dia--sel' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      {dia}
                    </button>
                  );
                })}
              </div>
              <div className="ms-calendario-linha ms-calendario-pontos">
                {semana.map((dia, k) => {
                  if (dia === null) return <span key={k} />;
                  const data = isoDe(ano, mes, dia);
                  const cats = CATEGORIAS.filter((c) => (porDia.get(data) ?? []).some((it) => it.cat === c));
                  return (
                    <span key={k} className="ms-calendario-ponto-cel" data-pontos={data}>
                      {cats.map((c) => (
                        <span key={c} className={`ms-calendario-ponto ms-calendario-ponto--${c}`} data-cat={c} />
                      ))}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}

          {carregando ? <Skel linhas={1} />
            : erro ? <Erro>Não consegui marcar os dias deste mês.</Erro>
            : mesVazio ? <Vazio>Nenhum registro neste mês — nada de agenda, tarefas ou hábitos até aqui.</Vazio>
            : null}
        </div>
      </div>

      <section className="ms-calendario-lista">
        <p className="ms-calendario-eyebrow">{SEMANA[dataSel.getDay()]}, {dataSel.getDate()}</p>
        {carregando ? <Skel linhas={3} />
          : erro ? <Erro>Não consegui carregar os itens deste dia.</Erro>
          : itensSel.length ? itensSel.map((it) => (
            <article key={it.chave} className={`ms-calendario-item ms-calendario-item--${it.cat}`}>
              <p className="ms-calendario-item__titulo">{it.titulo}</p>
              <p className="ms-calendario-item__sub">{it.sub}</p>
            </article>
          ))
          : <Vazio>Nada marcado neste dia — nenhum evento, tarefa ou registro.</Vazio>}
      </section>

      {/* `dia={sel}` e não "hoje": o modal nasce no dia que a grade está
          mostrando, senão marcar algo para dia 20 exigiria escolher a data
          duas vezes. Criado, o mês inteiro se refaz — o evento novo pode cair
          em qualquer célula, não só na selecionada. */}
      <ModalEvento
        aberto={criando}
        dia={sel}
        onFechar={() => setCriando(false)}
        onCriado={() => {
          setCriando(false);
          setRecarga((r) => r + 1);
        }}
      />
    </div>
  );
}

/** Vazio: o bloco continua de pé e diz o que exatamente não há. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-calendario-vazio">{children}</p>;
}

/** Erro: tinta de perigo, para nunca ser lido como "o dia está livre". */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-calendario-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nenhum bloco pode piscar "nada marcado" antes do dado. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-calendario-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}
