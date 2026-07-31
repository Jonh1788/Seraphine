import { useEffect, useState, type ReactNode } from 'react';
import { listInboxDetailed } from '../../inbox/api';
import type { InboxFilter, InboxItem, InboxSource, InboxSourceError } from '../../inbox/types';
import { ArrowLeftIcon, CheckIcon, InboxIcon, SparkleIcon, WhatsAppIcon } from '../../icons/Icons';
import type { ScreenProps } from './registry';
import './InboxScreen.css';

// A Inbox do celular é uma CAIXA DE MENSAGENS de duas fontes (Gmail importante
// + conversas do WhatsApp). Não é a `UnifiedInboxView` do desktop, que agrega
// seis fontes de domínio e não tem WhatsApp: são produtos diferentes sobre dados
// que se sobrepõem, e o handoff (linha 353) desenha ESTE aqui — com o filtro
// Tudo / E-mail / WhatsApp.
//
// REGRA DA TELA (igual à do Hoje e à dos Hábitos): nenhum bloco devolve `null`.
// Cabeçalho, lista e card da Seraphine têm cada um as três saídas — dado, vazio
// desenhado e erro.
//
// E a regra específica desta tela: **falha parcial nunca é silêncio**. Por isso
// consumimos `listInboxDetailed`, que devolve `{items, errors}`: com o WhatsApp
// fora do ar, os e-mails continuam na tela E um aviso diz qual fonte caiu. O
// `listInbox` (que devolve só o array) esvaziaria metade da caixa sem sinal.

const FILTROS: { chave: InboxFilter; rotulo: string }[] = [
  { chave: 'all', rotulo: 'Tudo' },
  { chave: 'email', rotulo: 'E-mail' },
  { chave: 'whatsapp', rotulo: 'WhatsApp' },
];

const NOME_DA_FONTE: Record<InboxSource, string> = {
  email: 'o e-mail',
  whatsapp: 'o WhatsApp',
};

/** `InboxItem.id` só é único DENTRO da fonte (id do Gmail x id do chat): a
 *  chave da LISTA tem de carregar a fonte junto.
 *
 *  Atenção: isto é chave de render, não identificador de conversa. O `id` que
 *  vai no `onOpen` é o `item.id` cru — a thread chama `listWhatsAppMessages(id)`
 *  e engasgaria com um `whatsapp:` na frente. Só empurramos linha de WhatsApp,
 *  então a ambiguidade entre fontes não existe nesse caminho. */
function chave(item: InboxItem): string {
  return `${item.source}:${item.id}`;
}

/** O resultado de UMA carga, com o filtro a que ele pertence.
 *
 *  Guardar o filtro junto não é zelo: `pedidas` cai de 2 (Tudo) para 1 no mesmo
 *  quadro em que o chip muda, e a carga anterior só é substituída quando o fetch
 *  novo volta. Com `falhas` solto num state próprio, uma falha PARCIAL de "Tudo"
 *  virava falha TOTAL de "WhatsApp" — e a tela pintava "não consegui carregar
 *  sua inbox", com `role="alert"` junto, num quadro que o navegador chega a
 *  desenhar. Zerar dentro do efeito não resolve: efeito roda depois da pintura.
 *  Amarrado o resultado ao filtro, o quadro do meio deixa de existir — dado de
 *  um filtro nunca é lido sob outro; ele simplesmente ainda não chegou. */
interface Carga {
  filtro: InboxFilter;
  itens: InboxItem[] | null;
  falhas: InboxSourceError[];
  caiuTudo: boolean;
}

