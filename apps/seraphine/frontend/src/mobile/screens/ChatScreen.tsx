import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAppRefs } from '../../stores/RefsContext';
import { useChatStore } from '../../stores/chatStore';
import { Orb } from '../Orb';
import { ArrowLeftIcon, MicIcon, SendIcon, SparkleIcon, VolumeIcon } from '../../icons/Icons';
import { updateTaskStatus } from '../../tasks/api';
import { fetchConversationTurns } from '../../chat/api';
import type { ConversationTurn } from '../../chat/types';
import type { SeraphineWS } from '../../ws/client';
import type { ScreenProps } from './registry';
import './ChatScreen.css';

/**
 * Chat do telefone — handoff `Seraphine Mobile.dc.html`, linha 78.
 *
 * O chat não tem `api.ts`: a fonte de dado é o WebSocket único que o
 * `AppBootstrap` cria e publica no `useAppRefs().wsRef` (era assim que o
 * antigo `ChatTab` alcançava a `ChatView` do desktop, que esta tela
 * substitui no telefone).
 *
 * REGRA DA ONDA: nenhum bloco some por falta de dado e nenhum devolve `null`.
 * Aqui isso vale para os dois blocos que dependem de dado — a presença no
 * cabeçalho e a conversa — e cada um erra com a SUA frase, para o teste poder
 * apontar para um bloco só.
 */

const CONV_KEY = 'seraphine_conversation_id';
/** O socket nasce em milissegundos; 40 tentativas de 100ms = 4s antes de desistir. */
const TENTATIVAS = 40;

type Autor = 'voce' | 'sera';

interface CardTarefa {
  id: number;
  titulo: string;
  quando: string;
}

interface Orcamento {
  usado: number;
  total: number;
  livre: number;
}

interface Bolha {
  id: string;
  autor: Autor;
  texto: string;
  streaming?: boolean;
  tarefas?: CardTarefa[];
  orcamento?: Orcamento;
  /** Motivo da ferramenta que falhou neste turno. */
  erroFerramenta?: string;
  /** Bolha aberta por um `tool_result` que chegou antes de ela falar: o
   *  próximo turno de texto a adota, para o cartão e a frase ficarem juntos. */
  orfa?: boolean;
}

