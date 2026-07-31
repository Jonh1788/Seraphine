import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, SendIcon, WhatsAppIcon } from '../../icons/Icons';
import { listWhatsAppMessages } from '../../inbox/api';
import type { WhatsAppMessage } from '../../inbox/types';
import type { ScreenProps } from './registry';
import './WhatsAppThreadScreen.css';

// Tela WHATSAPP · THREAD (handoff linha 463). Empurrada: o `PushedScreen` não
// desenha chrome nenhum, então o cabeçalho inteiro — a seta inclusive — é desta
// tela.
//
// REGRA DA TELA (igual à do Hoje, Memória e Inbox): nenhum bloco devolve `null`.
// Cabeçalho, thread e composer têm cada um as saídas dado / vazio / erro.
//
// TRÊS ELEMENTOS DO HANDOFF NÃO ESTÃO AQUI, e nenhum por esquecimento — cada um
// pediria inventar um estado que o dado não sustenta:
//
//  1. DUPLO-CHECK AZUL nas enviadas. O bridge nunca manda `ack`:
//     services/whatsapp-bridge/src/routes/messages.ts mapeia só
//     id/body/timestamp/fromMe/author/type/hasMedia, e o token `ack` não existe
//     em services/whatsapp-bridge/src. Um check sempre aceso seria mentira
//     sobre a mensagem ter chegado. `WhatsAppMessage` já declara `ack?: number`
//     e `inbox/api.ts` repassa o campo quando ele vier: no dia em que o bridge
//     mandar, a tela ganha o recurso sem mudar de forma.
//
//  2. SELO "enviada pela Seraphine com sua aprovação". `fromMe` é true tanto
//     para o que você digitou no celular quanto para o que a Seraphine mandou
//     por você (`whatsapp_send_message` envia o texto cru, sem marca — ver
//     apps/seraphine/backend/seraphine/tools/whatsapp.py). O dado não separa os
//     dois, e um selo em toda mensagem enviada rotularia errado justamente as
//     que VOCÊ escreveu. Fica de fora até existir um marcador de autoria.
//
//  3. CARD DA SERAPHINE confirmando ação na agenda. Não há fonte: nenhuma api
//     liga uma ação de calendário a um chat, e a tela só pode consumir
//     `inbox/api.ts`. Card sem fonte é decoração fingindo de dado.
//
// E o "online" do cabeçalho é presença — o bridge não expõe presença nenhuma
// (nem rota, nem campo: `grep -rn "presence\|isOnline\|lastSeen"` no src do
// bridge não acha nada). Um "online" fixo mente pelo mesmo motivo que o
// duplo-check. O slot fica, com a única coisa verdadeira que a thread sabe
// dizer sobre atividade: quando foi a última mensagem.

export interface WhatsAppThreadProps extends ScreenProps {
  /** Id do chat na bridge (ex.: `5511999999999@c.us`). Sem ele não há conversa
   *  para abrir — ver a nota do relatório sobre o `PhoneShell` não repassar id
   *  nenhum às telas empurradas. */
  chatId?: string;
  /** Nome do contato para o cabeçalho. O histórico traz `chatName`, mas
   *  `inbox/api.ts` devolve só as mensagens; quem empurra a tela é quem sabe o
   *  nome. Sem ele, o cabeçalho mostra o número do próprio id. */
  contato?: string;
}

