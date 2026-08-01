import { useEffect, useRef, useState } from 'react';
import { MobileSheet } from '../MobileSheet';
import { AlertTriangleIcon, CalendarIcon, ClockIcon, RepeatIcon, TargetIcon } from '../../icons/Icons';
import { ErroCriarEvento, criarEvento } from '../../calendar/api';
import './ModalEvento.css';

// MODAL DE EVENTO (handoff: frame "Modal · novo evento").
//
// O irmão (`ModalTarefa`) edita uma tarefa que já tem id, então salva sozinho a
// cada 800ms e não precisa de botão. Aqui é CRIAÇÃO: não existe id para dar
// PATCH, logo existe Cancelar e Salvar — e o defeito mais caro muda de lugar.
// Lá era o save silencioso; aqui é o SALVAR QUE FALHA E LEVA JUNTO o que a
// pessoa digitou. Um formulário de criação que se esvazia (ou se fecha) num erro
// obriga a redigitar tudo de cabeça. Daí, e é o que o teste prende:
//  - a falha NÃO fecha, NÃO limpa nada e aparece com `role="alert"` no rodapé,
//    que fica fora da área rolável por construção do `MobileSheet`, DIZENDO O
//    QUE ACONTECEU: é a mensagem da camada, não um "erro ao salvar" fixo —
//    senão "conecte o Google" e "esta categoria não existe no calendário"
//    virariam a mesma frase muda;
//  - "tentar de novo" reenvia o MESMO evento, sem a pessoa tocar em nada, e só
//    aparece quando repetir pode dar outro resultado (uma recusa da camada
//    devolveria o mesmo para sempre);
//  - Cancelar com o formulário sujo pergunta antes de jogar fora — e o backdrop
//    e o Escape passam pelo mesmo caminho, senão um toque torto no vidro
//    apagaria o formulário inteiro sem uma palavra;
//  - dois toques em Salvar criam UM evento (guarda em `ref`, não em estado: os
//    dois cliques caem no mesmo lote de render e um `useState` ainda estaria
//    velho no segundo).
//
// Não é tela de registry, de propósito: modal é sobreposição sobre a tela atual,
// não destino de navegação. O shell só repassa `id/onBack/onOpen/onDone`, então
// roteá-lo pela registry descartaria calado os callbacks daqui — inclusive o
// `criar`, que é justamente o que não pode sumir.
//
// TRÊS ESTADOS: esta tela não CARREGA nada (o formulário nasce dos padrões, não
// de uma requisição), então não há esqueleto — não existe instante em que ela
// saiba menos do que mostra. O "vazio" é o formulário em branco, e o teste
// afirma que ele não é um erro; o erro é o do salvamento e o da validação, numa
// região só.

export type Repeticao = 'nunca' | 'diario' | 'semanal' | 'mensal' | 'anual';
export type Calendario = 'agenda' | 'financas' | 'tarefas' | 'lembretes' | 'outros';

/** O evento que o Salvar entrega. `inicio`/`fim` são `YYYY-MM-DD` quando é dia
 *  inteiro e `YYYY-MM-DDTHH:MM` quando tem hora — a mesma distinção que o Google
 *  Calendar faz entre `date` e `dateTime`, para não inventar meia-noite. */
export interface NovoEvento {
  titulo: string;
  diaInteiro: boolean;
  inicio: string;
  fim: string;
  local: string;
  repetir: Repeticao;
  calendario: Calendario;
}

export interface ModalEventoProps {
  aberto: boolean;
  onFechar: () => void;
  /** Dia (YYYY-MM-DD) que a tela de origem tinha aberta. Sem ele, hoje. */
  dia?: string;
  /** Persiste o evento. Injetável para o teste; o padrão fala com a camada de
   *  api do domínio (ver `criarEventoViaApi` e a ressalva registrada lá). */
  criar?: (evento: NovoEvento) => Promise<void>;
  /** Criou de verdade — quem abriu costuma querer relistar o dia. */
  onCriado?: (evento: NovoEvento) => void;
}