export function ChatScreen({ onOpen, onBack }: ScreenProps) {
  const { wsRef } = useAppRefs();
  const [ws, setWs] = useState<SeraphineWS | null>(() => wsRef.current);
  const [desistiu, setDesistiu] = useState(false);
  // O `SeraphineWS` só avisa quando o estado MUDA: um socket já aberto antes da
  // aba montar não dispara nada. O `AppBootstrap` mantém o estado corrente no
  // chatStore, então ele é a semente; daí em diante quem manda é o socket.
  const [status, setStatus] = useState<'connected' | 'disconnected'>(
    () => useChatStore.getState().status,
  );
  const [bolhas, setBolhas] = useState<Bolha[]>([]);
  const [falha, setFalha] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState('');
  // Restauro do transcrito: só há o que esperar se já existe conversa gravada.
  const [restaurando, setRestaurando] = useState(() => !!localStorage.getItem(CONV_KEY));
  const [falhaHistorico, setFalhaHistorico] = useState(false);
  const speak = useChatStore((s) => s.speak);
  const setSpeak = useChatStore((s) => s.setSpeak);
  const conversaRef = useRef<string | undefined>(localStorage.getItem(CONV_KEY) || undefined);
  const fimRef = useRef<HTMLDivElement | null>(null);

  // O AppBootstrap cria o socket de forma assíncrona: enquanto ele não existe a
  // conversa fica em esqueleto. Se nunca chegar, viramos erro desenhado — um
  // esqueleto eterno seria o mesmo bloco sumido de sempre, só que cinza.
  useEffect(() => {
    if (wsRef.current) {
      setWs(wsRef.current);
      return;
    }
    let tentativas = 0;
    const t = setInterval(() => {
      if (wsRef.current) {
        setWs(wsRef.current);
        clearInterval(t);
        return;
      }
      tentativas += 1;
      if (tentativas >= TENTATIVAS) {
        setDesistiu(true);
        clearInterval(t);
      }
    }, 100);
    return () => clearInterval(t);
  }, [wsRef]);

  // A aba Chat desmonta ao trocar de aba, e o socket só entrega o que ainda vai
  // acontecer: sem este restauro, voltar para a aba apagava a conversa da tela
  // (o backend seguia com o contexto — a perda era só visual, e total).
  useEffect(() => {
    const conversa = conversaRef.current;
    if (!conversa) return;
    let vivo = true;
    fetchConversationTurns(conversa)
      .then((turnos) => {
        if (!vivo) return;
        // Merge por id, e não substituição: se um turno ao vivo chegou
        // enquanto o histórico voltava, ele não pode ser atropelado.
        setBolhas((prev) => {
          const antigos = turnos.map(deTurno).filter((b) => !prev.some((p) => p.id === b.id));
          return [...antigos, ...prev];
        });
        setFalhaHistorico(false);
      })
      .catch(() => { if (vivo) setFalhaHistorico(true); })
      .finally(() => { if (vivo) setRestaurando(false); });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (!ws) return;
    return ws.onStatus((s) => setStatus(s));
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((raw) => {
      if (raw instanceof ArrayBuffer) return;
      // Uma união de envelopes é chata de estreitar campo a campo; aqui só os
      // poucos que a tela desenha importam, e cada leitura já vem checada.
      const msg = raw as unknown as Record<string, unknown>;

      if (msg.type === 'token') {
        const turnId = String(msg.turn_id ?? '');
        const texto = String(msg.text ?? '');
        if (!conversaRef.current && typeof msg.conversation_id === 'string') {
          conversaRef.current = msg.conversation_id;
          localStorage.setItem(CONV_KEY, msg.conversation_id);
        }
        setFalha(null);
        setBolhas((prev) => {
          const i = prev.findIndex((b) => b.id === turnId);
          if (i !== -1) {
            const next = prev.slice();
            next[i] = { ...next[i], texto: next[i].texto + texto };
            return next;
          }
          // Adota a bolha que um `tool_result` abriu antes de ela falar, para o
          // texto pós-ferramenta e o cartão ficarem na MESMA fala, como no
          // handoff — em vez de virarem duas falas seguidas.
          const ultimo = prev.length - 1;
          if (ultimo >= 0 && prev[ultimo].orfa) {
            const next = prev.slice();
            next[ultimo] = { ...next[ultimo], id: turnId, texto, streaming: true, orfa: false };
            return next;
          }
          return [...prev, { id: turnId, autor: 'sera', texto, streaming: true }];
        });
        return;
      }

      if (msg.type === 'turn_end') {
        const turnId = String(msg.turn_id ?? '');
        setBolhas((prev) => prev.map((b) => (b.id === turnId ? { ...b, streaming: false } : b)));
        return;
      }

      if (msg.type === 'assistant_opener') {
        const texto = String(msg.text ?? '');
        if (!texto) return;
        setBolhas((prev) => [...prev, { id: `abre-${prev.length}-${Date.now()}`, autor: 'sera', texto }]);
        return;
      }

      if (msg.type === 'error') {
        setBolhas((prev) => prev.map((b) => ({ ...b, streaming: false })));
        // Nunca vazio: um `falha` em branco apagaria o próprio aviso de falha.
        const detalhe = String(msg.message ?? msg.code ?? '').trim();
        setFalha(detalhe || 'a resposta falhou no servidor');
        return;
      }

      if (msg.type === 'tool_result') {
        if (!msg.ok) {
          // Ferramenta que falha calada é ação que o usuário acha que aconteceu.
          const motivo = String(msg.error ?? '').trim() || 'a ferramenta não respondeu';
          setBolhas((prev) => anexar(prev, (b) => ({ ...b, erroFerramenta: motivo })));
          return;
        }
        const meta = (msg.metadata ?? null) as Record<string, unknown> | null;
        if (!meta) return;
        const tarefas = tarefasDe(meta.task);
        const orcamento = orcamentoDe(meta.dashboard_data);
        if (!tarefas.length && !orcamento) return;
        setBolhas((prev) => anexar(prev, (b) => ({
          ...b,
          tarefas: tarefas.length ? [...(b.tarefas ?? []), ...tarefas] : b.tarefas,
          orcamento: orcamento ?? b.orcamento,
        })));
      }
    });
  }, [ws]);

  // Rola para a última bolha. `scrollIntoView` não existe no jsdom, daí o guarda.
  useEffect(() => { fimRef.current?.scrollIntoView?.({ block: 'end' }); }, [bolhas]);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    const texto = rascunho.trim();
    if (!texto || !ws) return;
    setBolhas((prev) => [...prev, { id: `voce-${prev.length}-${Date.now()}`, autor: 'voce', texto }]);
    setFalha(null);
    setRascunho('');
    ws.send({
      type: 'user_message',
      conversation_id: conversaRef.current,
      content: texto,
      speak,
    });
  };

  // A conversa espera pelas duas pontas: o socket que ainda vai nascer e o
  // transcrito que ainda vai voltar.
  const carregando = (!ws && !desistiu) || restaurando;

  return (
    <div className={`ms-chat${onBack ? ' ms-chat--empurrada' : ''}`}>
      <header className="ms-chat__head">
        {/* O Chat é aba E alvo de push (as Finanças o abrem). No ramo empurrado
            o shell não monta tab bar e o `PushedScreen` não desenha chrome, então
            sem esta seta a tela é beco sem saída. Na aba ela não existe: quem
            tira dali é a tab bar, e o handoff não desenha volta nenhuma.
            `onBack` só chega no ramo empurrado — é o que separa os dois. */}
        {onBack && (
          <button type="button" className="ms-chat__voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <Orb size={38} halo />
        <div className="ms-chat__quem">
          <p className="ms-chat__nome">Seraphine</p>
          {carregando
            ? <Skel linhas={1} />
            : status === 'connected'
              ? (
                <p className="ms-chat__presenca">
                  <span className="ms-chat__ponto" aria-hidden="true" />
                  ouvindo &ldquo;oi Sera&rdquo;
                </p>
              )
              : <Erro>sem conexão</Erro>}
        </div>
        <button
          type="button"
          className={`ms-chat__ajuste${speak ? ' ms-chat__ajuste--on' : ''}`}
          aria-label="Respostas faladas"
          aria-pressed={speak}
          onClick={() => setSpeak(!speak)}
        >
          <VolumeIcon size={17} />
        </button>
      </header>

      <div className="ms-chat__thread">
        <div className="ms-chat__dia">
          <span className="ms-chat__dia-linha" aria-hidden="true" />
          <span className="ms-chat__dia-rotulo">Hoje</span>
          <span className="ms-chat__dia-linha" aria-hidden="true" />
        </div>

        {/* O esqueleto só cobre o VAZIO da espera. Havendo bolha — a que o
            usuário acabou de mandar, inclusive — ela aparece na hora: o
            composer aceita texto durante o restauro, e ver a própria mensagem
            sumir é pior do que esperar. */}
        {carregando && !bolhas.length && <Skel linhas={3} />}

        {!carregando && falhaHistorico && <Erro>Não consegui carregar a conversa anterior.</Erro>}

        {bolhas.map((b) => {
          // A limpeza existe para a marcação que ELA emite. O que o usuário
          // digitou vai para a tela como foi digitado, colchetes e tudo.
          if (b.autor === 'voce') {
            return (
              <div key={b.id} className="ms-chat-linha ms-chat-linha--voce">
                <div className="ms-chat-bolha ms-chat-bolha--voce">{b.texto}</div>
              </div>
            );
          }
          const texto = limpar(b.texto);
          return (
            <div key={b.id} className="ms-chat-linha ms-chat-linha--sera">
              <span className="ms-chat-avatar" aria-hidden="true"><SparkleIcon size={13} /></span>
              <div className={`ms-chat-bolha ms-chat-bolha--sera${b.streaming ? ' ms-chat-bolha--vindo' : ''}`}>
                {texto && <p className="ms-chat-bolha__texto">{texto}</p>}
                {(b.tarefas ?? []).map((t) => <CardDeTarefa key={t.id} tarefa={t} />)}
                {b.orcamento && <BarraDeOrcamento orcamento={b.orcamento} />}
                {b.erroFerramenta && <Erro>Uma ação falhou: {b.erroFerramenta}.</Erro>}
              </div>
            </div>
          );
        })}

        {!carregando && !bolhas.length && !falha && !desistiu && !falhaHistorico && (
          <Vazio>Ainda não trocamos nenhuma mensagem hoje — me diga o que você precisa.</Vazio>
        )}
        {desistiu && <Erro>Não consegui abrir a conversa com a Seraphine.</Erro>}
        {falha && <Erro>Não consegui responder: {falha}.</Erro>}
        <div ref={fimRef} />
      </div>

      <form className="ms-chat__composer" onSubmit={enviar}>
        <div className="ms-chat__pill">
          <input
            className="ms-chat__campo"
            placeholder="Mensagem…"
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            enterKeyHint="send"
            autoComplete="off"
            disabled={!ws}
          />
          <button
            type="button"
            className="ms-chat__mic"
            aria-label="Falar por voz"
            onClick={() => onOpen?.({ key: 'voz', title: 'Voz' })}
          >
            <MicIcon size={19} />
          </button>
          <button type="submit" className="ms-chat__enviar" aria-label="Enviar" disabled={!ws}>
            <SendIcon size={17} />
          </button>
        </div>
      </form>
    </div>
  );
}

/** Linha de "não há nada": diz o que falta, em vez de deixar o vão em branco. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-chat-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser lida como vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-chat-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pisca uma frase errada antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-chat-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function CardDeTarefa({ tarefa }: { tarefa: CardTarefa }) {
  const [feita, setFeita] = useState(false);
  const [erro, setErro] = useState(false);

  const concluir = async () => {
    setErro(false);
    setFeita(true);
    try {
      await updateTaskStatus(tarefa.id, 'completed');
    } catch {
      // Sem servidor não há conclusão: desfaz a marca otimista e diz o porquê.
      setFeita(false);
      setErro(true);
    }
  };

  return (
    <div className={`ms-chat-card${feita ? ' ms-chat-card--feita' : ''}`}>
      <span className="ms-chat-card__caixa" aria-hidden="true" />
      <div className="ms-chat-card__corpo">
        <p className="ms-chat-card__titulo">{tarefa.titulo}</p>
        <p className="ms-chat-card__quando">{tarefa.quando}</p>
        {erro && <Erro>Não consegui concluir a tarefa.</Erro>}
      </div>
      <button type="button" className="ms-chat-card__ok" onClick={concluir} disabled={feita}>
        {feita ? 'Concluída' : 'Concluir'}
      </button>
    </div>
  );
}

function BarraDeOrcamento({ orcamento }: { orcamento: Orcamento }) {
  const { usado, total, livre } = orcamento;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((usado / total) * 100))) : 0;
  return (
    <div className="ms-chat-orc">
      <div className="ms-chat-orc__trilho">
        <div className="ms-chat-orc__fill" style={{ width: `${pct}%` }} />
      </div>
      {total > 0
        ? (
          <div className="ms-chat-orc__legenda">
            <span className="ms-chat-orc__usado">{pct}% usado</span>
            {/* Mês estourado não tem nada "livre": o saldo negativo vira o
                quanto passou, e não um "R$ -340 livre". */}
            {livre >= 0
              ? <span className="ms-chat-orc__livre">{brl(livre)} livre</span>
              : <span className="ms-chat-orc__livre ms-chat-orc__livre--acima">{brl(-livre)} acima</span>}
          </div>
        )
        : <Vazio>Ainda não há receita lançada no mês para comparar.</Vazio>}
    </div>
  );
}

