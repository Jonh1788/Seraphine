import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppRefs } from '../../stores/RefsContext';
import { useChatStore } from '../../stores/chatStore';
import { useRealtimeStore } from '../../stores/realtimeStore';
import { Orb } from '../Orb';
import { ArrowLeftIcon, MicIcon, SendIcon, SparkleIcon, VolumeIcon } from '../../icons/Icons';
import { ChatVazioMiolo } from './ChatVazioScreen';
import { updateTaskStatus } from '../../tasks/api';
import { fetchConversationTurns } from '../../chat/api';
import { parseThinking } from '../../chat/thinking';
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
  /** HTML de cartão que o backend mandou pronto (`metadata.html_card`). */
  cartoes?: string[];
  /** Motivo da ferramenta que falhou neste turno. */
  erroFerramenta?: string;
  /** Bolha aberta por um `tool_result` que chegou antes de ela falar: o
   *  próximo turno de texto a adota, para o cartão e a frase ficarem juntos. */
  orfa?: boolean;
}

/**
 * O QUE ESTÁ ACONTECENDO AGORA, do envio até o `turn_end`.
 *
 * `pensando` é o que a tela pode afirmar quando o fio não diz mais nada;
 * `aprovacao` é o único caso em que o fio NOMEIA a ferramenta — ver
 * `rotuloDeFerramenta` e o comentário de `tool_request` no handler.
 */
