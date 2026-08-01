import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeftIcon,
  BellIcon,
  BrainIcon,
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  SparkleIcon,
  SystemIcon,
  VolumeIcon,
  WhatsAppIcon,
} from '../../icons/Icons';
import { getAuthStatus, startOAuth } from '../../google/api';
import type { GoogleAuthStatus } from '../../google/types';
import { listFacts } from '../../memory/api';
import { getNotificationSettings, setNotificationType } from '../../notifications/api';
import type { NotificationSettings } from '../../notifications/api';
import { getChatModel } from '../../research/api';
import { fetchWhatsappChats } from '../../whatsapp/api';
import { useChatStore } from '../../stores/chatStore';
import { useRealtimeStore } from '../../stores/realtimeStore';
import versaoDoApp from '../../../src-tauri/tauri.conf.json';
import type { ScreenProps } from './registry';
import './ConfiguracoesScreen.css';

/* Tela CONFIGURAÇÕES (handoff v3, frames "Configurações" A e B). No app é UMA
 * tela rolável; o handoff a parte em dois só porque o mockup tem 844px.
 *
 * ── A REGRA QUE DECIDIU O QUE ENTROU ────────────────────────────────────────
 * Um controle que não faz nada é pior que um ausente, porque promete. Cada
 * linha abaixo tem estado de verdade atrás dela; o que o mockup desenha e o
 * app não sustenta ficou de fora, e está listado no relatório da task:
 *
 *  Personalidade / "Calorosa"  não existe persona em lugar nenhum — nem no
 *                              backend, nem em store, nem em prompt exposto.
 *  Streak em risco             não existe nem no backend: `per_type_enabled`
 *                              não tem essa chave e `BASE_PRIORITY` não tem
 *                              esse tipo. Lembretes e Não perturbe, ao lado
 *                              dele no mockup, EXISTEM — o README os marcava
 *                              como proposta, mesmo erro que cometeu com
 *                              "Modelo" — e entraram pela camada nova
 *                              `notifications/api`.
 *  YouTube Music "Conectar"    não há vínculo de conta a estabelecer: a música
 *                              é dirigida por AppleScript no Chrome do Mac
 *                              (`tools/browser.py`). O botão não teria alvo.
 *  Apagar histórico            `/conversations` só expõe GET. Sem DELETE, o
 *                              botão vermelho seria o pior tipo de promessa.
 *  Perfil + "Sincronizado      não há nome de usuário nem carimbo de sincronia
 *  com o Mac · agora"          com o Mac (o backend roda em VPS). O slot só
 *                              entraria com timestamp real; não há um.
 *
 * ── três estados, sempre ────────────────────────────────────────────────────
 * Cada leitura remota (modelo, Google, ponte do WhatsApp, memória) tem lendo /
 * dado / erro. Lendo é esqueleto SEM texto — nada pode piscar "conectado"
 * antes de saber. As falhas se juntam num aviso só, com `role="alert"`; o que
 * cada linha diz de si mesma é `role="status"`, para o leitor de tela não
 * gritar quatro vezes a mesma queda de rede.
 */

/** A frase que o classificador embarcado escuta de verdade
 *  (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`, limiar 0.92 validado):
 *  não é texto de UI, é contrato com o modelo. O handoff diz "oi Sera", que não
 *  aciona nada — e Configurações é onde a pessoa volta para reler o que dizer.
 *  Uma constante só porque os dois usos abaixo são o nome visível e o
 *  `aria-label` do interruptor: se divergirem, o VoiceOver passa a ditar uma
 *  frase que ninguém mais vê para conferir. */
const FRASE_WAKE = 'Ei Seraphine';
const NOME_WAKE = `Wake word "${FRASE_WAKE}"`;

/** O que o backend chama de padrão em `GET /deepsearch/chat-model`. */
const MODELO_PADRAO = 'cliproxy';

/** `/memory/facts` devolve lista, não contagem. Este é o teto do pedido: com a
 *  resposta cheia, a tela diz "N+" em vez de afirmar um total que não viu. */
const TETO_FATOS = 200;

/** A chave que o backend usa para os lembretes com hora
 *  (`notifications/types.py`, `per_type_enabled`). "Streak em risco", ao lado
 *  dele no mockup, não tem chave nenhuma — por isso não está na tela. */
