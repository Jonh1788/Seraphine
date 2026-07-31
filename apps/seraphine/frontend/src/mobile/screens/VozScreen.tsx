import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppRefs } from '../../stores/RefsContext';
import { useChatStore } from '../../stores/chatStore';
import { useRealtimeStore } from '../../stores/realtimeStore';
import { RealtimeController } from '../../realtime';
import { Orb } from '../Orb';
import { MicIcon, XIcon } from '../../icons/Icons';
import type { SeraphineWS } from '../../ws/client';
import type { ScreenProps } from './registry';
import './VozScreen.css';

/**
 * Voz · realtime do telefone — handoff `Seraphine Mobile.dc.html`, linha 122.
 *
 * ESTA TELA NÃO É UM MOTOR DE VOZ. O motor é o `RealtimeController`, que já
 * existe e é dono do microfone, do VPIO (o audio unit da Apple que cancela o
 * eco), do VAD e do wake word. Nada disso se toca aqui: a tela desenha o
 * estado e manda comandos. O controller é montado escondido, como o
 * `AvatarCompanion` já fazia: ele desenha o palco do desktop, que aqui daria
 * uma segunda tela por cima da nossa.
 *
 * O texto vem do WebSocket compartilhado (`useAppRefs().wsRef`), a mesma fonte
 * que o controller lê — não de dentro dele, que não publica estado.
 *
 * ── DUAS VERDADES DIFERENTES, DOIS BOOLEANOS ──────────────────────────────
 *
 * Confundi-las era o defeito desta tela: ela afirmava sessão que nunca tinha
 * verificado. Com o backend fora do ar a pill dizia "ao vivo", o relógio
 * contava e a onda ondulava para sempre.
 *
 * - `sessaoLigada` é o COMANDO que vai ao motor (prop `active`). Vale enquanto
 *   a tela está aberta e a conversa não foi encerrada. É estado LOCAL desta
 *   tela — não vem do `realtimeStore`. A escrita em `setRealtimeActive` é
 *   efeito colateral de mão única: serve ao `AppBootstrap`, que cala o wake
 *   word enquanto a sessão está de pé, e nada é lido de volta daqui.
 *
 * - `aoVivo` é a AFIRMAÇÃO que a tela faz ao usuário. Exige conexão MEDIDA
 *   (`SeraphineWS.onStatus`, não a mera existência do objeto) e o microfone
 *   de pé. Pill, relógio e onda dependem só dela.
 *
 * Por que separados: o comando não pode piscar a cada oscilação da rede, ou o
 * VAD e o VPIO seriam derrubados e remontados a cada blip. Quem recua na
 * queda é a afirmação, não o comando.
 *
 * REGRA DA ONDA: nada some por falta de dado e nada devolve `null`.
 */

const CONV_KEY = 'seraphine_conversation_id';

/** Paciência antes de admitir que não há sessão. A mesma régua para os dois
 *  modos de falhar — o socket que nunca abriu e a queda que a reconexão
 *  silenciosa não recuperou (o cliente tenta em 1s, 2s, 5s; 4s cobre as duas
 *  primeiras tentativas). */
const ESPERA_MS = 4000;

/** O `AppBootstrap` cria o socket de forma assíncrona; a tela relê o ref. */
const PASSO_MS = 100;

/** A frase que a tela só tem o direito de dizer com sessão de verdade. */
const OUVINDO = 'Estou ouvindo — fale quando quiser.';

/** Os atrasos do handoff, na ordem — é o escalonamento que faz a onda ondular
 *  em vez de as oito barras pularem em bloco. */
const ATRASOS = [0, 0.12, 0.25, 0.4, 0.18, 0.32, 0.08, 0.22];