/**
 * Acha a bolha da Seraphine que deve receber o cartão.
 *
 * A que está sendo escrita agora; na falta dela, a ÚLTIMA da conversa, e só se
 * for dela — uma fala dela mais acima é de outro turno, e o cartão apareceria
 * acima da pergunta que o gerou.
 *
 * Se não houver alvo, abre bolha nova em vez de descartar. É o caso comum, não
 * a exceção: o engine corta o stream no primeiro pedaço que traz `tool_calls`
 * (`conversation/engine.py:1122`), então quando o modelo vai direto à
 * ferramenta o `tool_result` chega antes de qualquer `token`.
 */
function anexar(bolhas: Bolha[], mut: (b: Bolha) => Bolha): Bolha[] {
  let i = bolhas.findIndex((b) => b.streaming);
  const ultimo = bolhas.length - 1;
  if (i === -1 && ultimo >= 0 && bolhas[ultimo].autor === 'sera') i = ultimo;
  if (i === -1) {
    const nova: Bolha = { id: `cartao-${bolhas.length}-${Date.now()}`, autor: 'sera', texto: '', orfa: true };
    return [...bolhas, mut(nova)];
  }
  const next = bolhas.slice();
  next[i] = mut(next[i]);
  return next;
}

/** Um turno gravado vira bolha. `role` é `string` no contrato: só `user` é
 *  do usuário, o resto (hoje `assistant`) é fala dela. */