export function InboxScreen({ onBack, onOpen }: ScreenProps) {
  const [filtro, setFiltro] = useState<InboxFilter>('all');
  const [carga, setCarga] = useState<Carga | null>(null);
  // "Lido" local: a api da Inbox não expõe marcar-como-lido (nem no Gmail nem na
  // bridge), então o botão de check do cabeçalho apaga os pontos só nesta
  // sessão. Ver o relatório da task: falta endpoint, não é esquecimento.
  const [lidasAqui, setLidasAqui] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let vivo = true;
    listInboxDetailed(filtro)
      .then((res) => {
        if (!vivo) return;
        setCarga({ filtro, itens: res.items, falhas: res.errors, caiuTudo: false });
      })
      .catch(() => {
        if (!vivo) return;
        setCarga({ filtro, itens: null, falhas: [], caiuTudo: true });
      });
    return () => { vivo = false; };
  }, [filtro]);

  // Carga de outro filtro é carga que ainda não chegou: some inteira, e a tela
  // volta ao esqueleto em vez de misturar dado velho com pergunta nova.
  const atual = carga && carga.filtro === filtro ? carga : null;
  const carregando = atual === null;
  const falhas = atual?.falhas ?? [];
  const caiuTudo = atual?.caiuTudo ?? false;

  // O filtro também é aplicado aqui, e não só no argumento da api: a tela é dona
  // do que mostra, e uma fonte que devolvesse item alheio não vazaria para a
  // aba errada.
  const visiveis = (atual?.itens ?? []).filter((i) => filtro === 'all' || i.source === filtro);
  const naoLida = (i: InboxItem) => i.unread && !lidasAqui.has(chave(i));
  const quantasNaoLidas = visiveis.filter(naoLida).length;

  const pedidas = filtro === 'all' ? 2 : 1;
  const semFonte = caiuTudo || falhas.length >= pedidas;
  const nomesQueCairam = falhas.map((f) => NOME_DA_FONTE[f.source]).join(' e ');

  const marcarTudo = () =>
    setLidasAqui((antes) => new Set([...antes, ...visiveis.map(chave)]));

  // Oferta de resposta: a conversa não lida mais recente. Derivada do dado que
  // já está na tela — nada de inventar assunto que a Seraphine não leu.
  const paraResponder = visiveis.find((i) => i.source === 'whatsapp' && naoLida(i));

  return (
    <div className="ms-inbox">
      <header className="ms-inbox-head">
        {/* O shell não desenha mais chrome: a seta de voltar é da tela. Sem
            `onBack` não há para onde voltar, então o controle não aparece em vez
            de virar botão morto. */}
        {onBack && (
          <button type="button" className="ms-inbox-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-inbox-head-txt">
          <h1 className="ms-inbox-titulo">Inbox</h1>
          {carregando ? <Skel linhas={1} />
            : semFonte ? <Erro>Não consegui contar as não lidas.</Erro>
            : quantasNaoLidas ? (
              <p className="ms-inbox-sub">
                {quantasNaoLidas} {quantasNaoLidas === 1 ? 'não lida' : 'não lidas'}
              </p>
            )
            : <Vazio>tudo lido</Vazio>}
        </div>
        <button
          type="button"
          className="ms-inbox-tudo-lido"
          aria-label="Marcar tudo como lido"
          onClick={marcarTudo}
          disabled={quantasNaoLidas === 0}
        >
          <CheckIcon size={17} />
        </button>
      </header>

      <div className="ms-inbox-filtros" role="group" aria-label="Filtrar por canal">
        {FILTROS.map((f) => (
          <button
            key={f.chave}
            type="button"
            className={`ms-inbox-chip${filtro === f.chave ? ' ms-inbox-chip--on' : ''}`}
            aria-pressed={filtro === f.chave}
            onClick={() => setFiltro(f.chave)}
          >
            {f.rotulo}
          </button>
        ))}
      </div>

      <div className="ms-inbox-lista">
        {/* Falha parcial: os itens que chegaram ficam, e o aviso nomeia quem
            caiu. É a razão de esta tela usar `listInboxDetailed`. */}
        {!carregando && !semFonte && falhas.length > 0 && (
          <Erro>Não consegui carregar {nomesQueCairam} — o que está abaixo pode estar incompleto.</Erro>
        )}

        {carregando ? <SkelLinhas />
          : semFonte ? (
            <Erro>
              Não consegui carregar sua inbox
              {nomesQueCairam ? ` — ${falhas.length > 1 ? 'falharam' : 'falhou'} ${nomesQueCairam}` : ''}.
            </Erro>
          )
          : visiveis.length ? visiveis.map((item) => (
            <Linha
              key={chave(item)}
              item={item}
              naoLida={naoLida(item)}
              onAbrir={onOpen && item.source === 'whatsapp'
                ? () => onOpen({ key: 'whatsapp', title: nomeDe(item.sender), id: item.id })
                : undefined}
            />
          ))
          : <div className="ms-inbox-caixa"><Vazio>{fraseDeVazio(filtro)}</Vazio></div>}
      </div>

      <section className="ms-inbox-sugere">
        <span className="ms-inbox-sugere-icone"><SparkleIcon size={15} /></span>
        {carregando ? <Skel linhas={1} />
          : semFonte ? <Vazio>Sem a caixa carregada, não tenho o que sugerir.</Vazio>
          : paraResponder ? (
            <>
              <span className="ms-inbox-sugere-txt">
                Respondo a {nomeDe(paraResponder.sender)} por você?
              </span>
              <button
                type="button"
                className="ms-inbox-sim"
                onClick={() => onOpen?.({
                  key: 'whatsapp',
                  title: nomeDe(paraResponder.sender),
                  id: paraResponder.id,
                })}
              >
                Sim
              </button>
            </>
          )
          : <Vazio>Nada aguardando resposta agora.</Vazio>}
      </section>
    </div>
  );
}

function Linha({ item, naoLida, onAbrir }: {
  item: InboxItem;
  naoLida: boolean;
  onAbrir?: () => void;
}) {
  const nome = nomeDe(item.sender);
  const tinta = corDoAvatar(item, nome);
  const classe = `ms-inbox-row${naoLida ? '' : ' ms-inbox-row--lida'}`;
  const corpo = (
    <>
      <span className="ms-inbox-avatar" style={{ background: tinta.fundo, color: tinta.texto }}>
        {inicial(nome)}
      </span>
      <div className="ms-inbox-corpo">
        <div className="ms-inbox-topo">
          <span className={`ms-inbox-nome${naoLida ? ' ms-inbox-nome--nova' : ''}`}>{nome}</span>
          <span
            className={`ms-inbox-canal ms-inbox-canal--${item.source}`}
            role="img"
            aria-label={item.source === 'whatsapp' ? 'WhatsApp' : 'E-mail'}
          >
            {item.source === 'whatsapp' ? <WhatsAppIcon size={12} /> : <InboxIcon size={12} />}
          </span>
          <span className="ms-inbox-hora">{hora(item.at)}</span>
        </div>
        <p className="ms-inbox-previa">{item.preview || 'sem prévia'}</p>
      </div>
      {naoLida && <span className="ms-inbox-ponto" role="img" aria-label="não lida" />}
    </>
  );

  // Só a conversa do WhatsApp tem para onde abrir (a thread). O e-mail fica como
  // linha de leitura: um botão que não leva a lugar nenhum seria pior.
  if (!onAbrir) return <div className={classe}>{corpo}</div>;
  return (
    <button type="button" className={`${classe} ms-inbox-row--toque`} onClick={onAbrir}>
      {corpo}
    </button>
  );
}

/** Frase de vazio própria de cada filtro — dizer o que de fato não há. */
function fraseDeVazio(filtro: InboxFilter): string {
  if (filtro === 'email') return 'Nenhum e-mail importante esperando por você.';
  if (filtro === 'whatsapp') return 'Nenhuma conversa recente no WhatsApp.';
  return 'Caixa limpa — nenhum e-mail importante nem mensagem no WhatsApp.';
}

/** O `From` do Gmail chega como `Nome <email>`; a linha mostra só o nome. */
function nomeDe(sender: string): string {
  const s = (sender || '').trim();
  if (!s) return 'Sem remetente';
  const comAngulo = s.match(/^"?([^"<]*?)"?\s*<[^>]*>$/);
  if (comAngulo && comAngulo[1].trim()) return comAngulo[1].trim();
  const soEmail = s.match(/^<?([^<>@\s]+)@[^<>\s]+>?$/);
  if (soEmail) return soEmail[1];
  return s;
}