type Trabalho =
  | { fase: 'pensando' }
  | { fase: 'aprovacao'; ferramenta: string };

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
  /** Turno aberto: mandou e o servidor ainda não fechou. Ver `enviarTexto`. */
  const [trabalho, setTrabalho] = useState<Trabalho | null>(null);
  const [rascunho, setRascunho] = useState('');
  // Restauro do transcrito: só há o que esperar se já existe conversa gravada.
  const [restaurando, setRestaurando] = useState(() => !!localStorage.getItem(CONV_KEY));
  const [falhaHistorico, setFalhaHistorico] = useState(false);
  const speak = useChatStore((s) => s.speak);
  const setSpeak = useChatStore((s) => s.setSpeak);
  // A frase do handoff ("ouvindo 'oi Sera'") afirma escuta passiva, que é uma
  // coisa DIFERENTE de socket aberto: quem escuta é o `useWakeWord`, que só roda
  // com `wakeWordEnabled` ligado (padrão desligado, `realtimeStore.ts:25`) e só
  // dentro do Tauri com o `whisper_transcribe_pcm` do Mac. No iPhone, portanto,
  // quase nunca. Conectada e ouvindo são dois estados, e a tela agora diz o que
  // sabe de cada um em vez de trocar um pelo outro.
  // A frase entre aspas também mudou: o handoff dizia "oi Sera", mas o
  // classificador embarcado (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`,
  // limiar 0.92) foi treinado em "Ei Seraphine". Ali a string é contrato com o
  // modelo, não texto livre — quem seguir a frase antiga fala e nada acontece.
  const escutando = useRealtimeStore((s) => s.wakeWordEnabled);
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
    return ws.onStatus((s) => {
      setStatus(s);
      // O backend CANCELA o turno quando o socket cai (`ws/routes.py`, ramo
      // `websocket.disconnect` → `turn_cancel_event.set()`), então não há mais
      // `turn_end` para esperar. Sem isto a tela ficaria "pensando…" para
      // sempre ao lado de um cabeçalho dizendo "sem conexão" — duas afirmações
      // contraditórias, e a mais visível seria a falsa.
      if (s === 'disconnected') setTrabalho(null);
    });
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((raw) => {
      if (raw instanceof ArrayBuffer) return;
      // Uma união de envelopes é chata de estreitar campo a campo; aqui só os
      // poucos que a tela desenha importam, e cada leitura já vem checada.
      const msg = raw as unknown as Record<string, unknown>;

      // O TURNO SÓ FECHA NO FIM. `turn_end` é único e sai depois de TUDO
      // (`conversation/engine.py:1430`): entre a primeira ferramenta e a
      // resposta ainda cabem rodadas inteiras de modelo e mais ferramentas.
      // A versão anterior desligava a espera no primeiro sinal — inclusive num
      // `tool_result` — e nos 30s medidos no aparelho (clima + aviso na casa) a
      // tela voltava a parecer ociosa depois dos primeiros 5.
      if (msg.type === 'turn_end' || msg.type === 'turn_cancelled' || msg.type === 'error') {
        setTrabalho(null);
      }

      // O ÚNICO QUADRO DO FIO QUE NOMEIA A FERRAMENTA. E ele não é "está
      // rodando": o engine só o emite para ferramenta com
      // `requires_confirmation` e fica parado esperando o sim
      // (`engine.py:1216`, `APPROVAL_TIMEOUT_SECONDS = 300`). O telefone não
      // tem painel de aprovação — quem tem é o desktop (`tools/ApprovalPanel`)
      // —, então dizer "criando o evento…" seria descrever um trabalho que não
      // começou. A tela diz o que é: parado, esperando aprovação.
      if (msg.type === 'tool_request') {
        setTrabalho({ fase: 'aprovacao', ferramenta: rotuloDeFerramenta(String(msg.tool ?? '')) });
        return;
      }

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
        // A ferramenta acabou; o TURNO não. Volta ao estado genérico em vez de
        // desligar a espera (e em vez de abrir uma espera nova onde não havia:
        // um `tool_result` de um turno que a tela não abriu — proativo, por
        // exemplo — não deve desenhar espera nenhuma).
        setTrabalho((t) => (t ? { fase: 'pensando' } : t));
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
        // O CARTÃO PRONTO SÓ ENTRA QUANDO NÃO HÁ DADO ESTRUTURADO. `task` e
        // `dashboard_data` já viram cartão DESTA tela, e o backend manda os dois
        // no mesmo `tool_result` (`tools/financial.py:236`): desenhar o HTML
        // junto seria a mesma informação duas vezes, uma delas sem o botão de
        // concluir. Mesma regra do desktop (`chat/ChatView.tsx:779`).
        const cartao = !tarefas.length && !orcamento
          ? cartaoDe(meta.html_card)
          : null;
        if (!tarefas.length && !orcamento && !cartao) return;
        setBolhas((prev) => anexar(prev, (b) => ({
          ...b,
          tarefas: tarefas.length ? [...(b.tarefas ?? []), ...tarefas] : b.tarefas,
          orcamento: orcamento ?? b.orcamento,
          cartoes: cartao ? [...(b.cartoes ?? []), cartao] : b.cartoes,
        })));
      }
    });
  }, [ws]);

  // Rola para a última bolha. `scrollIntoView` não existe no jsdom, daí o guarda.
  // Só havendo bolha: numa conversa vazia não existe "última", e rolar até o fim
  // empurrava o estado vazio para cima até cortar o orb no topo da conversa.
  useEffect(() => {
    if (!bolhas.length) return;
    fimRef.current?.scrollIntoView?.({ block: 'end' });
  }, [bolhas]);

  /**
   * Manda UM texto pelo socket. Existe separado do `enviar` do formulário
   * porque a primeira mensagem também pode vir de fora do composer: tocar numa
   * das quatro sugestões do estado vazio manda o texto da sugestão.
   *
   * Devolve se mandou: quem chama pelo composer só limpa o campo quando mandou,
   * senão um envio sem socket comeria o que a pessoa escreveu.
   */
  const enviarTexto = (bruto: string): boolean => {
    const texto = bruto.trim();
    if (!texto || !ws) return false;
    setBolhas((prev) => [...prev, { id: `voce-${prev.length}-${Date.now()}`, autor: 'voce', texto }]);
    setFalha(null);
    // ENTRE O ENVIO E O FIM DO TURNO A TELA FICAVA IDÊNTICA A OCIOSA.
    // Um turno que roda ferramentas leva DEZENAS de segundos (medido no
    // aparelho: ~30s para clima + aviso na casa), e nesse intervalo não há
    // bolha dela, nem cursor, nem nada. Quem está do outro lado conclui que a
    // pergunta se perdeu e pergunta de novo — foi assim que a conversa real
    // ficou com quatro falas do usuário seguidas, que pareciam turnos mortos e
    // não eram: a resposta veio, junta, no fim. Nenhum estado de bolha cobre
    // isto, porque a bolha dela só nasce com o primeiro token.
    setTrabalho({ fase: 'pensando' });
    ws.send({
      type: 'user_message',
      conversation_id: conversaRef.current,
      content: texto,
      speak,
    });
    return true;
  };

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    if (enviarTexto(rascunho)) setRascunho('');
  };

  // A conversa espera pelas duas pontas: o socket que ainda vai nascer e o
  // transcrito que ainda vai voltar.
  const carregando = (!ws && !desistiu) || restaurando;

  // Conversa nova de verdade: nada carregando, nada falhando e nenhuma bolha.
  // É a única situação em que o vazio do handoff (orb 88 + sugestões) aparece —
  // e nela `ws` já existe, porque `carregando` cobre o socket que ainda não
  // nasceu e `desistiu` cobre o que nunca nasceu. Por isso tocar numa sugestão
  // nunca cai no `return false` mudo do `enviarTexto`.
  const vazio = !carregando && !bolhas.length && !falha && !desistiu && !falhaHistorico;

  // ENQUANTO ELA ESCREVE, O CURSOR JÁ DIZ QUE ELA ESTÁ FALANDO: um "pensando…"
  // logo abaixo do texto que aparece seria uma segunda voz repetindo a
  // primeira. A exceção é a aprovação, que não é "ela está escrevendo" — é o
  // turno PARADO à espera de um sim, e isso precisa ser dito mesmo com texto na
  // tela (ela costuma dizer "deixa comigo!" e só então pedir a ferramenta).
  const escrevendo = bolhas.some((b) => b.streaming);
  const mostraTrabalho = !escrevendo || trabalho?.fase === 'aprovacao';

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
                  {escutando ? <>ouvindo &ldquo;Ei Seraphine&rdquo;</> : 'conectada'}
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
        {/* Separador de dia é rótulo de um grupo de mensagens: numa conversa que
            ainda não começou ele nomearia coisa nenhuma, e o handoff não o
            desenha no estado vazio (linha 647). */}
        {!vazio && (
          <div className="ms-chat__dia">
            <span className="ms-chat__dia-linha" aria-hidden="true" />
            <span className="ms-chat__dia-rotulo">Hoje</span>
            <span className="ms-chat__dia-linha" aria-hidden="true" />
          </div>
        )}

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
          // O RACIOCÍNIO NÃO É RESPOSTA. Sem esta separação o `<think>…</think>`
          // (e o `<|channel>thought` da Gemma) ia cru para a bolha: a pessoa lia
          // "O usuário quer saber a previsão…" antes da frase de verdade, com as
          // tags e tudo. O parser é o MESMO do desktop (`chat/thinking.ts`) —
          // dois parsers da mesma string divergem, e esta casa já pagou por isso.
          const { thinking, response, thinkingDone } = parseThinking(b.texto);
          const texto = limpar(response);
          const pensando = (thinking ?? '').trim();
          // A BOLHA VAZIA É UM TURNO PERDIDO, e ela existe de verdade: um turno
          // que só emite raciocínio (ou cuja resposta é só marcação que a
          // `limpar` come) fecha sem UMA palavra na tela. Na conversa isso
          // aparece como duas falas do usuário seguidas, sem resposta no meio —
          // o defeito lido como "a Seraphine ignorou a pergunta". Enquanto
          // streaming, vazio é espera; fechado, vazio é falha, e ela é dita.
          const mudo = !texto
            && !(b.tarefas ?? []).length
            && !(b.cartoes ?? []).length
            && !b.orcamento
            && !b.erroFerramenta
            && !b.streaming;
          return (
            <div key={b.id} className="ms-chat-linha ms-chat-linha--sera">
              <span className="ms-chat-avatar" aria-hidden="true"><SparkleIcon size={13} /></span>
              <div className={`ms-chat-bolha ms-chat-bolha--sera${b.streaming ? ' ms-chat-bolha--vindo' : ''}`}>
                {/* Enquanto o bloco não fechou, a bolha ficaria MUDA — o modelo
                    está pensando e nada saiu ainda. O aviso é o que separa
                    "pensando" de "travou"; fechado, ele some e dá lugar à
                    resposta (o telefone não tem espaço para a gaveta de
                    raciocínio que o desktop abre, e o handoff não a desenha). */}
                {pensando && !thinkingDone && !texto && (
                  <p className="ms-chat-bolha__pensando" role="status">pensando…</p>
                )}
                {texto && (
                  <div className="ms-chat-bolha__texto">
                    <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTES_MD}>{texto}</Markdown>
                  </div>
                )}
                {mudo && (
                  <p className="ms-chat-bolha__mudo" role="status">
                    {pensando
                      ? 'pensei, mas não cheguei a responder — pergunte de novo.'
                      : 'não veio resposta desta vez — pergunte de novo.'}
                  </p>
                )}
                {(b.cartoes ?? []).map((html, i) => <CartaoRico key={i} html={html} />)}
                {(b.tarefas ?? []).map((t) => <CardDeTarefa key={t.id} tarefa={t} />)}
                {b.orcamento && <BarraDeOrcamento orcamento={b.orcamento} />}
                {b.erroFerramenta && <Erro>Uma ação falhou: {b.erroFerramenta}.</Erro>}
              </div>
            </div>
          );
        })}

        {/* O TURNO EM ANDAMENTO, desenhado. Não é bolha de verdade — não tem id
            nem texto e some no `turn_end` —, mas ocupa o lugar dela para a
            conversa nunca parecer parada. Sem isto, mandar e esperar 30s é
            visualmente idêntico a não ter mandado nada. */}
        {trabalho && mostraTrabalho && (
          <div className="ms-chat-linha ms-chat-linha--sera">
            <span className="ms-chat-avatar" aria-hidden="true"><SparkleIcon size={13} /></span>
            <div className="ms-chat-bolha ms-chat-bolha--sera">
              <p className="ms-chat-bolha__pensando" role="status">
                {trabalho.fase === 'aprovacao'
                  ? `esperando sua aprovação para ${trabalho.ferramenta}…`
                  : 'pensando…'}
              </p>
            </div>
          </div>
        )}

        {/* O vazio do handoff (tela 19), embutido: orb de 88px, "Sobre o que a
            gente conversa primeiro?" e as quatro sugestões. Tocar numa manda o
            texto dela como primeira mensagem — antes disso as quatro eram
            botões mortos, porque nada montava a tela onde elas viviam.
            Só o MIOLO entra: o cabeçalho e o composer são os desta tela, que
            sabem se o socket está de pé. */}
        {vazio && <ChatVazioMiolo onSugestao={enviarTexto} />}
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

