import { useEffect, useRef, useState, type ReactNode } from 'react';
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
 * estado e manda comandos.
 *
 * O comando é um só, porque é o único que o controller expõe: a prop `active`.
 * Ela mora no `realtimeStore` — o MESMO interruptor que o wake word aciona
 * (`AppBootstrap` → `useWakeWord.onDetect` → `setRealtimeActive(true)`), então
 * abrir esta tela e dizer "ei Seraphine" levam ao mesmo lugar. O controller é
 * montado escondido, como o `AvatarCompanion` já fazia: ele desenha o palco do
 * desktop, que aqui daria uma segunda tela por cima da nossa.
 *
 * O texto vem do WebSocket compartilhado (`useAppRefs().wsRef`), a mesma fonte
 * que o controller lê — não de dentro dele, que não publica estado.
 *
 * REGRA DA ONDA: nada some por falta de dado e nada devolve `null`. Aqui os
 * três estados que importam são conectar, ouvir sem ninguém ter falado ainda e
 * a sessão não abrir — cada um se lê como ele mesmo, nunca como tela travada.
 */

const CONV_KEY = 'seraphine_conversation_id';
/** O socket nasce em milissegundos; 40 tentativas de 100ms = 4s antes de desistir. */
const TENTATIVAS = 40;

/** Os atrasos do handoff, na ordem — é o escalonamento que faz a onda ondular
 *  em vez de as oito barras pularem em bloco. */
const ATRASOS = [0, 0.12, 0.25, 0.4, 0.18, 0.32, 0.08, 0.22];

export function VozScreen({ onBack }: ScreenProps) {
  const { wsRef, playbackRef } = useAppRefs();
  const setRealtimeActive = useRealtimeStore((s) => s.setRealtimeActive);
  const manualMute = useRealtimeStore((s) => s.manualMute);
  const toggleManualMute = useRealtimeStore((s) => s.toggleManualMute);
  const speak = useChatStore((s) => s.speak);
  const think = useChatStore((s) => s.think);

  const [ws, setWs] = useState<SeraphineWS | null>(() => wsRef.current);
  const [desistiu, setDesistiu] = useState(false);
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

  // O `AppBootstrap` cria o socket de forma assíncrona. Enquanto ele não vem, a
  // tela fica em esqueleto; se nunca vier, vira erro desenhado — um esqueleto
  // eterno seria a mesma tela travada, só que cinza.
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

  const conectando = !ws && !desistiu;
  const aoVivo = !!ws && !encerrada;

  // O relógio da sessão só anda com ela de pé — um timer correndo numa sessão
  // que não abriu mentiria sobre estar gravando.
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

  const estado = desistiu
    ? { classe: 'ms-voz__pill--erro', rotulo: 'sem conexão' }
    : encerrada
      ? { classe: 'ms-voz__pill--fim', rotulo: 'sessão encerrada' }
      : conectando
        ? { classe: 'ms-voz__pill--espera', rotulo: 'conectando' }
        : { classe: 'ms-voz__pill--vivo', rotulo: 'ao vivo' };

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
          {conectando
            ? <Skel />
            : desistiu
              ? <Erro>Não consegui abrir a sessão de voz — o app não falou com a Seraphine.</Erro>
              : (
                <>
                  <p className={`ms-voz__resposta${resposta ? '' : ' ms-voz__resposta--vazia'}`}>
                    {resposta || (manualMute
                      ? 'Microfone no mudo — toque no microfone para voltar a falar.'
                      : encerrada
                        ? 'Conversa encerrada. Toque no microfone do chat para começar outra.'
                        : 'Estou ouvindo — fale quando quiser.')}
                  </p>
                  <p className={`ms-voz__ouvi${ouvi ? '' : ' ms-voz__ouvi--vazio'}`}>
                    {ouvi ? <>você disse · &ldquo;{ouvi}&rdquo;</> : 'você disse · ainda nada'}
                  </p>
                  {falha && <Erro>Não consegui responder: {falha}.</Erro>}
                </>
              )}
        </div>

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

        {/* O teclado do handoff é "prefiro digitar": no telefone o teclado mora
            no chat, de onde esta tela foi empurrada. Então ele faz o mesmo que
            o encerrar — para a sessão e volta —, e só o rótulo os separa. */}
        <button
          type="button"
          className="ms-voz__ctrl"
          onClick={encerrar}
          aria-label="Voltar para o teclado"
        >
          <TecladoIcon />
        </button>
      </footer>

      {/* O motor. Escondido porque ele desenha o palco do desktop — a mesma
          montagem invisível que o `AvatarCompanion` faz. `visibility: hidden`
          também o tira da árvore de acessibilidade, então o aviso de erro dele
          não vira um segundo `role="alert"` fantasma. */}
      <div className="ms-voz__motor" aria-hidden="true">
        {/* `playbackRef.current` lido no render é seguro aqui: o `AppBootstrap`
            cria o `PCMPlayback` ANTES do socket, então todo render em que `ws`
            existe já enxerga o playback. */}
        <RealtimeController
          ws={ws}
          playback={playbackRef.current}
          active={aoVivo}
          onToggle={encerrar}
          conversationId={conversa.current}
          speak={speak}
          think={think}
          manualMute={manualMute}
          onManualMuteToggle={toggleManualMute}
        />
      </div>
    </div>
  );
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
