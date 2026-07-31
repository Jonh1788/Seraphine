import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAppRefs } from '../../stores/RefsContext';
import { useChatStore } from '../../stores/chatStore';
import { Orb } from '../Orb';
import { MicIcon, SendIcon, SparkleIcon, VolumeIcon } from '../../icons/Icons';
import { updateTaskStatus } from '../../tasks/api';
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
}

export function ChatScreen({ onOpen }: ScreenProps) {
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
          if (i === -1) return [...prev, { id: turnId, autor: 'sera', texto, streaming: true }];
          const next = prev.slice();
          next[i] = { ...next[i], texto: next[i].texto + texto };
          return next;
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

      if (msg.type === 'tool_result' && msg.ok) {
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

  const carregando = !ws && !desistiu;

  return (
    <div className="ms-chat">
      <header className="ms-chat__head">
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

        {carregando && <Skel linhas={3} />}

        {!carregando && bolhas.map((b) => (
          b.autor === 'voce'
            ? (
              <div key={b.id} className="ms-chat-linha ms-chat-linha--voce">
                <div className="ms-chat-bolha ms-chat-bolha--voce">{limpar(b.texto)}</div>
              </div>
            )
            : (
              <div key={b.id} className="ms-chat-linha ms-chat-linha--sera">
                <span className="ms-chat-avatar" aria-hidden="true"><SparkleIcon size={13} /></span>
                <div className={`ms-chat-bolha ms-chat-bolha--sera${b.streaming ? ' ms-chat-bolha--vindo' : ''}`}>
                  <p className="ms-chat-bolha__texto">{limpar(b.texto)}</p>
                  {(b.tarefas ?? []).map((t) => <CardDeTarefa key={t.id} tarefa={t} />)}
                  {b.orcamento && <BarraDeOrcamento orcamento={b.orcamento} />}
                </div>
              </div>
            )
        ))}

        {!carregando && !bolhas.length && !falha && !desistiu && (
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
            <span className="ms-chat-orc__livre">{brl(livre)} livre</span>
          </div>
        )
        : <Vazio>Ainda não há receita lançada no mês para comparar.</Vazio>}
    </div>
  );
}

/** Acha a bolha da Seraphine que deve receber o cartão: a que está sendo
 *  escrita agora e, na falta dela, a última que ela disse. */
function anexar(bolhas: Bolha[], mut: (b: Bolha) => Bolha): Bolha[] {
  let i = bolhas.findIndex((b) => b.streaming);
  if (i === -1) for (let k = bolhas.length - 1; k >= 0; k--) if (bolhas[k].autor === 'sera') { i = k; break; }
  if (i === -1) return bolhas;
  const next = bolhas.slice();
  next[i] = mut(next[i]);
  return next;
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
 *  senão uma tag partida entre dois tokens nunca fecharia. */
function limpar(texto: string): string {
  return texto
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[anim:[a-z0-9_-]+\]/gi, '')
    .replace(/\[[a-zA-Z]+\]/g, '')
    .trim();
}