// ── O ADAPTADOR PADRÃO ───────────────────────────────────────────────────────
// Encolheu para uma linha, como estava previsto: `calendar/api.ts` passou a
// expor `criarEvento`, que fala com `POST /google/calendar/events`. A tela
// continua sem `fetch` e sem regra de domínio — inclusive a mais escorregadia
// daqui, que é a categoria: um evento do Google não carrega categoria nenhuma,
// e quem sabe disso (e recusa) é a camada, não o formulário. `criar` segue
// injetável porque é o que deixa o teste exercitar falha e sucesso sem rede.
export async function criarEventoViaApi(evento: NovoEvento): Promise<void> {
  await criarEvento(evento);
}

/** Taxonomia REAL do calendário — conferida em `calendar/CalendarView.tsx:95`,
 *  onde `CATEGORY_COLORS` declara exatamente estes cinco pares. A ordem aqui é a
 *  do handoff (Agenda, Finanças, Tarefas, Lembretes, Outros), e o rótulo de
 *  finanças sai acentuado: o `CATEGORY_LABELS` de lá guarda "Financas" sem
 *  cedilha, coisa da tela de desktop; a chave — que é o que viaja no payload —
 *  continua `financas`. */
export const CALENDARIOS: { valor: Calendario; rotulo: string; cor: string }[] = [
  { valor: 'agenda', rotulo: 'Agenda', cor: '#42a5f5' },
  { valor: 'financas', rotulo: 'Finanças', cor: '#66bb6a' },
  { valor: 'tarefas', rotulo: 'Tarefas', cor: '#9a93ff' },
  { valor: 'lembretes', rotulo: 'Lembretes', cor: '#ffa726' },
  { valor: 'outros', rotulo: 'Outros', cor: '#78909c' },
];

export const REPETICOES: { valor: Repeticao; rotulo: string }[] = [
  { valor: 'nunca', rotulo: 'Nunca' },
  { valor: 'diario', rotulo: 'Todo dia' },
  { valor: 'semanal', rotulo: 'Toda semana' },
  { valor: 'mensal', rotulo: 'Todo mês' },
  { valor: 'anual', rotulo: 'Todo ano' },
];

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** `#rrggbb` + alfa → `rgba(...)`, para o chip escolhido seguir a cor do próprio
 *  calendário (é o que o handoff desenha: Agenda em azul sobre azul lavado). */