const TIPO_LEMBRETE = 'reminder_timed';

/** Versão real do app. O "2.4.0" do mockup é literal de desenho; a fonte é o
 *  `tauri.conf.json`, o mesmo arquivo de onde o bundle iOS tira a dele. */
const VERSAO = versaoDoApp.version;

/** "23:00" vira "23h"; "22:30" vira "22h30". `null` quando não dá para ler o
 *  horário — aí a tela diz que não há janela em vez de inventar uma. */
function hora(hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return min === 0 ? `${h}h` : `${h}h${m[2]}`;
}

/** A janela do "Não perturbe" como o handoff a escreve ("22h – 7h"), montada
 *  dos dois horários gravados. Meia janela não é janela: falhando um lado, a
 *  linha diz que não há. */
function janelaDeSilencio(s: NotificationSettings): string | null {
  const inicio = hora(s.quiet_hours_start);
  const fim = hora(s.quiet_hours_end);
  return inicio && fim ? `${inicio} \u2013 ${fim}` : null;
}

interface Leitura<T> {
  valor: T | null;
  erro: boolean;
  lendo: boolean;
}

const LENDO = { valor: null, erro: false, lendo: true } as const;

/** Está dentro do shell Tauri? Mesmo teste que o painel do Google usa. */
function temTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export function ConfiguracoesScreen({ onBack, onOpen }: ScreenProps) {
  const wakeWord = useRealtimeStore((s) => s.wakeWordEnabled);
  const setWakeWord = useRealtimeStore((s) => s.setWakeWordEnabled);
  const falar = useChatStore((s) => s.speak);
  const setFalar = useChatStore((s) => s.setSpeak);
  const pensar = useChatStore((s) => s.think);
  const setPensar = useChatStore((s) => s.setThink);

  const [modelo, setModelo] = useState<Leitura<string>>(LENDO);
  const [google, setGoogle] = useState<Leitura<GoogleAuthStatus>>(LENDO);
  const [ponte, setPonte] = useState<Leitura<boolean>>(LENDO);
  const [itens, setItens] = useState<Leitura<{ total: number; noTeto: boolean }>>(LENDO);
  const [notif, setNotif] = useState<Leitura<NotificationSettings>>(LENDO);
  const [salvandoNotif, setSalvandoNotif] = useState(false);
  const [erroSalvarNotif, setErroSalvarNotif] = useState(false);
  const [conectando, setConectando] = useState(false);

  const vivo = useRef(true);

  const ler = useCallback(() => {
    getChatModel()
      .then((r) => { if (vivo.current) setModelo({ valor: r.chat_model || MODELO_PADRAO, erro: false, lendo: false }); })
      .catch(() => { if (vivo.current) setModelo({ valor: null, erro: true, lendo: false }); });

    getNotificationSettings()
      .then((s) => { if (vivo.current) setNotif({ valor: s, erro: false, lendo: false }); })
      .catch(() => { if (vivo.current) setNotif({ valor: null, erro: true, lendo: false }); });

    getAuthStatus()
      .then((s) => { if (vivo.current) setGoogle({ valor: s, erro: false, lendo: false }); })
      .catch(() => { if (vivo.current) setGoogle({ valor: null, erro: true, lendo: false }); });

    // Não existe wrapper de domínio para `/whatsapp/status`; o que a camada de
    // api expõe é a lista de conversas, e ela só responde quando a ponte está
    // de pé e pareada (o backend devolve 503/502 nos outros casos). Então o
    // selo afirma o que a leitura de fato sustenta: a ponte respondeu. Lista
    // vazia continua sendo ponte de pé — o selo é sobre a conexão, não sobre
    // ter conversa.
    fetchWhatsappChats()
      .then(() => { if (vivo.current) setPonte({ valor: true, erro: false, lendo: false }); })
      .catch(() => { if (vivo.current) setPonte({ valor: null, erro: true, lendo: false }); });

    listFacts({ limit: TETO_FATOS })
      .then((f) => {
        if (!vivo.current) return;
        const ativos = f.filter((x) => !x.superseded_by);
        setItens({
          valor: { total: ativos.length, noTeto: f.length >= TETO_FATOS },
          erro: false,
          lendo: false,
        });
      })
      .catch(() => { if (vivo.current) setItens({ valor: null, erro: true, lendo: false }); });
  }, []);

  // O consentimento do Google acontece FORA do app (Safari / navegador do
  // sistema). Voltar para a Seraphine é o sinal de que vale reler — sem timer,
  // sem poll a vazar. O ouvinte morre com a tela.
  useEffect(() => {
    vivo.current = true;
    ler();
    const aoVoltar = (): void => ler();
    window.addEventListener('focus', aoVoltar);
    return () => {
      vivo.current = false;
      window.removeEventListener('focus', aoVoltar);
    };
  }, [ler]);

  // Otimista com volta atrás: o interruptor responde ao dedo na hora, mas se o
  // PATCH cair ele VOLTA. Um interruptor que fica ligado sem ter sido salvo é
  // a mentira mais cara desta tela — na próxima abertura ele estará como antes
  // e ninguém saberá por quê.
  const virarLembretes = useCallback(async (ligado: boolean) => {
    const antes = notif.valor;
    if (!antes) return;
    setErroSalvarNotif(false);
    setSalvandoNotif(true);
    setNotif({
      valor: { ...antes, per_type_enabled: { ...antes.per_type_enabled, [TIPO_LEMBRETE]: ligado } },
      erro: false,
      lendo: false,
    });
    try {
      // Quem sabe que `per_type_enabled` é SUBSTITUÍDO (e não mesclado) pelo
      // backend é a camada de api; a tela só pede para virar uma chave.
      const salvo = await setNotificationType(antes, TIPO_LEMBRETE, ligado);
      if (vivo.current) setNotif({ valor: salvo, erro: false, lendo: false });
    } catch {
      if (vivo.current) {
        setNotif({ valor: antes, erro: false, lendo: false });
        setErroSalvarNotif(true);
      }
    } finally {
      if (vivo.current) setSalvandoNotif(false);
    }
  }, [notif.valor]);

  const conectarGoogle = useCallback(async () => {
    setConectando(true);
    try {
      const { consent_url } = await startOAuth();
      // WKWebView bloqueia `window.open` calado; dentro do Tauri o plugin de
      // shell abre no navegador do sistema. Mesmo caminho do GoogleAuthPanel.
      if (temTauri()) {
        try {
          const { open } = await import('@tauri-apps/plugin-shell');
          await open(consent_url);
        } catch {
          window.open(consent_url, '_blank', 'noopener,noreferrer');
        }
      } else {
        window.open(consent_url, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // A falha vira estado de leitura: relê e o aviso de cima diz o que caiu.
      ler();
    } finally {
      if (vivo.current) setConectando(false);
    }
  }, [ler]);

  const falhas = [
    modelo.erro ? 'modelo' : '',
    notif.erro ? 'notificações' : '',
    google.erro ? 'Google Agenda' : '',
    ponte.erro ? 'WhatsApp' : '',
    itens.erro ? 'memória' : '',
  ].filter(Boolean);

  const rotuloModelo = modelo.valor === MODELO_PADRAO ? 'Padrão' : modelo.valor;
  const lembretes = notif.valor?.per_type_enabled[TIPO_LEMBRETE];
  const janela = notif.valor ? janelaDeSilencio(notif.valor) : null;

  return (
    <div className="ms-config">
      <header className="ms-config-head">
        {/* O shell não desenha chrome: a seta é da tela, e `onBack` é opcional
            no ScreenProps — sem para onde voltar, o controle não existe em vez
            de virar botão morto. O rótulo é o mesmo "Voltar" a que a regra de
            44pt do shell está presa. */}
        {onBack && (
          <button type="button" className="ms-config-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={20} />
          </button>
        )}
        <h1 className="ms-config-titulo">Configurações</h1>
      </header>

      <div className="ms-config-corpo">
        {/* UM aviso para todas as quedas: quatro leituras independentes gritando
            "alert" ao mesmo tempo é o que a onda anterior encontrou e proibiu. */}
        {falhas.length > 0 && (
          <p className="ms-config-aviso" role="alert">
            Não consegui verificar: {falhas.join(', ')}. O que é ajuste deste aparelho continua valendo.
          </p>
        )}

        <Grupo rotulo="ASSISTENTE">
          <Linha
            nome={NOME_WAKE}
            icone={<SparkleIcon size={16} />}
            tom="accent"
            controle={
              <Interruptor nome={NOME_WAKE} ligado={wakeWord} onMudar={setWakeWord} />
            }
          />
          <Divisoria />
          <Linha
            nome="Responder com voz"
            icone={<VolumeIcon size={16} />}
            tom="accent"
            controle={
              <Interruptor nome="Responder com voz" ligado={falar} onMudar={setFalar} />
            }
          />
          <Divisoria />
          <Linha
            nome="Pensar antes de responder"
            sub="respostas melhores, um pouco mais lentas"
            icone={<BrainIcon size={16} />}
            tom="accent"
            controle={
              <Interruptor nome="Pensar antes de responder" ligado={pensar} onMudar={setPensar} />
            }
          />
          <Divisoria />
          {/* A troca de modelo do chat JÁ é preferência global: o
              `settings/ChatModelPanel` grava em PUT /deepsearch/chat-model. O
              README do handoff a marca como proposta porque olhou só para o
              Research. Aqui a linha espelha o que existe e empurra o seletor. */}
          <Linha
            nome="Modelo"
            sub="cliproxy ou OpenRouter"
            icone={<SystemIcon size={16} />}
            tom="accent"
            aoAbrir={onOpen ? () => onOpen({ key: 'seletor-modelo', title: 'Modelo' }) : undefined}
            controle={
              modelo.lendo ? <Skel largura={54} />
                : modelo.erro ? <Status>não consegui verificar</Status>
                : <span className="ms-config-valor ms-config-valor--accent">{rotuloModelo}</span>
            }
          />
        </Grupo>

        <Grupo rotulo="NOTIFICAÇÕES">
          <Linha
            nome="Lembretes"
            subNo={erroSalvarNotif ? <Status>não consegui salvar</Status> : undefined}
            icone={<BellIcon size={16} />}
            tom="ambar"
            controle={
              notif.lendo ? <Skel largura={44} alto={26} />
                : notif.erro ? <Status>não consegui verificar</Status>
                : lembretes === undefined ? <Status>este backend não expõe este tipo</Status>
                : (
                  <Interruptor
                    nome="Lembretes"
                    ligado={lembretes}
                    desabilitado={salvandoNotif}
                    onMudar={(v) => void virarLembretes(v)}
                  />
                )
            }
          />
          <Divisoria />
          {/* Leitura, não controle: a janela é real (`quiet_hours_*`), mas não
              existe destino de edição no telefone — nenhum seletor de horário
              e nenhuma chave no registry. Por isso não tem chevron: chevron
              sem destino promete navegação que não acontece. Editar continua
              sendo do painel de desktop. */}
          <Linha
            nome="Não perturbe"
            icone={<ClockIcon size={16} />}
            tom="ambar"
            controle={
              notif.lendo ? <Skel largura={62} />
                : notif.erro ? <Status>não consegui verificar</Status>
                : janela ? <span className="ms-config-valor">{janela}</span>
                : <span className="ms-config-valor">não definido</span>
            }
          />
        </Grupo>

        <Grupo rotulo="CONEXÕES">
          <Linha
            nome="Google Agenda"
            sub={google.valor?.authed ? (google.valor.email ?? undefined) : undefined}
            icone={<CalendarIcon size={16} />}
            tom="teal"
            controle={
              google.lendo ? <Skel largura={62} />
                : google.erro ? <Status>não consegui verificar</Status>
                : google.valor?.authed ? <Selo>conectado</Selo>
                : (
                  <span className="ms-config-desconectado">
                    <span className="ms-config-valor">não conectado</span>
                    <button
                      type="button"
                      className="ms-config-botao"
                      aria-label="Conectar Google Agenda"
                      disabled={conectando}
                      onClick={() => void conectarGoogle()}
                    >
                      {conectando ? 'Abrindo…' : 'Conectar'}
                    </button>
                  </span>
                )
            }
          />
          <Divisoria />
          <Linha
            nome="WhatsApp"
            icone={<WhatsAppIcon size={16} />}
            tom="verde"
            controle={
              ponte.lendo ? <Skel largura={62} />
                : ponte.erro ? <Status>sem resposta da ponte</Status>
                : <Selo>conectado</Selo>
            }
          />
        </Grupo>

        <Grupo rotulo="DADOS">
          <Linha
            nome="Memória"
            icone={<BrainIcon size={16} />}
            tom="accent"
            subNo={
              itens.lendo ? <Skel largura={44} alto={9} />
                : itens.erro ? <Status>não consegui contar</Status>
                : itens.valor && itens.valor.total > 0
                  ? <span className="ms-config-sub">{itens.valor.noTeto ? `${itens.valor.total}+ itens` : `${itens.valor.total} ${itens.valor.total === 1 ? 'item' : 'itens'}`}</span>
                  : <span className="ms-config-sub">nenhum item guardado ainda</span>
            }
            aoAbrir={onOpen ? () => onOpen({ key: 'memoria', title: 'Memória' }) : undefined}
          />
        </Grupo>

        <p className="ms-config-versao">Seraphine {VERSAO}</p>
      </div>
    </div>
  );
}

// ── peças ───────────────────────────────────────────────────────────────────

function Grupo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <section className="ms-config-grupo">
      <h2 className="ms-config-grupo-rotulo">{rotulo}</h2>
      <div className="ms-config-card">{children}</div>
    </section>
  );
}