/* ── cartão que o backend manda pronto ────────────────────────────────────
   O cartão de clima do desktop NÃO é componente React: é HTML cru montado em
   `seraphine/tools/weather.py` (`build_weather_html`) e entregue em
   `metadata.html_card`, com as classes `rich-card*`. O mecanismo é geral —
   clima, finanças, saúde, água, hábitos, tarefas, trabalho e recorrentes usam o
   mesmo campo —, e o telefone descartava tudo.

   RENDERIZAR ISSO NÃO CONTRADIZ O `rehype-raw` RECUSADO NA BOLHA. A distinção é
   a ORIGEM, e não o formato: o markdown da bolha vem do MODELO, entrada que o
   conteúdo lido (e-mail, página, mensagem de terceiro) pode induzir; o
   `html_card` é montado pelo NOSSO backend, a partir da resposta de uma API.
   São confianças diferentes, e por isso os dois caminhos são separados: a bolha
   segue sem `rehype-raw`, este bloco não passa por markdown nenhum.

   O CANAL TEM CONTRATO, E O CONTRATO JÁ ESTÁ FURADO HOJE. `build_weather_html`
   interpola `city` por f-string, sem escape (`weather.py:316`), e `city` vem dos
   ARGS DO MODELO; `format_weather_card` é pior — interpola `city`,
   `current_description` e cada `forecast[].date`/`description`, todos escritos
   pelo modelo a partir do que ele leu na web. Um cartão "nosso" pode portanto
   carregar HTML do modelo lá dentro, e sem uma peneira a porta que a bolha
   fechou reabriria pelos fundos, vestida de cartão. Daí a lista branca abaixo. */