/** Primeira letra/dígito do nome, para o avatar do handoff. */
function inicial(nome: string): string {
  const m = nome.match(/\p{L}|\p{N}/u);
  return m ? m[0].toUpperCase() : '?';
}

// O handoff dá uma cor por remetente (verde do WhatsApp, azul, roxo). Sem cor no
// dado, o e-mail tira a sua do próprio nome — estável entre renders e recargas.
const VERDE_ZAP = { fundo: '#25d366', texto: '#0d0d11' };
const PALETA = [
  { fundo: '#42a5f5', texto: '#0d0d11' },
  { fundo: '#ab47bc', texto: '#ffffff' },
  { fundo: '#ff8a4c', texto: '#0d0d11' },
  { fundo: '#4ade80', texto: '#0d0d11' },
];

function corDoAvatar(item: InboxItem, nome: string): { fundo: string; texto: string } {
  if (item.source === 'whatsapp') return VERDE_ZAP;
  let h = 0;
  for (let i = 0; i < nome.length; i += 1) h = (h * 31 + nome.charCodeAt(i)) >>> 0;
  return PALETA[h % PALETA.length];
}

/** Hoje → HH:MM; outro dia → DD/MM; sem data legível → travessão (o slot da
 *  hora nunca fica vazio nem inventa um horário). */
function hora(at: string): string {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  const agora = new Date();
  const mesmoDia = d.getFullYear() === agora.getFullYear()
    && d.getMonth() === agora.getMonth()
    && d.getDate() === agora.getDate();
  const dois = (n: number) => String(n).padStart(2, '0');
  return mesmoDia
    ? `${dois(d.getHours())}:${dois(d.getMinutes())}`
    : `${dois(d.getDate())}/${dois(d.getMonth() + 1)}`;
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-inbox-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-inbox-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pode piscar "caixa limpa" antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-inbox-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SkelLinhas() {
  return (
    <div className="ms-inbox-skel-lista" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <span key={i} className="ms-inbox-skel-linha" />)}
    </div>
  );
}
