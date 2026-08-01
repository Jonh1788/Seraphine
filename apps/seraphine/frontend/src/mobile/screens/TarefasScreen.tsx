import { useEffect, useState, type FormEvent } from 'react';
import type { ScreenProps } from './registry';
import { listTasks, updateTaskStatus, createTask } from '../../tasks/api';
import type { Task, TaskStatus } from '../../tasks/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../finance/types';
import { ArrowLeftIcon, CheckIcon, PlusIcon, ChevronRightIcon } from '../../icons/Icons';
import { ModalTarefa } from './ModalTarefa';
import './TarefasScreen.css';

/* Tela TAREFAS do handoff mobile (linha 159 de `Seraphine Mobile.dc.html`).
   Substitui a `TasksView` do desktop, cujo master-detail espremia o kanban em
   ~10% da largura do telefone. Aqui é uma lista só: filtro, linhas com
   checkbox de 22px, o item em foco e as concluídas no fim.

   REGRA DA TELA (igual à do Hoje): nenhum bloco some por falta de dado e
   nenhum devolve `null`. Lista, contagem e barra de progresso têm as três
   saídas — dado, vazio desenhado e erro. Isto importa especialmente aqui:
   em produção as 26 tarefas vêm todas `completed`, então a lista de abertas
   é legitimamente vazia e precisa DIZER isso. */

/** Status que fecham a tarefa: saem da lista de abertas. São os três de
 *  `TaskStatus` (tasks/types.ts) que encerram — `rejected`/`failed` não são
 *  "concluídas", então somem das duas listas, e é de propósito. */
const FECHADOS = new Set(['completed', 'rejected', 'failed']);

type Filtro = 'hoje' | 'semana' | 'todas';

const FILTROS: { id: Filtro; label: string; palavra: string; vazio: string }[] = [
  { id: 'hoje', label: 'Hoje', palavra: 'hoje', vazio: 'Nenhuma tarefa para hoje.' },
  { id: 'semana', label: 'Semana', palavra: 'nesta semana', vazio: 'Nenhuma tarefa para esta semana.' },
  { id: 'todas', label: 'Todas', palavra: 'no total', vazio: 'Você não tem nenhuma tarefa aberta.' },
];

/** Quantas concluídas a lista de baixo mostra. O resto vira uma linha de texto:
 *  26 riscadas empurrariam as abertas para fora da tela. */
const MAX_CONCLUIDAS = 8;

/* ── datas ─────────────────────────────────────────────────────────────── */

/** YYYY-MM-DD no fuso LOCAL. `toISOString()` devolve UTC e, depois das 21h em
 *  São Paulo, jogaria tudo para "amanhã". */
function diaLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function maisDias(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

/** Instante do prazo. Sem hora, vale o fim do dia — uma tarefa "de hoje" só
 *  atrasa quando o dia acaba. */
function prazoMs(t: Task): number | null {
  const dia = (t.due_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  const hora = /^\d{2}:\d{2}/.test(t.due_time ?? '') ? (t.due_time as string).slice(0, 5) : '23:59';
  const ms = new Date(`${dia}T${hora}:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function horaDe(t: Task): string {
  return /^\d{2}:\d{2}/.test(t.due_time ?? '') ? ` ${(t.due_time as string).slice(0, 5)}` : '';
}

/** Texto do prazo + o tom com que ele é pintado. */
function prazo(t: Task, hoje: string, amanha: string): { texto: string; tom: 'atrasada' | 'perto' | 'longe' } | null {
  const dia = (t.due_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  const [, mes, d] = dia.split('-');
  if (dia < hoje) return { texto: `atrasada · ${d}/${mes}`, tom: 'atrasada' };
  if (dia === hoje) return { texto: `hoje${horaDe(t)}`, tom: 'perto' };
  if (dia === amanha) return { texto: `amanhã${horaDe(t)}`, tom: 'perto' };
  return { texto: `${d}/${mes}${horaDe(t)}`, tom: 'longe' };
}

/** Quanto do caminho até o prazo já correu, 0–100. É o que a barra do item em
 *  foco mostra: progresso do PRAZO, não de trabalho feito — a tarefa não tem
 *  campo de progresso no backend, e inventar um seria mentir. */
function corridoDoPrazo(t: Task, agora: number): number | null {
  const fim = prazoMs(t);
  if (fim === null) return null;
  const inicio = Date.parse(t.created_at ?? '');
  if (!Number.isFinite(inicio) || inicio >= fim) return agora >= fim ? 100 : 0;
  const pct = ((agora - inicio) / (fim - inicio)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/* ── categoria ─────────────────────────────────────────────────────────── */

function normaliza(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** Chip colorido da categoria, com as MESMAS cores do desktop
 *  (`finance/types.ts`). Os rótulos de lá vêm com emoji; o projeto proíbe
 *  emoji na UI, então o prefixo cai. Sem categoria conhecida → sem chip. */
function chipDe(t: Task): { label: string; cor: string } | null {
  const candidatos = [t.category, ...(Array.isArray(t.tags) ? t.tags : []), t.type];
  const bruto = candidatos.find((c) => normaliza(c) in CATEGORY_COLORS);
  const chave = normaliza(bruto);
  if (!(chave in CATEGORY_COLORS)) return null;
  const label = (CATEGORY_LABELS[chave] ?? '').replace(/^[^\p{L}]+/u, '').trim();
  return { label: label || (bruto as string), cor: CATEGORY_COLORS[chave] };
}

function corAlfa(hex: string, alfa: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

const PESO_PRIO: Record<string, number> = { high: 3, med: 2, low: 1 };

/* ── tela ──────────────────────────────────────────────────────────────── */

/** ESTA tela vive em dois contextos: é a aba `tarefas` E a tela empurrada
 *  `tarefas-view` — `registry.ts` manda as duas chaves para o mesmo componente,
 *  e a versão empurrada é aberta de três lugares (o eyebrow "Tarefas" do Hoje,
 *  o "Resolver" de qualquer sugestão de tipo `task` e o "+" do Calendário).
 *  Os dois contextos pedem coisas diferentes:
 *
 *   - SAÍDA: no ramo empurrado o `PhoneShell` não monta tab bar, e o
 *     `PushedScreen` deixou de desenhar o ‹ (cada tela é dona do seu cabeçalho).
 *     Sem um voltar próprio, quem entrava aqui ficava preso até reiniciar o app.
 *     Na aba a saída é a tab bar, e o handoff não põe seta nenhuma no cabeçalho
 *     da tela TAREFAS (linha 159 do `Seraphine Mobile.dc.html`).
 *   - PADDING: `.mshell__content` dá `calc(12px + safe-area) 16px 16px`;
 *     `.mpushed__body` dá só as safe areas. O CSS desta tela foi escrito para o
 *     primeiro, então na pilha os cartões sangravam até a borda do telefone.
 *
 *  Quem separa os dois é o `onBack`, como nas outras telas empurradas (Hábitos,
 *  Notas): o shell só o passa no ramo da pilha. Foi assim que a Task 28 desfez
 *  a assimetria — a aba `tarefas` recebia um `onBack` que voltava para o Hoje,
 *  uma saída que o handoff não desenha, e por causa dele esta tela precisava
 *  perguntar ao DOM (`closest('.mshell__content')`) em qual contêiner nasceu.
 *  Some a exceção do shell, some o sniff. */
export function TarefasScreen({ onBack }: ScreenProps) {
  const empurrada = !!onBack;
  const [tarefas, setTarefas] = useState<Task[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [recarga, setRecarga] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>('hoje');
  /** Marcações que já valem na tela e ainda não voltaram do servidor. O PATCH
   *  responde só `{ok}` — não devolve a linha —, então o estado novo é nosso.
   *  Guarda também QUANDO a marcação aconteceu (relógio local, em ms): sem isso
   *  a linha recém-concluída era ordenada pelo `updated_at` VELHO do servidor,
   *  caía abaixo do corte das 8 e sumia das duas listas — o usuário marcava a
   *  caixa e a tarefa desaparecia da tela. */
  const [otimista, setOtimista] = useState<Record<number, { status: TaskStatus; em: number }>>({});
  const [falha, setFalha] = useState<string | null>(null);
  /** A tarefa aberta no modal de edição, ou `null` com o modal fechado. É a
   *  LINHA que a lista tinha em mãos: o modal não recarrega nada, então abrir
   *  não pisca esqueleto por dado que esta tela já possui. */
  const [editando, setEditando] = useState<Task | null>(null);
  /** O modal salva sozinho, campo a campo. Relistar a cada PATCH seria um GET
   *  por tecla digitada; então marca-se que houve escrita e a lista se refaz
   *  UMA vez, quando o modal fecha — que é quando a lista volta a ser vista. */
  const [sujo, setSujo] = useState(false);
  const [compondo, setCompondo] = useState(false);
  const [titulo, setTitulo] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    listTasks({ limit: 200 })
      .then((ts) => {
        if (!vivo) return;
        setTarefas(ts);
        // A lista nova JÁ traz o que marcamos: manter as marcações locais aqui
        // faria elas sobreporem para sempre o que o servidor diz.
        setOtimista({});
        setErro(null);
        setCarregando(false);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setTarefas(null);
        setErro(e instanceof Error ? e.message : String(e));
        setCarregando(false);
      });
    return () => { vivo = false; };
  }, [recarga]);

  const agora = Date.now();
  const hoje = diaLocal(new Date());
  const amanha = diaLocal(maisDias(new Date(), 1));
  const fimDaSemana = diaLocal(maisDias(new Date(), 6));
  const conf = FILTROS.find((f) => f.id === filtro) ?? FILTROS[0];

  const statusDe = (t: Task): string => otimista[t.id]?.status ?? t.status;

  /** Tarefa sem prazo aparece em TODOS os filtros: esconder no filtro padrão a
   *  tarefa que ninguém datou é exatamente como o Hoje "sumia". */
  const noFiltro = (t: Task): boolean => {
    if (filtro === 'todas') return true;
    const dia = (t.due_date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return true;
    return dia <= (filtro === 'hoje' ? hoje : fimDaSemana);
  };

  const todas = tarefas ?? [];
  const abertas = todas
    .filter((t) => !FECHADOS.has(statusDe(t)) && noFiltro(t))
    .sort((a, b) => {
      const pa = prazoMs(a);
      const pb = prazoMs(b);
      if (pa !== pb) {
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      }
      const prio = (PESO_PRIO[b.priority ?? ''] ?? 0) - (PESO_PRIO[a.priority ?? ''] ?? 0);
      return prio || a.id - b.id;
    });
  // O que ACABOU de ser marcado vai para o topo — antes de qualquer ordenação
  // pelo relógio do servidor, que não sabe da marcação ainda. É o que garante
  // que a linha sobreviva ao corte de MAX_CONCLUIDAS e continue na tela.
  const concluidas = todas
    .filter((t) => statusDe(t) === 'completed')
    .sort((a, b) => {
      const ma = otimista[a.id]?.em ?? null;
      const mb = otimista[b.id]?.em ?? null;
      if (ma !== null && mb !== null) return mb - ma;
      if (ma !== null) return -1;
      if (mb !== null) return 1;
      return String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at));
    });
  const foco = abertas[0]?.id ?? null;

  const concluir = async (t: Task, para: TaskStatus) => {
    const antes = statusDe(t);
    setOtimista((o) => ({ ...o, [t.id]: { status: para, em: Date.now() } }));
    setFalha(null);
    try {
      await updateTaskStatus(t.id, para);
    } catch (e: unknown) {
      setOtimista((o) => {
        const copia = { ...o };
        if (antes === t.status) delete copia[t.id];
        else copia[t.id] = { status: antes as TaskStatus, em: Date.now() };
        return copia;
      });
      setFalha(e instanceof Error ? e.message : String(e));
    }
  };

  const criar = async (ev: FormEvent) => {
    ev.preventDefault();
    const nome = titulo.trim();
    if (!nome || salvando) return;
    setSalvando(true);
    setFalha(null);
    try {
      await createTask({ type: 'generic', title: nome, source: 'mobile' });
      setTitulo('');
      setCompondo(false);
      setRecarga((r) => r + 1); // o POST devolve só {id, ok}: a linha vem da re-listagem
    } catch (e: unknown) {
      setFalha(e instanceof Error ? e.message : String(e));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className={`ms-tarefas${empurrada ? ' ms-tarefas--empurrada' : ''}`}>
      <header className="ms-tarefas__head">
        {/* Mesmo arrow-left das outras telas empurradas (18px, --dim). Só na
            pilha: na aba ele seria um segundo caminho para fora, que o handoff
            não desenha e que a tab bar já cobre. */}
        {onBack && (
          <button type="button" className="ms-tarefas__voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-tarefas__head-txt">
          <h1 className="ms-tarefas__title">Tarefas</h1>
          {carregando ? <Skel linhas={1} className="ms-tarefas__sub-skel" />
            : erro ? <p className="ms-tarefas-erro ms-tarefas-erro--sub" role="alert" title={erro}>sem contagem: a lista não carregou</p>
            : (
              <p className="ms-tarefas__sub">
                {abertas.length} {conf.palavra} · {concluidas.length === 1 ? '1 concluída' : `${concluidas.length} concluídas`}
              </p>
            )}
        </div>
        <button
          type="button"
          className="ms-tarefas__novo"
          aria-label="Nova tarefa"
          aria-expanded={compondo}
          onClick={() => setCompondo((c) => !c)}
        >
          <PlusIcon size={19} />
        </button>
      </header>

      <div className="ms-tarefas__filtros" role="group" aria-label="Filtrar por prazo">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`ms-tarefas__filtro${filtro === f.id ? ' ms-tarefas__filtro--on' : ''}`}
            aria-pressed={filtro === f.id}
            onClick={() => setFiltro(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {compondo && (
        <form className="ms-tarefas__nova" onSubmit={criar}>
          <input
            className="ms-tarefas__nova-input"
            aria-label="Título da nova tarefa"
            placeholder="O que precisa ser feito?"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            autoFocus
          />
          <button type="submit" className="ms-tarefas__nova-ok" disabled={salvando || !titulo.trim()}>
            Adicionar
          </button>
        </form>
      )}

      {falha && (
        <p className="ms-tarefas-erro" role="alert" title={falha}>
          Não consegui salvar essa mudança. Tente de novo.
        </p>
      )}

      <ul className="ms-tarefas__lista">
        {carregando ? (
          <li className="ms-tarefas__estado"><Skel linhas={3} /></li>
        ) : erro ? (
          <li className="ms-tarefas__estado">
            <p className="ms-tarefas-erro" role="alert" title={erro}>Não consegui carregar suas tarefas.</p>
          </li>
        ) : abertas.length ? (
          abertas.map((t) => (
            <Linha
              key={t.id}
              tarefa={t}
              foco={t.id === foco}
              agora={agora}
              hoje={hoje}
              amanha={amanha}
              onAbrir={() => setEditando(t)}
              onConcluir={() => concluir(t, 'completed')}
            />
          ))
        ) : (
          <li className="ms-tarefas__estado"><p className="ms-tarefas-vazio">{conf.vazio}</p></li>
        )}
      </ul>

      <div className="ms-tarefas__sep">
        <span className="ms-tarefas__sep-linha" />
        <span className="ms-tarefas__sep-label">CONCLUÍDAS</span>
        <span className="ms-tarefas__sep-linha" />
      </div>

      <ul className="ms-tarefas__lista">
        {carregando ? (
          <li className="ms-tarefas__estado"><Skel linhas={2} /></li>
        ) : erro ? (
          <li className="ms-tarefas__estado">
            <p className="ms-tarefas-erro" role="alert" title={erro}>A lista de concluídas também não carregou.</p>
          </li>
        ) : concluidas.length ? (
          <>
            {concluidas.slice(0, MAX_CONCLUIDAS).map((t) => (
              <li key={t.id} className="ms-tarefas-row ms-tarefas-row--feita">
                <button
                  type="button"
                  className="ms-tarefas-row__check ms-tarefas-row__check--feito"
                  aria-label={`Reabrir ${t.title}`}
                  onClick={() => concluir(t, 'pending')}
                >
                  <CheckIcon size={13} />
                </button>
                <span className="ms-tarefas-row__feito">{t.title}</span>
              </li>
            ))}
            {concluidas.length > MAX_CONCLUIDAS && (
              <li className="ms-tarefas__estado">
                <p className="ms-tarefas-vazio">e mais {concluidas.length - MAX_CONCLUIDAS} concluídas antes destas.</p>
              </li>
            )}
          </>
        ) : (
          <li className="ms-tarefas__estado"><p className="ms-tarefas-vazio">Você ainda não concluiu nenhuma tarefa.</p></li>
        )}
      </ul>

      {/* Montado SÓ com uma tarefa escolhida: `ModalTarefa` exige `tarefa`, e
          mantê-lo montado com um objeto de mentira faria o sheet fechado
          carregar estado de uma tarefa que ninguém abriu. Fechar recarrega a
          lista uma única vez, e só se algo foi mesmo gravado. */}
      {editando && (
        <ModalTarefa
          aberto
          tarefa={editando}
          onFechar={() => {
            setEditando(null);
            if (sujo) {
              setSujo(false);
              setRecarga((r) => r + 1);
            }
          }}
          onSalvo={() => setSujo(true)}
          onExcluida={() => {
            // A exclusão não espera o fechamento: a linha some da lista, e é a
            // única mudança que o usuário não pode desfazer daqui.
            setSujo(false);
            setRecarga((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

/** Uma tarefa aberta. A primeira da lista é a "em foco": borda accent, anel e
 *  a barra do prazo — é o tratamento que o handoff dá ao item do momento. */
function Linha({ tarefa, foco, agora, hoje, amanha, onAbrir, onConcluir }: {
  tarefa: Task;
  foco: boolean;
  agora: number;
  hoje: string;
  amanha: string;
  onAbrir: () => void;
  onConcluir: () => void;
}) {
  const chip = chipDe(tarefa);
  const quando = prazo(tarefa, hoje, amanha);
  const corrido = foco ? corridoDoPrazo(tarefa, agora) : null;
  const urgente = foco || quando?.tom === 'atrasada' || quando?.tom === 'perto';

  return (
    <li className={`ms-tarefas-row${foco ? ' ms-tarefas-row--foco' : ''}`}>
      <button
        type="button"
        className={`ms-tarefas-row__check${urgente ? ' ms-tarefas-row__check--urgente' : ''}`}
        aria-label={`Concluir ${tarefa.title}`}
        onClick={onConcluir}
      >
        <CheckIcon size={13} />
      </button>
      {/* Tocar na linha ABRE O EDITOR (o sheet do handoff), em vez de expandir
          a descrição no lugar. O modal mostra a mesma descrição e mais sete
          campos que gravam de verdade — a expansão inline era a versão pobre
          dele, de quando `tasks/api.ts` só sabia mudar o status. */}
      <button
        type="button"
        className="ms-tarefas-row__body"
        aria-label={`Editar ${tarefa.title}`}
        aria-haspopup="dialog"
        onClick={onAbrir}
      >
        <span className="ms-tarefas-row__texto">
          <span className={`ms-tarefas-row__title${foco ? ' ms-tarefas-row__title--foco' : ''}`}>{tarefa.title}</span>
          {(chip || quando) && (
            <span className="ms-tarefas-row__meta">
              {chip && (
                <span
                  className="ms-tarefas-chip"
                  style={{ color: chip.cor, background: corAlfa(chip.cor, 0.16) }}
                >
                  {chip.label}
                </span>
              )}
              {quando && <span className={`ms-tarefas-prazo ms-tarefas-prazo--${quando.tom}`}>{quando.texto}</span>}
            </span>
          )}
          {foco && (
            <span className="ms-tarefas-foco">
              {corrido === null ? (
                <span className="ms-tarefas-foco__sem">sem prazo definido</span>
              ) : (
                <span
                  className="ms-tarefas-foco__barra"
                  role="progressbar"
                  aria-label="Tempo corrido até o prazo"
                  aria-valuenow={corrido}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="ms-tarefas-foco__preenchida" style={{ width: `${corrido}%` }} />
                </span>
              )}
              <span className="ms-tarefas-foco__label">em foco</span>
            </span>
          )}
        </span>
        {!foco && (
          <span className="ms-tarefas-row__chevron" aria-hidden="true">
            <ChevronRightIcon size={16} />
          </span>
        )}
      </button>
    </li>
  );
}

/** Espera sem texto: barras cinzentas no lugar do que vem. Nada de "tudo em
 *  dia" piscando antes do dado chegar. */
function Skel({ linhas = 2, className = '' }: { linhas?: number; className?: string }) {
  return (
    <span className={`ms-tarefas-skel ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </span>
  );
}