export function WhatsAppThreadScreen({ onBack, chatId, contato }: WhatsAppThreadProps) {
  const [mensagens, setMensagens] = useState<WhatsAppMessage[] | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(Boolean(chatId));

  useEffect(() => {
    if (!chatId) {
      setMensagens(null);
      setErro(false);
      setCarregando(false);
      return;
    }
    let vivo = true;
    setCarregando(true);
    listWhatsAppMessages(chatId)
      .then((m) => { if (vivo) { setMensagens(m); setErro(false); setCarregando(false); } })
      .catch(() => { if (vivo) { setMensagens(null); setErro(true); setCarregando(false); } });
    return () => { vivo = false; };
  }, [chatId]);

  const ordenadas = useMemo(() => emOrdemDeConversa(mensagens ?? []), [mensagens]);
  const nome = nomeDoContato(contato, chatId);
  const semConversa = !chatId;

  // Conversa abre no fim: o que interessa ao abrir é a última mensagem, não a
  // mais antiga do histórico. (Sem asserção no teste: o jsdom não tem layout,
  // `scrollHeight` é sempre 0 e `scrollTop` não guarda valor.)
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ordenadas]);

  return (
    <div className="ms-whatsapp">
      <header className="ms-whatsapp-head">
        {/* Sem `onBack` não há para onde voltar: o controle some em vez de
            virar botão morto (o `ScreenProps` deixa o callback opcional). */}
        {onBack && (
          <button type="button" className="ms-whatsapp-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <span className="ms-whatsapp-avatar" aria-hidden="true">{inicial(nome)}</span>
        <div className="ms-whatsapp-head-txt">
          <h1 className="ms-whatsapp-contato">{nome}</h1>
          {carregando ? <Skel />
            : semConversa ? <Vazio>conversa não identificada</Vazio>
            : erro ? <Vazio>sem histórico carregado</Vazio>
            : <p className="ms-whatsapp-sub">{atividade(ordenadas)}</p>}
        </div>
        <span className="ms-whatsapp-canal" role="img" aria-label="WhatsApp">
          <WhatsAppIcon size={17} />
        </span>
      </header>

      <div className="ms-whatsapp-thread" ref={thread}>
        {carregando ? <SkelBolhas />
          : semConversa ? (
            <Erro>
              Não consegui abrir a conversa: esta tela não recebeu qual conversa mostrar.
            </Erro>
          )
          : erro ? <Erro>Não consegui carregar esta conversa.</Erro>
          : ordenadas.length ? ordenadas.map((m, i) => (
            <Bolha key={m.id || `sem-id-${i}`} msg={m} />
          ))
          : <Vazio>Nenhuma mensagem nesta conversa ainda — quando chegar uma, ela aparece aqui.</Vazio>}
      </div>

      {/* Composer do handoff. Desligado, e dizendo por quê: nenhuma camada
          expõe envio ao app — o backend proxia só GETs de status/qr/chats/
          messages (apps/seraphine/backend/seraphine/whatsapp/routes.py), e
          enviar hoje só acontece pela ferramenta do LLM. Botão que parece
          enviar e não envia é pior que botão desabilitado. */}
      <div className="ms-whatsapp-composer">
        <div className="ms-whatsapp-campo">
          <input
            type="text"
            className="ms-whatsapp-input"
            placeholder="Mensagem…"
            aria-label="Mensagem"
            aria-describedby="ms-whatsapp-nota"
            disabled
          />
          <button type="button" className="ms-whatsapp-enviar" aria-label="Enviar" disabled>
            <SendIcon size={17} />
          </button>
        </div>
        <p className="ms-whatsapp-nota" id="ms-whatsapp-nota">
          Ainda não dá para responder por aqui — o app só lê esta conversa.
        </p>
      </div>
    </div>
  );
}

/** Uma mensagem da thread. Recebida à esquerda em `--surface`, enviada à
 *  direita no verde do WhatsApp — e a diferença mora na CLASSE, não só na cor,
 *  para leitor de tela e teste distinguirem uma da outra. */
function Bolha({ msg }: { msg: WhatsAppMessage }) {
  const lado = msg.fromMe ? 'enviada' : 'recebida';
  return (
    <div className={`ms-whatsapp-msg ms-whatsapp-msg--${lado}`}>
      <div className={`ms-whatsapp-bolha ms-whatsapp-bolha--${lado}`}>
        {msg.body
          ? <p className="ms-whatsapp-corpo">{msg.body}</p>
          // Áudio, figurinha e imagem chegam com `body` vazio: dizer que não há
          // texto é honesto; sumir com a mensagem esconderia que ela existiu.
          : <p className="ms-whatsapp-corpo ms-whatsapp-corpo--sem-texto">sem texto (mídia)</p>}
        <span className="ms-whatsapp-hora">{hora(msg.at)}</span>
      </div>
    </div>
  );
}

/**
 * Ordem da conversa: as datadas em ordem crescente, as SEM data no fim.
 *
 * `inbox/api.ts` ordena por `at ? Date.parse(at) : 0` — o que manda a mensagem
 * sem data para o topo, ou seja, para a posição de "a mais antiga desta
 * conversa". O dado não diz isso: `at: ''` é data ausente, não data zero. Numa
 * thread o topo é uma afirmação cronológica, então a sem-data fica no fim, na
 * ordem em que a bridge a entregou, com a hora marcada como desconhecida.
 */
function emOrdemDeConversa(msgs: WhatsAppMessage[]): WhatsAppMessage[] {
  const datadas: WhatsAppMessage[] = [];
  const semData: WhatsAppMessage[] = [];
  for (const m of msgs) (quando(m) === null ? semData : datadas).push(m);
  datadas.sort((a, b) => (quando(a) as number) - (quando(b) as number));
  return [...datadas, ...semData];
}

/** Instante da mensagem, ou `null` quando não há data legível. */
function quando(m: WhatsAppMessage): number | null {
  if (!m.at) return null;
  const t = Date.parse(m.at);
  return Number.isNaN(t) ? null : t;
}

/** HH:MM; travessão quando não há data — o slot da hora nunca some nem inventa
 *  um horário. */
function hora(at: string): string {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

/** O que o cabeçalho pode dizer de verdade no lugar do "online" do handoff:
 *  quando foi a última mensagem. */
function atividade(msgs: WhatsAppMessage[]): string {
  if (!msgs.length) return 'sem mensagens ainda';
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const t = quando(msgs[i]);
    if (t === null) continue;
    const d = new Date(t);
    const agora = new Date();
    const mesmoDia = d.getFullYear() === agora.getFullYear()
      && d.getMonth() === agora.getMonth()
      && d.getDate() === agora.getDate();
    const dois = (n: number) => String(n).padStart(2, '0');
    return mesmoDia
      ? `última mensagem às ${dois(d.getHours())}:${dois(d.getMinutes())}`
      : `última mensagem em ${dois(d.getDate())}/${dois(d.getMonth() + 1)}`;
  }
  return `${msgs.length} ${msgs.length === 1 ? 'mensagem' : 'mensagens'}`;
}

/** Nome do contato; sem ele, o número que o id do chat carrega (`5511…@c.us`).
 *  Mostrar o número é feio, inventar um nome é pior. */
function nomeDoContato(contato: string | undefined, chatId: string | undefined): string {
  const nome = (contato || '').trim();
  if (nome) return nome;
  const id = (chatId || '').trim();
  if (!id) return 'Conversa';
  return id.split('@')[0] || id;
}

/** Primeira letra/dígito do nome, para o avatar verde do handoff. */
function inicial(nome: string): string {
  const m = nome.match(/\p{L}|\p{N}/u);
  return m ? m[0].toUpperCase() : '?';
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-whatsapp-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-whatsapp-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pode piscar "nenhuma mensagem" antes do dado chegar. */
function Skel() {
  return (
    <div className="ms-whatsapp-skel" aria-hidden="true">
      <span />
    </div>
  );
}

function SkelBolhas() {
  const lados = ['recebida', 'enviada', 'recebida', 'enviada'] as const;
  return (
    <div className="ms-whatsapp-skel-bolhas" aria-hidden="true">
      {lados.map((lado, i) => (
        <span key={i} className={`ms-whatsapp-skel-bolha ms-whatsapp-skel-bolha--${lado}`} />
      ))}
    </div>
  );
}