function deTurno(t: ConversationTurn): Bolha {
  const tarefas = tarefasGravadas(t.content);
  return {
    id: t.id,
    autor: t.role === 'user' ? 'voce' : 'sera',
    texto: t.content,
    ...(tarefas.length ? { tarefas } : {}),
  };
}

/** O backend grava o cartão de tarefa no próprio texto do turno, como
 *  comentário (`conversation/engine.py`), justamente para o frontend
 *  reconstruí-lo ao recarregar. Sem esta leitura o `limpar()` apagaria a
 *  marcação e o cartão sumiria calado do transcrito restaurado. */
const TASK_DATA_RE = /<!--task-data:(\{[\s\S]*?\})-->/g;

function tarefasGravadas(conteudo: string): CardTarefa[] {
  const achadas: CardTarefa[] = [];
  for (const m of conteudo.matchAll(TASK_DATA_RE)) {
    try {
      achadas.push(...tarefasDe(JSON.parse(m[1])));
    } catch {
      // Comentário corrompido: perde-se o cartão, não o turno.
    }
  }
  return achadas;
}

/** `metadata.task` chega como uma tarefa só ou como `{ tasks: [...] }`. */
function tarefasDe(meta: unknown): CardTarefa[] {
  if (typeof meta !== 'object' || meta === null) return [];
  const bruto = meta as Record<string, unknown>;
  const lista = Array.isArray(bruto.tasks) ? (bruto.tasks as Record<string, unknown>[]) : [bruto];
  return lista
    .filter((t) => typeof t.id === 'number' && typeof t.title === 'string' && t.title)
    .map((t) => ({
      id: t.id as number,
      titulo: t.title as string,
      quando: quandoDe(t.due_date, t.due_time),
    }));
}