/** Tags que um cartão pode conter. Fora da lista, o elemento sai INTEIRO —
 *  com a subárvore, que é o que se quer para `<script>`. */
const CARTAO_TAGS = new Set([
  'DIV', 'SPAN', 'P', 'B', 'STRONG', 'EM', 'SMALL', 'UL', 'OL', 'LI', 'HR', 'BR',
  // Os ícones do backend são SVG inline (`tools/svg_icons.py`): a casa não usa
  // emoji, então uma lista que só pensasse em `div` apagaria todos eles.
  'SVG', 'G', 'PATH', 'POLYLINE', 'POLYGON', 'CIRCLE', 'LINE', 'RECT', 'ELLIPSE',
]);

/** Atributos de geometria/traço que os ícones precisam. Comparados em
 *  minúsculas porque o parser de HTML normaliza `viewBox` e amigos. */
const CARTAO_ATTRS_SVG = new Set([
  'xmlns', 'width', 'height', 'viewbox', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'd', 'points',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'transform',
]);

/**
 * Peneira o HTML do cartão contra a lista branca.
 *
 * `class` é o único atributo geral que sobrevive: é o que liga o cartão à folha
 * (`rich-card*`). `style` NÃO sobrevive — é vetor de injeção por si só
 * (`position:fixed;inset:0` vira sobreposição de tela cheia sobre a conversa), e
 * o único `style` que o backend emite é um `flex:1` que a folha do celular
 * devolve por seletor. Sem `href`/`src` não há navegação nem requisição; sem
 * `on*` não há execução.
 */
