import { useEffect, useState, type ReactNode } from 'react';
import { BellIcon, CalendarIcon, MicIcon, SparkleIcon } from '../../icons/Icons';
import { useRealtimeStore } from '../../stores/realtimeStore';
import type { ScreenProps } from './registry';
import './OnboardingPermissoesScreen.css';

/* Tela ONBOARDING · PERMISSÕES (handoff linha 615) — o último passo do primeiro
 * lançamento. Quem grava `seraphine.onboarding.done` é o `PhoneShell`, quando
 * o "Continuar" chama `props.onDone()`; esta tela não tem flag própria.
 *
 * Como o shell monta o onboarding FORA do `.mshell__content`, o CSS daqui é
 * dono do preenchimento, da rolagem e das safe areas.
 *
 * ── o que é ponte de verdade e o que não é ──────────────────────────────────
 *  microfone    o alvo iOS não registra comando Rust de microfone (o
 *               `mic::start_mic_capture` é só do desktop; o `lib.rs` diz, na
 *               letra, "mobile webviews handle audio natively"). A permissão
 *               REAL é a do WKWebView, com NSMicrophoneUsageDescription já no
 *               Info.plist: lê-se por `navigator.permissions` e pede-se por
 *               `getUserMedia` — o mesmo caminho que o modo de voz usa.
 *  notificações ponte real: `tauri_plugin_notification` está registrado no
 *               `run_mobile()` e `notification:default` está na capability
 *               `mobile`. Sem Tauri (navegador), cai na Notification API.
 *  calendário   NÃO EXISTE ponte. Nenhum comando, nenhum EventKit, e nem
 *               NSCalendarsUsageDescription no Info.plist. O cartão aparece
 *               com o botão desabilitado dizendo isso, porque um botão que não
 *               faz nada mente pior do que um botão apagado.
 *
 * Regra da onda: nada some. Cada permissão tem cinco saídas — lendo, pendente,
 * concedida, negada e indisponível — e negada LÊ como negada, nunca como
 * intocada.
 */

type Estado = 'lendo' | 'pendente' | 'concedido' | 'negado' | 'indisponivel';
type Chave = 'microfone' | 'notificacoes';

/** A frase que o classificador embarcado escuta de verdade
 *  (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`, limiar 0.92 validado):
 *  não é texto de UI, é contrato com o modelo. O handoff dizia "oi Sera", que
 *  não aciona nada — e esta tela é o primeiro contato com o recurso, onde a
 *  pessoa aprende o que dizer. Uma constante só porque os três usos abaixo
 *  incluem o `aria-label` do switch: se ele divergir do nome visível, o
 *  VoiceOver passa a ditar uma frase que ninguém mais vê para conferir. */
const FRASE_WAKE = 'Ei Seraphine';

/** Está dentro do shell Tauri? Mesmo teste que a ponte do HealthKit usa. */
function temTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

// ── microfone ───────────────────────────────────────────────────────────────

/** Lê sem pedir. O Safari/WKWebView não implementa `microphone` na Permissions
 *  API e lança — o que é "ainda não sei", não "negado": daí `pendente`. */
async function lerMicrofone(): Promise<Estado> {
  try {
    const query = navigator.permissions?.query;
    if (!query) return 'pendente';
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (st.state === 'granted') return 'concedido';
    if (st.state === 'denied') return 'negado';
    return 'pendente';
  } catch {
    return 'pendente';
  }
}

/** Pede de verdade: é o `getUserMedia` que faz o iOS mostrar o alerta. A faixa
 *  é solta em seguida — pedir permissão não pode deixar o microfone ligado. */
async function pedirMicrofone(): Promise<Estado> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) return 'indisponivel';
  try {
    const stream = await media.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'concedido';
  } catch {
    return 'negado';
  }
}

// ── notificações ────────────────────────────────────────────────────────────

/** O plugin só sabe dizer sim/não-ainda: `false` cobre tanto "nunca perguntei"
 *  quanto "o usuário negou". Sem como separar, vira `pendente` — e o pedido
 *  seguinte é que revela qual dos dois era. */