function quandoDe(data: unknown, hora: unknown): string {
  const h = typeof hora === 'string' && hora ? hora : null;
  const d = typeof data === 'string' && data ? data : null;
  if (d && h) return `${diaCurto(d)} · ${h}`;
  if (h) return `Lembrete · ${h}`;
  if (d) return diaCurto(d);
  return 'Sem prazo';
}

/** `2026-07-31` → `31/07`. Sem `Date` de propósito: `new Date('YYYY-MM-DD')`
 *  é UTC e vira o dia anterior em fuso negativo. */
function diaCurto(iso: string): string {
  const [, mes, dia] = iso.split('-');
  return mes && dia ? `${dia}/${mes}` : iso;
}

/** `metadata.dashboard_data` do `get_financial_summary`: income / expenses / balance. */
function orcamentoDe(meta: unknown): Orcamento | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const bruto = meta as Record<string, unknown>;
  const total = Number(bruto.income ?? 0);
  const usado = Number(bruto.expenses ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(usado)) return null;
  const livre = Number.isFinite(Number(bruto.balance)) ? Number(bruto.balance) : total - usado;
  return { usado, total, livre };
}

const brl = (n: number) => `R$ ${Math.round(n).toLocaleString('pt-BR')}`;

/** Os tokens carregam marcações que só o avatar do desktop consome
 *  (`[happy]`, `[anim:acenar]`) e comentários de dado estruturado que já
 *  viraram cartão. Some com eles na hora de desenhar — e não ao acumular,
 *  senão uma tag partida entre dois tokens nunca fecharia.
 *
 *  O `<!--card-->…<!--/card-->` precisa sair INTEIRO e antes dos outros: é
 *  HTML do dashboard do desktop gravado no turno, e tirar só os marcadores
 *  despejaria a marcação crua dentro da bolha. */
function limpar(texto: string): string {
  return texto
    .replace(/<!--card-->[\s\S]*?<!--\/card-->/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[anim:[a-z0-9_-]+\]/gi, '')
    .replace(/\[[a-zA-Z]+\]/g, '')
    .trim();
}