function sanearCartao(bruto: string): string {
  if (typeof DOMParser === 'undefined') return '';
  // `text/html` num documento inerte: o parser não executa nada e não busca
  // nada, mesmo antes da peneira.
  const doc = new DOMParser().parseFromString(`<div id="raiz">${bruto}</div>`, 'text/html');
  const raiz = doc.getElementById('raiz');
  if (!raiz) return '';
  podar(raiz, false);
  return raiz.innerHTML.trim();
}

function podar(no: Element, dentroDeSvg: boolean): void {
  for (const filho of Array.from(no.childNodes)) {
    // 3 = texto (passa), 1 = elemento (é examinado). Comentário e o resto saem:
    // um `<!--card-->` solto no meio não desenha nada e o `limpar()` do texto
    // já assume que eles não chegam à tela.
    if (filho.nodeType === 3) continue;
    if (filho.nodeType !== 1) { no.removeChild(filho); continue; }
    const el = filho as Element;
    const tag = el.tagName.toUpperCase();
    if (!CARTAO_TAGS.has(tag)) { no.removeChild(el); continue; }
    const svg = dentroDeSvg || tag === 'SVG';
    for (const attr of Array.from(el.attributes)) {
      const nome = attr.name.toLowerCase();
      if (nome === 'class') continue;
      if (svg && CARTAO_ATTRS_SVG.has(nome)) continue;
      el.removeAttribute(attr.name);
    }
    podar(el, svg);
  }
}