export function VozScreen({ onBack, onOpen }: ScreenProps) {
  const { wsRef, playbackRef } = useAppRefs();
  const setRealtimeActive = useRealtimeStore((s) => s.setRealtimeActive);
  const manualMute = useRealtimeStore((s) => s.manualMute);
  const toggleManualMute = useRealtimeStore((s) => s.toggleManualMute);
  const speak = useChatStore((s) => s.speak);
  const think = useChatStore((s) => s.think);

  const [ws, setWs] = useState<SeraphineWS | null>(() => wsRef.current);

  // Conexão medida, não objeto existindo. A semente vem do `chatStore` — que o
  // `AppBootstrap` mantém em dia — porque `onStatus` só fala em TRANSIÇÕES:
  // quem assina um socket já aberto não ouve nada e ficaria "conectando" para
  // sempre. Semente + assinatura é o par que o `ChatScreen` já usa.
  const jaAberto = () => useChatStore.getState().status === 'connected';
  const [conectado, setConectado] = useState(jaAberto);
  const [jaConectou, setJaConectou] = useState(jaAberto);
  const [desistiu, setDesistiu] = useState(false);
  /** Falha do motor ao subir o microfone, publicada pelo `onError` dele. */
  const [falhaMic, setFalhaMic] = useState<string | null>(null);
  /** O motor ESTOUROU no render (ver `MotorContido`). Diferente de `falhaMic`:
   *  ali o motor está de pé e recusa o microfone; aqui ele nem existe. */
  const [falhaMotor, setFalhaMotor] = useState<string | null>(null);

  const [encerrada, setEncerrada] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [ouvi, setOuvi] = useState('');
  const [resposta, setResposta] = useState('');
  const [falha, setFalha] = useState<string | null>(null);
  const turnoRef = useRef<string | null>(null);
  const conversa = useRef<string | undefined>(localStorage.getItem(CONV_KEY) || undefined);

  // Abrir a tela liga a sessão; sair desliga. Sem o desligar do retorno, trocar
  // de tela deixaria o microfone quente e o VPIO segurando o áudio do aparelho.
  useEffect(() => {
    setRealtimeActive(true);
    return () => setRealtimeActive(false);
  }, [setRealtimeActive]);

  // O socket nasce no `AppBootstrap`, de forma assíncrona. A tela relê o ref
  // até ele aparecer — e segue relendo enquanto estiver aberta, porque um
  // socket que chega tarde ainda serve. Quem declara a falha é o relógio de
  // paciência abaixo, não esta busca: contar tentativas de LER UM REF media
  // construção de objeto, que era justamente a régua errada.
  useEffect(() => {
    if (ws) return;
    const t = setInterval(() => {
      if (wsRef.current) setWs(wsRef.current);
    }, PASSO_MS);
    return () => clearInterval(t);
  }, [ws, wsRef]);

  // A ÚNICA fonte da afirmação "ao vivo".
  useEffect(() => {
    if (!ws) return;
    return ws.onStatus((s) => {
      const ligado = s === 'connected';
      setConectado(ligado);
      if (ligado) {
        setJaConectou(true);
        setDesistiu(false);
      }
    });
  }, [ws]);

  // Relógio de paciência: corre sempre que NÃO há conexão, e é rearmado a cada
  // queda. Uma reconexão silenciosa que demora vira aviso em vez de passar por
  // sessão contínua.
  useEffect(() => {
    if (conectado || encerrada) return;
    const t = window.setTimeout(() => setDesistiu(true), ESPERA_MS);
    return () => window.clearTimeout(t);
  }, [conectado, encerrada]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((raw) => {
      if (raw instanceof ArrayBuffer) return;
      const msg = raw as unknown as Record<string, unknown>;

      if (msg.type === 'transcription') {
        const texto = String(msg.text ?? '').trim();
        if (!texto) return;
        // Turno novo do usuário: a resposta anterior sai de cena junto, senão a
        // tela mostraria a fala nova sob a resposta velha.
        setOuvi(texto);
        setResposta('');
        setFalha(null);
        turnoRef.current = null;
        return;
      }

      if (msg.type === 'token') {
        const turno = String(msg.turn_id ?? '');
        const texto = String(msg.text ?? '');
        if (!conversa.current && typeof msg.conversation_id === 'string') {
          conversa.current = msg.conversation_id;
          localStorage.setItem(CONV_KEY, msg.conversation_id);
        }
        setFalha(null);
        setResposta((prev) => (turnoRef.current === turno ? prev + texto : texto));
        turnoRef.current = turno;
        return;
      }

      if (msg.type === 'error') {
        // Nunca vazio: um aviso em branco apagaria o próprio aviso.
        const detalhe = String(msg.message ?? msg.code ?? '').trim();
        setFalha(detalhe || 'a resposta falhou no servidor');
      }
    });
  }, [ws]);

  /** COMANDO ao motor. Firme através de oscilação de rede, de propósito —
   *  menos quando não há motor: mandar `active` para uma subárvore que estourou
   *  é pedir o estouro de novo a cada render. */
  const sessaoLigada = !!ws && !encerrada && !falhaMotor;

  /** AFIRMAÇÃO ao usuário. Nada aqui olha para a existência do objeto `ws`. */
  const aoVivo = conectado && !encerrada && !falhaMic && !falhaMotor;

  // O relógio da sessão só anda com ela de pé — um timer correndo numa sessão
  // que não abriu (ou que caiu) mentiria sobre estar gravando. Ele congela na
  // queda em vez de zerar: o tempo que houve, houve.
  useEffect(() => {
    if (!aoVivo) return;
    const id = window.setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [aoVivo]);

  /** Único comando de parada que o controller expõe: `active` volta a false.
   *  O `onBack` é opcional no `ScreenProps`; sem ele a tela não pode sair, e
   *  então ela mesma diz que acabou em vez de continuar fingindo estar ao vivo. */
  const encerrar = () => {
    setRealtimeActive(false);
    setEncerrada(true);
    onBack?.();
  };

  /** "Prefiro digitar": o teclado mora no chat, então o botão VAI ao chat, com
   *  o mesmo `onOpen` que o chat usa para vir até aqui. Sem rota para lá ele
   *  não finge — fica desabilitado (ver `temTeclado`) em vez de ser um segundo
   *  "encerrar" com outro rótulo. */
  const temTeclado = !!onOpen || !!onBack;
  const irParaOTeclado = () => {
    setRealtimeActive(false);
    setEncerrada(true);
    if (onOpen) {
      onOpen({ key: 'chat', title: 'Chat' });
      return;
    }
    onBack?.();
  };

  // "ao vivo" aparece se e somente se `aoVivo` — a pill não pode divergir da
  // afirmação que o resto da tela faz.
  const estado = aoVivo
    ? { classe: 'ms-voz__pill--vivo', rotulo: 'ao vivo' }
    : encerrada
      ? { classe: 'ms-voz__pill--fim', rotulo: 'sessão encerrada' }
      : falhaMotor
        ? { classe: 'ms-voz__pill--erro', rotulo: 'voz indisponível' }
        : falhaMic
        ? { classe: 'ms-voz__pill--erro', rotulo: 'sem microfone' }
        : desistiu
          ? { classe: 'ms-voz__pill--erro', rotulo: 'sem conexão' }
          : jaConectou
            ? { classe: 'ms-voz__pill--espera', rotulo: 'reconectando' }
            : { classe: 'ms-voz__pill--espera', rotulo: 'conectando' };

  /** Esqueleto só na PRIMEIRA espera. Depois de já ter conectado uma vez, uma
   *  queda mostra texto, não um cinza que se lê como carregando. */
  const primeiraEspera = !jaConectou && !desistiu && !falhaMic && !falhaMotor && !encerrada;

  return (
    <div className="ms-voz">
      <header className="ms-voz__topo">
        <span className={`ms-voz__pill ${estado.classe}`}>
          <span className="ms-voz__ponto" aria-hidden="true" />
          {estado.rotulo}
        </span>
        <span className="ms-voz__timer">{mmss(segundos)}</span>
      </header>

      <div className="ms-voz__palco">
        <div className="ms-voz__orbe">
          {/* Dois anéis, o segundo meio ciclo atrás — o `ringPulse` é o
              keyframe global de `styles.css`, aqui só reaproveitado. */}
          <span className="ms-voz__anel" aria-hidden="true" />
          <span className="ms-voz__anel ms-voz__anel--2" aria-hidden="true" />
          <span className="ms-voz__brilho" aria-hidden="true" />
          <Orb size={158} float />
        </div>

        <div className="ms-voz__fala" aria-live="polite">
          {primeiraEspera
            ? <Skel />
            : (
              <>
                <p className={`ms-voz__resposta${resposta ? '' : ' ms-voz__resposta--vazia'}`}>
                  {resposta || frasePrincipal({
                    encerrada, falhaMotor: !!falhaMotor, falhaMic: !!falhaMic,
                    desistiu, jaConectou, conectado, manualMute,
                  })}
                </p>
                <p className={`ms-voz__ouvi${ouvi ? '' : ' ms-voz__ouvi--vazio'}`}>
                  {ouvi ? <>você disse · &ldquo;{ouvi}&rdquo;</> : 'você disse · ainda nada'}
                </p>
                {/* O motor grita a falha do microfone dentro da subárvore que
                    esta tela esconde; aqui ela é dita de novo, com a voz da
                    tela e com o passo que resolve. */}
                {!encerrada && falhaMotor && (
                  <Erro>
                    O motor de voz não subiu neste aparelho ({falhaMotor}). Use o teclado
                    do chat por enquanto.
                  </Erro>
                )}
                {!encerrada && !falhaMotor && falhaMic && (
                  <Erro>
                    Não consegui ligar o microfone. Verifique a permissão do microfone
                    para a Seraphine nos Ajustes do aparelho.
                  </Erro>
                )}
                {!encerrada && desistiu && (
                  <Erro>
                    {jaConectou
                      ? 'A conexão com a Seraphine caiu e não voltou.'
                      : 'Não consegui abrir a sessão de voz — o app não falou com a Seraphine.'}
                  </Erro>
                )}
                {falha && <Erro>Não consegui responder: {falha}.</Erro>}
              </>
            )}
        </div>

        {/* A onda é decoração honesta: ela ondula quando — e só quando — há
            sessão de verdade com microfone aberto. */}
        <div
          className={`ms-voz__onda${aoVivo && !manualMute ? '' : ' ms-voz__onda--mudo'}`}
          aria-hidden="true"
        >
          {ATRASOS.map((atraso, i) => (
            <span key={i} className="ms-voz__barra" style={{ animationDelay: `${atraso}s` }} />
          ))}
        </div>
      </div>

      <footer className="ms-voz__controles">
        <button
          type="button"
          className={`ms-voz__ctrl${manualMute ? ' ms-voz__ctrl--on' : ''}`}
          onClick={toggleManualMute}
          aria-pressed={manualMute}
          aria-label={manualMute ? 'Reativar o microfone' : 'Silenciar o microfone'}
        >
          {manualMute ? <MicMudoIcon /> : <MicIcon size={22} />}
        </button>

        <button
          type="button"
          className="ms-voz__fim"
          onClick={encerrar}
          aria-label="Encerrar a conversa por voz"
        >
          <XIcon size={26} />
        </button>

        <button
          type="button"
          className="ms-voz__ctrl"
          onClick={irParaOTeclado}
          disabled={!temTeclado}
          aria-label={temTeclado
            ? 'Voltar para o teclado do chat'
            : 'Teclado indisponível: não há chat para abrir a partir daqui'}
        >
          <TecladoIcon />
        </button>
      </footer>

      {/* O motor. Escondido porque ele desenha o palco do desktop — a mesma
          montagem invisível que o `AvatarCompanion` faz. `visibility: hidden`
          também o tira da árvore de acessibilidade, e é por isso que o
          `onError` existe: sem ele o aviso de microfone do controller morreria
          calado aqui dentro. */}
      <div className="ms-voz__motor" aria-hidden="true">
        {/* `playbackRef.current` lido no render é seguro aqui: o `AppBootstrap`
            cria o `PCMPlayback` ANTES do socket, então todo render em que `ws`
            existe já enxerga o playback. */}
        <MotorContido onQuebrou={setFalhaMotor}>
          <RealtimeController
            ws={ws}
            playback={playbackRef.current}
            active={sessaoLigada}
            onToggle={encerrar}
            conversationId={conversa.current}
            speak={speak}
            think={think}
            manualMute={manualMute}
            onManualMuteToggle={toggleManualMute}
            onError={setFalhaMic}
          />
        </MotorContido>
      </div>
    </div>
  );
}

