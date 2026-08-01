import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apagarEvento, fetchAggregate, fetchTasksByRange } from '../../calendar/api';
import type { AggregateDay, Task } from '../../calendar/types';
import { ArrowLeftIcon, PlusIcon, TrashIcon } from '../../icons/Icons';
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
  /** Só nas linhas de EVENTO: o id no Google, que é o que torna a linha
   *  apagável. Vazio quando o agregado não o trouxe — e aí a tela diz isso em
   *  vez de oferecer um botão que apagaria o quê. */
  eventoId?: string;
}

/** O que aconteceu (ou está marcado) num dia, na ordem das categorias.
 *  As bolinhas da grade saem DESTA mesma função, então bolinha e lista nunca
 *  discordam: um dia com bolinha sempre tem linha — e um evento apagado some
 *  das duas de uma vez. */
function itensDoDia(
  dia: AggregateDay | undefined,
  tarefas: Map<number, Task>,
  apagados: ReadonlySet<string>,
): Item[] {
  if (!dia) return [];
  const itens: Item[] = [];

  dia.events.forEach((e, i) => {
    const id = e.id ?? '';
    // Apagado com confirmação do servidor. Fica de fora mesmo que um
    // recarregamento traga o evento de volta (o Google leva um instante para
    // parar de listá-lo): ele NÃO está mais na agenda.
    if (id && apagados.has(id)) return;
    // A data entra na chave porque o índice sozinho colide entre dias — e a
    // chave carrega estado de linha (confirmação, erro), que não pode vazar
    // de um dia para outro.
    itens.push({
      chave: `ev-${dia.date}-${id || i}`,
      cat: 'eventos',
      titulo: e.title,
      sub: faixa(e.start, e.end),
      eventoId: id,
    });
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

  /* ── APAGAR EVENTO ────────────────────────────────────────────────────
     A INTERAÇÃO É BOTÃO NA LINHA, não deslizar nem toque longo:
      - a ação é DESTRUTIVA e não tem desfazer por aqui; gesto é justamente a
        forma mais fácil de disparar sem querer numa lista que rola;
      - esta onda já decidiu isto uma vez — a tela de Planejamento trocou o
        arrastar por toque pelo mesmo motivo;
      - gesto é invisível: um botão anuncia que a linha pode ser apagada, e um
        alvo de 44pt é alcançável com o polegar sem mira.
     A confirmação NOMEIA o evento e o horário: "tem certeza?" não diz o que
     vai sumir.

     E NADA SOME ANTES DA CONFIRMAÇÃO DO SERVIDOR. Sem remoção otimista: uma
     linha que desaparece na hora do toque é uma promessa que a falha teria que
     desdizer, e o pior resultado possível desta tela é a pessoa achar que
     apagou com o compromisso ainda no Google. */
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [apagando, setApagando] = useState<string | null>(null);
  const [erroApagar, setErroApagar] = useState<{ chave: string; mensagem: string } | null>(null);
  const [apagados, setApagados] = useState<ReadonlySet<string>>(() => new Set<string>());
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; };
  }, []);

  /** UMA guarda de reentrância, e é a que também se vê: o "Sim" fica
   *  `disabled` enquanto `apagando` for esta linha. Havia uma segunda, em ref,
   *  e a mutação provou que nenhuma das duas era observável — cada uma cobria
   *  a outra. Duas versões da mesma regra é o que diverge com o tempo; ficou a
   *  que o usuário enxerga. */
  const apagarLinha = async (it: Item): Promise<void> => {
    if (!it.eventoId) return;
    setApagando(it.chave);
    setErroApagar(null);
    try {
      await apagarEvento(it.eventoId);
      if (!vivo.current) return;
      // Agora sim. `jaNaoExistia` não muda o que a tela faz — o evento não está
      // na agenda de um jeito ou de outro —, mas a camada o distingue para
      // ninguém confundir "não estava lá" com "eu apaguei".
      setApagados((atual) => new Set(atual).add(it.eventoId as string));
      setConfirmando(null);
    } catch (e: unknown) {
      if (!vivo.current) return;
      // A linha FICA. E o motivo aparece com `role="alert"`.
      setConfirmando(null);
      setErroApagar({ chave: it.chave, mensagem: e instanceof Error ? e.message : String(e) });
    } finally {
      if (vivo.current) setApagando(null);
    }
  };

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
    (dias ?? []).forEach((d) => m.set(d.date, itensDoDia(d, mapaTarefas, apagados)));
    return m;
  }, [dias, tarefas, apagados]);

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
              <div className="ms-calendario-item__linha">
                <div className="ms-calendario-item__texto">
                  <p className="ms-calendario-item__titulo">{it.titulo}</p>
                  <p className="ms-calendario-item__sub">{it.sub}</p>
                </div>
                {/* Só EVENTO tem este controle: a tarefa se apaga na tela de
                    tarefas, e o DELETE do calendário nem a alcançaria. */}
                {it.cat === 'eventos' && confirmando !== it.chave ? (
                  it.eventoId ? (
                    <button
                      type="button"
                      className="ms-calendario-item__apagar"
                      aria-label={`Apagar evento ${it.titulo}`}
                      onClick={() => { setErroApagar(null); setConfirmando(it.chave); }}
                    >
                      <TrashIcon size={16} />
                    </button>
                  ) : (
                    /* Sem id não dá para apagar com segurança — e sumir com o
                       botão calado deixaria a pessoa procurando o que não
                       existe. Ele fica, desabilitado, dizendo o porquê. */
                    <button
                      type="button"
                      className="ms-calendario-item__apagar"
                      disabled
                      aria-label={`Não dá para apagar ${it.titulo}: a agenda não trouxe o identificador deste evento`}
                      title="sem identificador — recarregue a agenda"
                    >
                      <TrashIcon size={16} />
                    </button>
                  )
                ) : null}
              </div>

              {confirmando === it.chave ? (
                <div className="ms-calendario-confirma">
                  <p className="ms-calendario-confirma__texto" id={`ms-cal-confirma-${it.chave}`}>
                    Apagar “{it.titulo}” — {it.sub}?
                  </p>
                  <div className="ms-calendario-confirma__acoes">
                    <button
                      type="button"
                      className="ms-calendario-confirma__botao ms-calendario-confirma__botao--perigo"
                      aria-describedby={`ms-cal-confirma-${it.chave}`}
                      disabled={apagando === it.chave}
                      onClick={() => void apagarLinha(it)}
                    >
                      Sim
                    </button>
                    <button
                      type="button"
                      className="ms-calendario-confirma__botao"
                      aria-describedby={`ms-cal-confirma-${it.chave}`}
                      onClick={() => setConfirmando(null)}
                    >
                      Não
                    </button>
                    {apagando === it.chave ? (
                      <span className="ms-calendario-confirma__estado" role="status">apagando…</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {erroApagar?.chave === it.chave ? (
                <p className="ms-calendario-item__erro" role="alert">
                  Não consegui apagar “{it.titulo}”: {erroApagar.mensagem}
                </p>
              ) : null}
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