async function lerNotificacoes(): Promise<Estado> {
  if (temTauri()) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      return (await isPermissionGranted()) ? 'concedido' : 'pendente';
    } catch {
      /* sem o plugin, tenta o caminho do webview abaixo */
    }
  }
  if (typeof Notification === 'undefined') return 'indisponivel';
  if (Notification.permission === 'granted') return 'concedido';
  if (Notification.permission === 'denied') return 'negado';
  return 'pendente';
}

async function pedirNotificacoes(): Promise<Estado> {
  if (temTauri()) {
    try {
      const { requestPermission } = await import('@tauri-apps/plugin-notification');
      return traduzir(await requestPermission());
    } catch {
      /* idem */
    }
  }
  if (typeof Notification === 'undefined' || !Notification.requestPermission) return 'indisponivel';
  try {
    return traduzir(await Notification.requestPermission());
  } catch {
    return 'indisponivel';
  }
}

/** 'default' é o alerta dispensado sem escolha: continua pendente, não negado. */
function traduzir(r: string): Estado {
  if (r === 'granted') return 'concedido';
  if (r === 'denied') return 'negado';
  return 'pendente';
}

// ── tela ────────────────────────────────────────────────────────────────────

export function OnboardingPermissoesScreen({ onDone }: ScreenProps) {
  const [estados, setEstados] = useState<Record<Chave, Estado>>({
    microfone: 'lendo',
    notificacoes: 'lendo',
  });
  const [pedindo, setPedindo] = useState<Chave | null>(null);
  const wakeWord = useRealtimeStore((s) => s.wakeWordEnabled);
  const setWakeWord = useRealtimeStore((s) => s.setWakeWordEnabled);

  // Lê o que já está concedido: quem reinstala ou volta à tela não deve ser
  // convidado a permitir algo que já permitiu.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const [mic, notif] = await Promise.all([lerMicrofone(), lerNotificacoes()]);
      if (vivo) setEstados({ microfone: mic, notificacoes: notif });
    })();
    return () => { vivo = false; };
  }, []);

  const pedir = async (chave: Chave) => {
    setPedindo(chave);
    const novo = chave === 'microfone' ? await pedirMicrofone() : await pedirNotificacoes();
    setEstados((atual) => ({ ...atual, [chave]: novo }));
    setPedindo(null);
  };

  return (
    <div className="ms-onb-perm">
      <header className="ms-onb-perm-head">
        <h1 className="ms-onb-perm-titulo">Pra eu funcionar<br />de verdade</h1>
        <p className="ms-onb-perm-sub">Você controla tudo — dá pra mudar depois em Ajustes.</p>
      </header>

      <div className="ms-onb-perm-lista">
        <Cartao
          nome="Microfone"
          desc={`Pra conversa por voz e o "${FRASE_WAKE}"`}
          icone={<MicIcon size={21} />}
          tom="accent"
          estado={estados.microfone}
          pedindo={pedindo === 'microfone'}
          rotulo="Permitir microfone"
          onPedir={() => pedir('microfone')}
          negado="Você negou — dá pra liberar em Ajustes › Seraphine › Microfone."
          indisponivel="A captação de microfone não está disponível neste webview."
        />
        <Cartao
          nome="Notificações"
          desc="Lembretes e avisos proativos"
          icone={<BellIcon size={21} />}
          tom="ambar"
          estado={estados.notificacoes}
          pedindo={pedindo === 'notificacoes'}
          rotulo="Permitir notificações"
          onPedir={() => pedir('notificacoes')}
          negado="Você negou — dá pra liberar em Ajustes › Seraphine › Notificações."
          indisponivel="Este aparelho não expõe notificações para o app."
        />
        {/* Calendário: sem ponte nenhuma. Botão apagado e o motivo escrito —
            não há caminho neste componente que o leve a "Permitido". */}
        <Cartao
          nome="Calendário"
          desc="Ler e criar eventos por você"
          icone={<CalendarIcon size={21} />}
          tom="teal"
          estado="indisponivel"
          pedindo={false}
          rotulo="Permitir calendário"
          onPedir={() => {}}
          negado=""
          indisponivel="O app ainda não tem ponte com o Calendário do iPhone — sua agenda continua vindo do Google."
        />

        <div className="ms-onb-perm-cartao">
          <span className="ms-onb-perm-icone ms-onb-perm-icone--accent">
            <SparkleIcon size={21} />
          </span>
          <div className="ms-onb-perm-txt">
            <div className="ms-onb-perm-nome">{`Wake word "${FRASE_WAKE}"`}</div>
            <div className="ms-onb-perm-desc">Ativar por voz com o app aberto</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={wakeWord}
            aria-label={`Wake word "${FRASE_WAKE}"`}
            className={`ms-onb-perm-switch${wakeWord ? ' ms-onb-perm-switch--on' : ''}`}
            onClick={() => setWakeWord(!wakeWord)}
          >
            <span className="ms-onb-perm-switch__bola" />
          </button>
        </div>
      </div>

      <div className="ms-onb-perm-rodape">
        {/* Vale com tudo negado: o onboarding informa, não faz refém. */}
        <button type="button" className="ms-onb-perm-cta" onClick={() => onDone?.()}>
          Continuar
        </button>
      </div>
    </div>
  );
}