/**
 * Cerca em volta do motor.
 *
 * O `RealtimeController` monta o `VrmAvatar`, que constrói um `WebGLRenderer`.
 * Onde a webview não entrega contexto WebGL — o simulador de iOS e o `tauri dev`
 * do Mac são dois lugares onde isso acontece hoje — o construtor estoura no
 * RENDER, e um estouro de render sobe até o boundary mais próximo: sem esta
 * cerca, o único acima é o de `main.tsx`, e o app INTEIRO virava a página
 * "Algo quebrou" — sem abas, sem volta. Tocar o microfone do chat derrubava a
 * Seraphine.
 *
 * Aqui a queda para no motor: a subárvore some, a tela continua de pé e diz que
 * a voz não subiu. Não conserta o WebGL e não finge que consertou — a tela
 * deixa de afirmar sessão (`aoVivo`) e manda usar o teclado.
 */
class MotorContido extends Component<{ onQuebrou: (m: string) => void; children: ReactNode }, { caiu: boolean }> {
  state = { caiu: false };

  static getDerivedStateFromError(): { caiu: boolean } {
    return { caiu: true };
  }

  componentDidCatch(erro: Error): void {
    console.error('[VozScreen] o motor de realtime estourou', erro);
    // Nunca vazio: um motivo em branco viraria um parêntese oco na tela.
    this.props.onQuebrou(erro.message?.trim() || 'motivo desconhecido');
  }