function CartaoRico({ html }: { html: string }) {
  const limpo = useMemo(() => sanearCartao(html), [html]);
  // Cartão que a peneira esvaziou não some calado: sumir é o modo de falha que
  // esta onda inteira existe para não repetir. Ele diz que chegou e não deu.
  if (!limpo) return <Vazio>Não consegui desenhar o cartão que veio com esta resposta.</Vazio>;
  return (
    <div
      className="ms-chat-cartao"
      // eslint-disable-next-line react/no-danger -- ver o bloco acima: origem
      // é o nosso backend e o conteúdo passou pela lista branca de `sanearCartao`.
      dangerouslySetInnerHTML={{ __html: limpo }}
    />
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
  const cartoes = cartoesGravados(t.content);
  return {
    id: t.id,
    autor: t.role === 'user' ? 'voce' : 'sera',
    texto: t.content,
    ...(tarefas.length ? { tarefas } : {}),
    ...(cartoes.length ? { cartoes } : {}),
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

/** O engine grava o `html_card` no próprio texto do turno
 *  (`conversation/engine.py:1300`), entre `<!--card-->` e `<!--/card-->`,
 *  justamente para o transcrito não perder o cartão. Sem esta leitura o
 *  `limpar()` apagaria o bloco e a conversa restaurada voltaria só com o texto —
 *  o mesmo buraco que `tarefasGravadas` já tapava do lado das tarefas. */
const CARD_RE = /<!--card-->([\s\S]*?)<!--\/card-->/g;

function cartoesGravados(conteudo: string): string[] {
  const achados: string[] = [];
  for (const m of conteudo.matchAll(CARD_RE)) {
    const html = m[1].trim();
    if (html) achados.push(html);
  }
  return achados;
}

/** Um `metadata.html_card` só vale se for string com conteúdo. */
function cartaoDe(meta: unknown): string | null {
  if (typeof meta !== 'string') return null;
  const html = meta.trim();
  return html ? html : null;
}

/**
 * Nome de ferramenta → frase em português.
 *
 * SÓ AS QUE PEDEM CONFIRMAÇÃO ESTÃO AQUI, e não por preguiça: `tool_request` é
 * o único quadro do fio que traz o nome, e o engine só o emite quando
 * `requires_confirmation` é verdadeiro. As ferramentas que fazem o turno demorar
 * — `weather_forecast`, `home_announce`, `web_search` — têm `False`, e o
 * `tool_result` delas não carrega campo `tool` nenhum
 * (`engine.py:476`, `ToolResultEvent`). Nomear "consultando o tempo…" hoje seria
 * inventar estado que o fio não entrega; registrado no relatório.
 *
 * Nome desconhecido cai no próprio nome do fio, e não numa frase genérica:
 * "esperando sua aprovação para ferramenta_nova" é feio e verdadeiro, e diz à
 * pessoa exatamente o que perguntar.
 */
const ROTULO_FERRAMENTA: Record<string, string> = {
  calendar_create_event: 'criar um evento na agenda',
  calendar_update_event: 'mudar um evento da agenda',
  calendar_delete_event: 'apagar um evento da agenda',
  calendar_bulk_delete_events: 'apagar vários eventos da agenda',
  gmail_send_message: 'enviar um e-mail',
  whatsapp_send_message: 'mandar uma mensagem no WhatsApp',
  whatsapp_send_voice: 'mandar um áudio no WhatsApp',
  wise_send_pix: 'fazer um Pix',
  delete_note: 'apagar uma nota',
  write_file: 'escrever um arquivo',
  edit_file: 'editar um arquivo',
  run_shell: 'rodar um comando no computador',
  osascript: 'controlar o Mac',
  shortcuts_run: 'rodar um atalho do Mac',
  browser_submit: 'enviar um formulário no navegador',
  browser_confirm_payment: 'confirmar um pagamento no navegador',
};

function rotuloDeFerramenta(nome: string): string {
  return ROTULO_FERRAMENTA[nome] ?? (nome || 'uma ferramenta');
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

/* ── markdown da bolha ─────────────────────────────────────────────────────
   A resposta SEMPRE foi markdown — o desktop a renderiza desde sempre. Aqui ela
   ia como texto puro, então `**hoje e dos próximos dias**` chegava ao olho com
   os asteriscos: a ênfase que o modelo pediu virava ruído.

   SEM `rehype-raw`, e isto é a decisão, não um detalhe: o conteúdo vem do
   MODELO. Com `rehype-raw`, uma `<div>` que ele escrevesse (por engano, por
   eco de um payload, ou porque alguém pediu) viraria marcação de verdade dentro
   da bolha. É o mesmo raciocínio da tela de Lição de teoria, e aqui pesa mais,
   porque lá o markdown vem de um campo gerado uma vez e aqui vem de cada turno.
   Sem o plugin, HTML cru sai como TEXTO — visível, inerte.

   `remark-gfm` entra porque é o que o desktop usa e é o que o modelo escreve:
   tabela, lista de tarefas, tachado. */
const COMPONENTES_MD = {
  // `p` com margem só ENTRE parágrafos: a bolha já tem o padding dela, e a
  // margem de topo do primeiro empurraria o texto para longe do avatar.
  p: ({ children }: { children?: ReactNode }) => <p className="ms-chat-md__p">{children}</p>,
  // Link em `_blank`: navegar a WKWebView para fora levaria o app inteiro
  // junto, e não há botão de voltar no telefone para trazê-lo de volta.
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a className="ms-chat-md__link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

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