function Cartao({
  nome, desc, icone, tom, estado, pedindo, rotulo, onPedir, negado, indisponivel,
}: {
  nome: string;
  desc: string;
  icone: ReactNode;
  tom: 'accent' | 'ambar' | 'teal';
  estado: Estado;
  pedindo: boolean;
  rotulo: string;
  onPedir: () => void;
  negado: string;
  indisponivel: string;
}) {
  const aviso =
    estado === 'negado' ? { texto: negado, alerta: true }
      : estado === 'indisponivel' ? { texto: indisponivel, alerta: false }
        : null;

  return (
    <div className={`ms-onb-perm-cartao${estado === 'concedido' ? ' ms-onb-perm-cartao--ok' : ''}`}>
      <span className={`ms-onb-perm-icone ms-onb-perm-icone--${tom}`}>{icone}</span>
      <div className="ms-onb-perm-txt">
        <div className="ms-onb-perm-nome">{nome}</div>
        <div className="ms-onb-perm-desc">{desc}</div>
        {aviso && (
          <p
            className={`ms-onb-perm-aviso${aviso.alerta ? ' ms-onb-perm-aviso--negado' : ''}`}
            role={aviso.alerta ? 'alert' : 'status'}
          >
            {aviso.texto}
          </p>
        )}
      </div>
      <Controle
        estado={estado}
        pedindo={pedindo}
        rotulo={rotulo}
        onPedir={onPedir}
      />
    </div>
  );
}

/** O lado direito do cartão nunca fica vazio: cada estado tem sua forma. */
function Controle({ estado, pedindo, rotulo, onPedir }: {
  estado: Estado;
  pedindo: boolean;
  rotulo: string;
  onPedir: () => void;
}) {
  if (estado === 'lendo') {
    // esqueleto sem texto: nada de piscar "Permitido" antes de saber
    return <span className="ms-onb-perm-skel" aria-label="lendo a permissão" />;
  }
  if (estado === 'concedido') {
    return <span className="ms-onb-perm-pill ms-onb-perm-pill--ok">Permitido</span>;
  }
  if (estado === 'negado') {
    return <span className="ms-onb-perm-pill ms-onb-perm-pill--nao">Negado</span>;
  }
  return (
    <button
      type="button"
      className="ms-onb-perm-botao"
      aria-label={rotulo}
      disabled={estado === 'indisponivel' || pedindo}
      onClick={onPedir}
    >
      {pedindo ? 'Pedindo…' : 'Permitir'}
    </button>
  );
}