function tinta(hex: string, alfa: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

/** "2026-06-19" → "sex". Montado com `new Date(ano, mes-1, dia)`, nunca
 *  `new Date(iso)`: a string pura é lida como UTC e devolveria o dia anterior
 *  em São Paulo — o rótulo diria "qui" numa sexta. */
function abrevDia(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return DIAS[d.getDay()] ?? '';
}

/** "2026-06-19" → "19/06". */
function diaMes(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : '';
}

function hoje(): string {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${String(d.getDate()).padStart(2, '0')}`;
}

type Estado = 'ocioso' | 'salvando' | 'invalido' | 'erro';

export function ModalEvento({
  aberto,
  onFechar,
  dia,
  criar = criarEventoViaApi,
  onCriado,
}: ModalEventoProps): JSX.Element {
  const base = dia || hoje();

  const [titulo, setTitulo] = useState('');
  const [diaInteiro, setDiaInteiro] = useState(false);
  const [dataInicio, setDataInicio] = useState(base);
  const [horaInicio, setHoraInicio] = useState('09:00');
  const [dataFim, setDataFim] = useState(base);
  const [horaFim, setHoraFim] = useState('10:00');
  const [local, setLocal] = useState('');
  const [repetir, setRepetir] = useState<Repeticao>('nunca');
  const [calendario, setCalendario] = useState<Calendario>('agenda');

  const [estado, setEstado] = useState<Estado>('ocioso');
  const [aviso, setAviso] = useState('');
  const [tocado, setTocado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  /** Só faz sentido oferecer "tentar de novo" quando repetir pode dar outro
   *  resultado. Uma recusa da camada devolve o mesmo a cada toque. */
  const [retentavel, setRetentavel] = useState(true);

  /** As horas que o "dia inteiro" tirou da tela. Sem isto, desligar o toggle
   *  devolveria 09:00/10:00 e comeria o horário que a pessoa tinha escolhido —
   *  sumiço silencioso, o mesmo pecado do save calado. */
  const guardadas = useRef({ inicio: '09:00', fim: '10:00' });
  /** Guarda de reentrada em `ref`, não em estado: dois toques em Salvar caem no
   *  mesmo lote de render e um `useState` ainda estaria velho no segundo. */
  const enviando = useRef(false);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // ABRIU: O FORMULÁRIO RECOMEÇA, do dia que a tela de origem está mostrando
  // AGORA. Quem abre o modal pode mantê-lo montado entre uma abertura e outra;
  // sem isto, o "novo evento" seguinte nasceria com o título do anterior dentro.
  //
  // Duas escolhas aqui, e as duas custaram um teste:
  //  - na TRANSIÇÃO de fechado para aberto, não "enquanto fechado". Zerar ao
  //    fechar deixava o dia congelado no que a tela de origem mostrava naquele
  //    momento: rolar o calendário para outro mês com o modal fechado e reabrir
  //    dava a data velha, e "sábado" continuava dizendo sexta.
  //  - durante o RENDER, não num `useEffect`. O efeito só correria depois da
  //    primeira pintura, e o sheet subiria por um quadro com o formulário
  //    anterior dentro. É o ajuste de estado por mudança de prop que o React
  //    documenta: o `set` aqui reinicia este render antes de qualquer commit.
  const [abertoAntes, setAbertoAntes] = useState(aberto);
  if (aberto !== abertoAntes) {
    setAbertoAntes(aberto);
    if (aberto) {
      setTitulo('');
      setDiaInteiro(false);
      setDataInicio(base);
      setDataFim(base);
      setHoraInicio('09:00');
      setHoraFim('10:00');
      setLocal('');
      setRepetir('nunca');
      setCalendario('agenda');
      setEstado('ocioso');
      setAviso('');
      setRetentavel(true);
      setTocado(false);
      setConfirmando(false);
      guardadas.current = { inicio: '09:00', fim: '10:00' };
    }
  }

  /** Toda mudança do usuário passa por aqui: marca o formulário como sujo (é o
   *  que faz Cancelar perguntar antes de descartar) e apaga uma reclamação de
   *  validação já atendida. O "erro ao salvar" NÃO some daqui — some quando um
   *  envio voltar OK. */
  const mudou = (): void => {
    setTocado(true);
    setEstado((atual) => (atual === 'invalido' ? 'ocioso' : atual));
  };

  const alternarDiaInteiro = (): void => {
    mudou();
    if (diaInteiro) {
      setHoraInicio(guardadas.current.inicio);
      setHoraFim(guardadas.current.fim);
    } else {
      guardadas.current = { inicio: horaInicio, fim: horaFim };
      setHoraInicio('');
      setHoraFim('');
    }
    setDiaInteiro(!diaInteiro);
  };

  const montar = (): NovoEvento => ({
    titulo: titulo.trim(),
    diaInteiro,
    inicio: diaInteiro ? dataInicio : `${dataInicio}T${horaInicio}`,
    fim: diaInteiro ? dataFim : `${dataFim}T${horaFim}`,
    local: local.trim(),
    repetir,
    calendario,
  });

  /** O que impede este evento de existir, em português. `null` = pode salvar. */
  const problema = (): string | null => {
    if (!titulo.trim()) return 'dê um título ao evento';
    if (!dataInicio || !dataFim) return 'informe as datas';
    if (!diaInteiro && (!horaInicio || !horaFim)) return 'informe o horário de início e de fim';
    const evento = montar();
    // Comparação de string basta: os dois lados são ISO do mesmo formato, que
    // ordena igual à linha do tempo.
    if (evento.fim < evento.inicio) return 'o fim vem antes do início';
    return null;
  };

  const salvar = async (): Promise<void> => {
    if (enviando.current) return;
    const impedimento = problema();
    if (impedimento) {
      setAviso(impedimento);
      setEstado('invalido');
      return;
    }
    const evento = montar();
    enviando.current = true;
    setEstado('salvando');
    try {
      await criar(evento);
      if (!vivo.current) return;
      // Zera ANTES de avisar quem abriu: se o modal continuar montado (o
      // chamador é quem fecha), ele não pode ficar com um erro velho na tela.
      setEstado('ocioso');
      onCriado?.(evento);
      onFechar();
    } catch (e) {
      if (vivo.current) {
        // A tela não INTERPRETA o erro — mostra o que a camada disse. É lá que
        // mora o "Google não está conectado" e o motivo de uma categoria não
        // servir; um "erro ao salvar" fixo apagaria os dois.
        const dito = e instanceof Error ? e.message.trim() : '';
        setAviso(dito || 'erro ao salvar');
        setRetentavel(!(e instanceof ErroCriarEvento) || e.retentavel);
        setEstado('erro');
      }
    } finally {
      enviando.current = false;
    }
  };

  /** Cancelar, backdrop, grabber e Escape — todos por aqui. Com o formulário
   *  intocado sai direto; com coisa digitada, pergunta. */
  const cancelar = (): void => {
    if (!tocado) {
      onFechar();
      return;
    }
    setConfirmando(true);
  };

  const cabecalho = confirmando ? (
    <div className="ms-mevento-cabecalho">
      {/* O destrutivo fica onde estava o Cancelar e o seguro onde estava o
          Salvar: quem já levou o dedo para um lado não descarta por engano. */}
      <button type="button" className="ms-mevento-acao ms-mevento-acao--perigo" onClick={onFechar}>
        Descartar
      </button>
      <span className="ms-mevento-titulo-barra">Descartar evento?</span>
      <button
        type="button"
        className="ms-mevento-acao ms-mevento-acao--forte"
        onClick={() => setConfirmando(false)}
      >
        Continuar
      </button>
    </div>
  ) : (
    <div className="ms-mevento-cabecalho">
      <button type="button" className="ms-mevento-acao" onClick={cancelar}>
        Cancelar
      </button>
      <span className="ms-mevento-titulo-barra">Novo evento</span>
      <button
        type="button"
        className="ms-mevento-acao ms-mevento-acao--forte"
        onClick={() => void salvar()}
        disabled={estado === 'salvando'}
      >
        Salvar
      </button>
    </div>
  );

  const rodape =
    estado === 'ocioso' ? undefined : (
      <div className="ms-mevento-rodape">
        {estado === 'salvando' ? (
          <span className="ms-mevento-status" role="status">salvando…</span>
        ) : (
          // A ÚNICA região com `role="alert"` do modal — a falha do salvar e a
          // da validação dividem o mesmo lugar, para não haver dois alertas
          // competindo pela leitura.
          <span className="ms-mevento-status ms-mevento-status--erro" role="alert">
            <AlertTriangleIcon size={12} />
            {aviso}
            {estado === 'erro' && retentavel ? (
              <button type="button" className="ms-mevento-retentar" onClick={() => void salvar()}>
                tentar de novo
              </button>
            ) : null}
          </span>
        )}
      </div>
    );

  const pill = (
    qual: 'inicio' | 'fim',
    data: string,
    setData: (v: string) => void,
    hora: string,
    setHora: (v: string) => void,
  ): JSX.Element => (
    <span className={`ms-mevento-pill ms-mevento-pill--${qual}`}>
      <span className="ms-mevento-campo">
        <span aria-hidden="true">{diaInteiro ? `${abrevDia(data)}, ${diaMes(data)}` : `${abrevDia(data)}, `}</span>
        {/* O input nativo cobre o rótulo: no iPhone o toque abre o seletor do
            sistema, e o alvo tem os 44pt sem engordar a linha de 56. */}
        <input
          type="date"
          className="ms-mevento-sobreposto"
          aria-label={qual === 'inicio' ? 'Data de início' : 'Data de fim'}
          value={data}
          onChange={(e) => {
            mudou();
            setData(e.target.value);
          }}
        />
      </span>
      {diaInteiro ? null : (
        <span className="ms-mevento-campo">
          <span aria-hidden="true">{hora || '--:--'}</span>
          <input
            type="time"
            className="ms-mevento-sobreposto"
            aria-label={qual === 'inicio' ? 'Hora de início' : 'Hora de fim'}
            value={hora}
            onChange={(e) => {
              mudou();
              setHora(e.target.value);
            }}
          />
        </span>
      )}
    </span>
  );

  return (
    <MobileSheet aberto={aberto} onFechar={cancelar} rotulo="Novo evento" titulo={cabecalho} rodape={rodape}>
      <input
        type="text"
        className="ms-mevento-titulo"
        aria-label="Título do evento"
        placeholder="Título do evento"
        value={titulo}
        onChange={(e) => {
          mudou();
          setTitulo(e.target.value);
        }}
      />

      <div className="ms-mevento-linhas">
        <div className="ms-mevento-linha">
          <span className="ms-mevento-icone ms-mevento-icone--dia" aria-hidden="true">
            <CalendarIcon size={16} />
          </span>
          <span className="ms-mevento-rotulo">Dia inteiro</span>
          <button
            type="button"
            role="switch"
            aria-checked={diaInteiro}
            aria-label="Dia inteiro"
            className={diaInteiro ? 'ms-mevento-toggle ms-mevento-toggle--ligado' : 'ms-mevento-toggle'}
            onClick={alternarDiaInteiro}
          >
            <span className="ms-mevento-botao" aria-hidden="true" />
          </button>
        </div>
        <div className="ms-mevento-divisoria" />

        <div className="ms-mevento-linha">
          <span className="ms-mevento-icone ms-mevento-icone--inicio" aria-hidden="true">
            <ClockIcon size={16} />
          </span>
          <span className="ms-mevento-rotulo">Início</span>
          {pill('inicio', dataInicio, setDataInicio, horaInicio, setHoraInicio)}
        </div>
        <div className="ms-mevento-divisoria" />

        <div className="ms-mevento-linha">
          <span className="ms-mevento-icone" aria-hidden="true">
            <ClockIcon size={16} />
          </span>
          <span className="ms-mevento-rotulo">Fim</span>
          {pill('fim', dataFim, setDataFim, horaFim, setHoraFim)}
        </div>
        <div className="ms-mevento-divisoria" />

        <div className="ms-mevento-linha">
          {/* O handoff desenha um alfinete de mapa; `icons/Icons.tsx` não tem um
              e esta task não é dona daquele arquivo. `TargetIcon` é o mais
              próximo do acervo — mesma leitura de "um ponto no mapa" — e fica
              com a cor teal do desenho. */}
          <span className="ms-mevento-icone ms-mevento-icone--local" aria-hidden="true">
            <TargetIcon size={16} />
          </span>
          <span className="ms-mevento-rotulo ms-mevento-rotulo--fixo">Local</span>
          <input
            type="text"
            className="ms-mevento-local"
            aria-label="Local"
            placeholder="adicionar"
            value={local}
            onChange={(e) => {
              mudou();
              setLocal(e.target.value);
            }}
          />
        </div>
        <div className="ms-mevento-divisoria" />

        <div className="ms-mevento-linha">
          <span className="ms-mevento-icone ms-mevento-icone--repetir" aria-hidden="true">
            <RepeatIcon size={16} />
          </span>
          <span className="ms-mevento-rotulo">Repetir</span>
          <span className="ms-mevento-valor" aria-hidden="true">
            {REPETICOES.find((o) => o.valor === repetir)?.rotulo ?? 'Nunca'}
          </span>
          <select
            className="ms-mevento-sobreposto"
            aria-label="Repetir"
            value={repetir}
            onChange={(e) => {
              mudou();
              setRepetir(e.target.value as Repeticao);
            }}
          >
            {REPETICOES.map((o) => (
              <option key={o.valor} value={o.valor}>{o.rotulo}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="ms-mevento-secao" aria-hidden="true">CALENDÁRIO</div>
      <div className="ms-mevento-chips" role="radiogroup" aria-label="Calendário">
        {CALENDARIOS.map((c) => {
          const escolhido = c.valor === calendario;
          return (
            <button
              key={c.valor}
              type="button"
              role="radio"
              aria-checked={escolhido}
              data-calendario={c.valor}
              className={escolhido ? 'ms-mevento-chip ms-mevento-chip--escolhido' : 'ms-mevento-chip'}
              style={
                escolhido
                  ? { color: c.cor, backgroundColor: tinta(c.cor, 0.16), borderColor: tinta(c.cor, 0.35) }
                  : undefined
              }
              onClick={() => {
                mudou();
                setCalendario(c.valor);
              }}
            >
              <span className="ms-mevento-ponto" style={{ backgroundColor: c.cor }} />
              {c.rotulo}
            </button>
          );
        })}
      </div>
    </MobileSheet>
  );
}