  render(): ReactNode {
    // Caído, NÃO remonta: o mesmo render estouraria de novo a cada quadro.
    return this.state.caiu ? null : this.props.children;
  }
}

/**
 * A linha grande, quando não há resposta para mostrar.
 *
 * A ordem é a das causas: o que o usuário fez, depois o que o aparelho negou,
 * depois o que a rede fez. O `OUVINDO` só é alcançável com sessão ligada,
 * microfone de pé e mudo desligado — nenhuma negativa contém essa frase, para
 * que "não está ouvindo" nunca possa ser lido como "está".
 */
function frasePrincipal(s: {
  encerrada: boolean;
  falhaMotor: boolean;
  falhaMic: boolean;
  desistiu: boolean;
  jaConectou: boolean;
  conectado: boolean;
  manualMute: boolean;
}): string {
  if (s.encerrada) return 'Conversa encerrada. Toque no microfone do chat para começar outra.';
  // Antes do microfone: sem motor não há microfone para negar nem para abrir.
  if (s.falhaMotor) return 'A voz não está disponível neste aparelho.';
  if (s.falhaMic) return 'O microfone não iniciou — sem ele não dá para te escutar.';
  if (s.desistiu) {
    return s.jaConectou
      ? 'A conexão caiu e não voltou — a sessão parou aqui.'
      : 'A sessão de voz não abriu — nada foi capturado.';
  }
  if (!s.conectado) return 'Sem conexão no momento — tentando voltar.';
  if (s.manualMute) return 'Microfone no mudo — toque no microfone para voltar a falar.';
  return OUVINDO;
}

/** Segundos → `mm:ss`, com os minutos crescendo além de 59 em vez de virarem. */
function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Linha de falha. Tinta de perigo para nunca ser lida como vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-voz-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pisca uma frase errada antes da sessão abrir. */
function Skel() {
  return (
    <div className="ms-voz-skel" aria-hidden="true">
      <span /><span />
    </div>
  );
}

/* Os dois glifos que o handoff usa e o `Icons.tsx` ainda não tem. Inline, como
   todo ícone do projeto — nunca emoji. */

function MicMudoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V6a3 3 0 0 0-5.94-.6" />
      <path d="M5 11a7 7 0 0 0 11.9 4.9M19 11v.5M12 18v3" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function TecladoIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10" />
    </svg>
  );
}