function Divisoria() {
  return <div className="ms-config-divisoria" aria-hidden="true" />;
}

/** Uma linha do cartão. Com `aoAbrir` ela é um `<button>` de linha inteira (o
 *  alvo passa de 44pt com folga) e ganha o chevron; sem ele é um `<div>` — sem
 *  chevron, porque chevron sem destino promete navegação que não acontece. */
function Linha({
  nome, sub, subNo, icone, tom, controle, aoAbrir,
}: {
  nome: string;
  sub?: string;
  /** Sub que não é texto puro (esqueleto, status, contagem). */
  subNo?: ReactNode;
  icone: ReactNode;
  tom: 'accent' | 'ambar' | 'teal' | 'verde';
  controle?: ReactNode;
  aoAbrir?: () => void;
}) {
  const miolo = (
    <>
      <span className={`ms-config-icone ms-config-icone--${tom}`}>{icone}</span>
      <span className="ms-config-txt">
        <span className="ms-config-nome">{nome}</span>
        {sub !== undefined && <span className="ms-config-sub">{sub}</span>}
        {subNo}
      </span>
      {controle}
    </>
  );

  if (aoAbrir) {
    return (
      <button type="button" className="ms-config-linha ms-config-linha--abre" onClick={aoAbrir}>
        {miolo}
        <ChevronRightIcon size={16} className="ms-config-chevron" />
      </button>
    );
  }
  return <div className="ms-config-linha">{miolo}</div>;
}

/** Interruptor 44×26 com bola de 22, como o handoff. O `aria-label` é o MESMO
 *  string do nome visível: é o que o VoiceOver dita, e divergir dele é dizer
 *  uma coisa na tela e outra no ouvido. */
function Interruptor({ nome, ligado, onMudar, desabilitado = false }: {
  nome: string;
  ligado: boolean;
  onMudar: (v: boolean) => void;
  /** Ligado enquanto um PATCH está em voo: evita a segunda batida virar o
   *  estado a partir de um valor que o backend ainda não confirmou. */
  desabilitado?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={ligado}
      aria-label={nome}
      disabled={desabilitado}
      className={`ms-config-switch${ligado ? ' ms-config-switch--on' : ''}`}
      onClick={() => onMudar(!ligado)}
    >
      <span className="ms-config-switch__bola" />
    </button>
  );
}

/** Selo verde do handoff: ponto de 6px em `--user` + a palavra. */
function Selo({ children }: { children: ReactNode }) {
  return (
    <span className="ms-config-selo">
      <span className="ms-config-ponto" aria-hidden="true" />
      {children}
    </span>
  );
}

/** O que uma linha diz sobre a própria falha. `status`, não `alert`: quem
 *  anuncia a queda é o aviso único do topo. */
function Status({ children }: { children: ReactNode }) {
  return <span className="ms-config-status" role="status">{children}</span>;
}

/** Espera sem texto: nada pode piscar um valor antes de saber qual é. */
function Skel({ largura, alto = 13 }: { largura: number; alto?: number }) {
  return (
    <span
      className="ms-config-skel"
      aria-hidden="true"
      style={{ width: largura, height: alto }}
    />
  );
}
