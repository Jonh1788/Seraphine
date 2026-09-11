import { API_BASE } from '../api';
import type { FinanceEntry } from '../finance/types';
import type { AggregateDay, AggregateResponse, Task, TasksByRangeResponse } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      // Only on bodied requests: a JSON Content-Type on a plain GET is not
      // CORS-safelisted and would add a preflight the old inline fetch
      // never paid for.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

/**
 * Per-day aggregate (tasks, habits, health, water, mood, focus, journal,
 * events + server-side score) for the inclusive range [start, end].
 * Dates are YYYY-MM-DD. The backend caps the range at 100 days.
 */
export async function fetchAggregate(start: string, end: string): Promise<AggregateDay[]> {
  const params = new URLSearchParams({ start, end });
  const data = await request<AggregateResponse>(`/calendar/aggregate?${params.toString()}`);
  return Array.isArray(data?.days) ? data.days : [];
}

/** Tasks whose due_date falls in the inclusive range [start, end] (YYYY-MM-DD). */
export async function fetchTasksByRange(start: string, end: string): Promise<Task[]> {
  const params = new URLSearchParams({ start, end });
  const data = await request<TasksByRangeResponse>(`/tasks/by-date-range?${params.toString()}`);
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

/**
 * Lançamentos cuja DATA DA COMPRA cai no intervalo [start, end] (YYYY-MM-DD,
 * extremos incluídos) — a mesma pergunta que `fetchTasksByRange` faz às
 * tarefas, e a única que o calendário tem.
 *
 * NÃO usa `month`/`year`: esses recortam pelo MÊS DE CAIXA, o mês em que o
 * dinheiro sai, que para uma compra no cartão é o do vencimento ou o do
 * pagamento da fatura. O calendário posiciona cada lançamento por `date`, a
 * data da compra — pedir um e desenhar o outro faz a compra de 15/07 numa
 * fatura que vence em 10/08 nunca ser buscada para a semana de 13–19/07, e
 * sumir do dia em que aconteceu.
 */
export async function fetchFinanceEntriesByRange(
  start: string, end: string, limit = 500,
): Promise<FinanceEntry[]> {
  const params = new URLSearchParams({
    date_from: start, date_to: end, limit: String(limit),
  });
  const data = await request<{ entries?: FinanceEntry[] }>(
    `/finance/entries?${params.toString()}`,
  );
  return Array.isArray(data?.entries) ? data.entries : [];
}

/* ------------------------------------------------------------------ */
/*  Criação de evento — POST /google/calendar/events                   */
/* ------------------------------------------------------------------ */

/** O evento como as telas o montam (o `NovoEvento` do modal encaixa aqui por
 *  forma, sem a camada precisar importar uma tela).
 *
 *  `repetir` e `calendario` são `string`, não uniões: quem chama pode vir de
 *  um lugar sem tipos, e é justamente o valor fora do conjunto que precisa ser
 *  recusado em tempo de execução. */
export interface NovoEventoEntrada {
  titulo: string;
  diaInteiro: boolean;
  /** `YYYY-MM-DD` quando é dia inteiro, `YYYY-MM-DDTHH:MM` quando tem hora. */
  inicio: string;
  fim: string;
  local?: string;
  repetir?: string;
  calendario?: string;
}

/** O que o backend confirmou ter criado — não o que foi pedido. */
export interface EventoCriado {
  id: string;
  link: string | null;
  diaInteiro: boolean;
  /** As RRULEs que o Google recebeu. Vazio quando o evento não repete. */
  repeticao: string[];
}

/** Falha ao criar. `retentavel` separa "o mundo estava ruim" (rede, Google
 *  fora, 500) de "este evento não serve" — tentar de novo só faz sentido no
 *  primeiro caso, e o modal usa isso para não oferecer um botão inútil. */
export class ErroCriarEvento extends Error {
  readonly retentavel: boolean;
  readonly status: number | null;

  constructor(mensagem: string, opts: { retentavel: boolean; status?: number | null }) {
    super(mensagem);
    this.name = 'ErroCriarEvento';
    this.retentavel = opts.retentavel;
    this.status = opts.status ?? null;
  }
}

/** As repetições que `google_integration/routes.py::Repeticao` aceita — e que
 *  o mapa `_RRULE` de lá sabe traduzir. Um valor fora daqui seria 422. */
export const REPETICOES_ACEITAS: readonly string[] = [
  'nunca', 'diario', 'semanal', 'mensal', 'anual',
];

/**
 * A ÚNICA categoria que a leitura consegue reconstruir de um evento do Google.
 *
 * `CalendarView.tsx::eventCategory` decide a categoria por `ev.calendarId` — e
 * o backend nunca preenche esse campo: `GET /google/calendar/events` devolve o
 * item cru do Google, e o recurso Events não tem `calendarId`. Todo evento
 * criado por aqui volta, portanto, como "Agenda".
 */
export const CALENDARIO_DO_EVENTO = 'agenda';

/** De onde cada categoria do calendário REALMENTE vem, para a recusa ensinar
 *  em vez de só barrar. Conferido em `CalendarView.tsx`: finanças em
 *  `entryToItem`, tarefas em `taskToItem`, lembretes em `expandRecurring` e
 *  nos lembretes; "outros" só existiria com um `calendarId` que ninguém põe. */
export const OUTRAS_CATEGORIAS: Readonly<Record<string, string>> = {
  financas: 'dos lançamentos financeiros',
  tarefas: 'das tarefas',
  lembretes: 'dos lembretes e das regras recorrentes',
  outros: 'de um calendarId que o backend nunca preenche',
};

const SO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const COM_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function recusar(mensagem: string): never {
  throw new ErroCriarEvento(mensagem, { retentavel: false });
}

/** O `detail` PT-BR que os routers do backend mandam. Vale mais que o status:
 *  é onde mora a dica de reconectar o Google. */
async function detalhe(res: Response): Promise<string> {
  try {
    const corpo = (await res.json()) as { detail?: unknown };
    return typeof corpo?.detail === 'string' ? corpo.detail : '';
  } catch {
    return '';
  }
}

/**
 * Cria um evento no calendário. `POST /google/calendar/events` → 201
 *
 * O QUE ESTA CAMADA SABE PARA QUE A TELA NÃO PRECISE SABER:
 *
 * 1. **A categoria não sobrevive à ida e volta.** Um evento do Google não
 *    carrega categoria nenhuma, e a leitura a deriva de um campo que o backend
 *    nunca preenche — então salvar um evento marcado como "Lembretes" criaria
 *    algo que jamais aparece no filtro escolhido. As outras quatro categorias
 *    do calendário vêm de outras fontes (lançamentos, tarefas, lembretes).
 *    Recusar aqui é a diferença entre uma frase e um evento perdido.
 * 2. **Dia inteiro e com hora têm formas diferentes**, e a leitura as
 *    distingue (`isAllDay` é `!start.dateTime && !!start.date`). Mandar um dia
 *    puro no caminho com hora inventa meia-noite lá na frente.
 * 3. **`repetir` fora do conjunto do backend é 422**, e um 422 seco não diz
 *    qual campo estava errado.
 *
 * O que NÃO mora aqui, de propósito: `fim` antes de `inicio`. Quem valida é a
 * rota (que também precisa se defender de outros clientes), e duplicar a regra
 * criaria duas versões dela para divergirem.
 */
export async function criarEvento(evento: NovoEventoEntrada): Promise<EventoCriado> {
  const titulo = (evento.titulo || '').trim();
  if (!titulo) recusar('dê um título ao evento antes de salvar.');

  const calendario = evento.calendario ?? CALENDARIO_DO_EVENTO;
  if (calendario !== CALENDARIO_DO_EVENTO) {
    const origem = OUTRAS_CATEGORIAS[calendario] ?? 'de outra fonte do calendário';
    recusar(
      `um evento do Google sempre volta como Agenda; a categoria "${calendario}" vem ` +
        `${origem}. Escolha Agenda para salvar aqui.`,
    );
  }

  const repetir = evento.repetir ?? 'nunca';
  if (!REPETICOES_ACEITAS.includes(repetir)) {
    recusar(`repetição desconhecida: "${repetir}". O backend só aceita ${REPETICOES_ACEITAS.join(', ')}.`);
  }

  const forma = evento.diaInteiro ? SO_DIA : COM_HORA;
  for (const [campo, valor] of [['início', evento.inicio], ['fim', evento.fim]] as const) {
    if (!forma.test(valor || '')) {
      recusar(
        evento.diaInteiro
          ? `dia inteiro pede ${campo} como AAAA-MM-DD, veio "${valor}".`
          : `com hora, o ${campo} precisa levar a hora junto (AAAA-MM-DDTHH:MM), veio "${valor}".`,
      );
    }
  }

  const local = (evento.local || '').trim();
  const res = await fetch(`${API_BASE}/google/calendar/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: titulo,
      start: evento.inicio,
      end: evento.fim,
      all_day: evento.diaInteiro,
      repeat: repetir,
      ...(local ? { location: local } : {}),
    }),
  });

  if (!res.ok) {
    const detalhado = await detalhe(res);
    // 401 é Google desconectado. Um "HTTP 401" seco no rodapé do modal não
    // diria à pessoa o que fazer, e é o caso mais provável depois do sucesso.
    const mensagem =
      res.status === 401
        ? detalhado || 'Google não está conectado — conecte o Google e tente de novo.'
        : detalhado || `HTTP ${res.status}`;
    throw new ErroCriarEvento(mensagem, { retentavel: true, status: res.status });
  }

  const corpo = (await res.json()) as {
    id?: unknown;
    html_link?: unknown;
    all_day?: unknown;
    recurrence?: unknown;
  };
  const id = typeof corpo.id === 'string' ? corpo.id : '';
  // A lição do `/planning/accept`: um envelope de sucesso que não descreve
  // nada criado não é sucesso.
  if (!id) {
    throw new ErroCriarEvento('o servidor respondeu OK mas não criou evento nenhum.', {
      retentavel: true,
      status: res.status,
    });
  }
  return {
    id,
    link: typeof corpo.html_link === 'string' ? corpo.html_link : null,
    diaInteiro: corpo.all_day === true,
    repeticao: Array.isArray(corpo.recurrence) ? corpo.recurrence.map(String) : [],
  };
}

/* ------------------------------------------------------------------ */
/*  Exclusão de evento — DELETE /google/calendar/events/{id}           */
/* ------------------------------------------------------------------ */

/** O que o backend confirmou ter apagado. */
export interface EventoApagado {
  /** O id que o servidor disse ter apagado — conferido contra o pedido. */
  id: string;
  /** O evento já não estava no Google (404/410): apagado pela web, por outro
   *  aparelho, ou por um toque anterior que a tela não viu voltar. O resultado
   *  é o mesmo — não está na agenda —, mas não foi ESTA chamada que apagou. */
  jaNaoExistia: boolean;
}

/** Falha ao apagar. Mesmo contrato do `ErroCriarEvento`: `retentavel` separa "o
 *  mundo estava ruim" de "este pedido não serve". */
export class ErroApagarEvento extends Error {
  readonly retentavel: boolean;
  readonly status: number | null;

  constructor(mensagem: string, opts: { retentavel: boolean; status?: number | null }) {
    super(mensagem);
    this.name = 'ErroApagarEvento';
    this.retentavel = opts.retentavel;
    this.status = opts.status ?? null;
  }
}

/**
 * O mesmo alfabeto de `google_integration/client.py::EVENT_ID_RE`.
 *
 * NÃO é zelo decorativo, e o dano não se mede em linha — mede-se em
 * CALENDÁRIO. O id entra direto no caminho da requisição que o backend monta,
 * e o httpx normaliza segmentos de ponto antes de enviar: um id de ".." vira
 *
 *     DELETE .../calendars/primary/events/..   →   DELETE .../calendars/primary
 *
 * que apaga a agenda inteira. "../../outro" alcança um calendário qualquer. O
 * backend tem o guarda dele (é ele que vale); este existe para a recusa chegar
 * como frase em português na tela, sem gastar uma ida à rede.
 *
 * Permissivo com o que o Google realmente emite: instância de recorrente traz
 * "_" e maiúsculas (`abc_20260620T120000Z`), importado traz "@", e o teto
 * documentado é 1024.
 */
const ID_DE_EVENTO = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_@.-]{1,1024}$/;

/**
 * Apaga um evento do calendário. `DELETE /google/calendar/events/{id}` → 200
 *
 * O QUE ESTA CAMADA GARANTE QUE A TELA NÃO PRECISA SABER:
 *
 * 1. **O id é conferido antes de sair** (ver `ID_DE_EVENTO`).
 * 2. **Sucesso é sucesso.** Um 200 sem `ok:true`, ou que confirme um id
 *    DIFERENTE do pedido, levanta erro: numa exclusão, acreditar num "ok"
 *    frouxo faz a linha certa sumir da tela com o compromisso ainda no Google
 *    — ou pior, a linha errada sumir.
 * 3. **"Já não existia" é um resultado, não um erro** — mas vem marcado.
 */
export async function apagarEvento(id: string): Promise<EventoApagado> {
  if (!ID_DE_EVENTO.test(id ?? '')) {
    throw new ErroApagarEvento(
      `identificador de evento inválido: "${id}". Recarregue a agenda e tente de novo.`,
      { retentavel: false },
    );
  }

  const res = await fetch(`${API_BASE}/google/calendar/events/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const detalhado = await detalhe(res);
    const mensagem =
      res.status === 401
        ? detalhado || 'Google não está conectado — conecte o Google e tente de novo.'
        : detalhado || `HTTP ${res.status}`;
    throw new ErroApagarEvento(mensagem, { retentavel: true, status: res.status });
  }

  const corpo = (await res.json()) as {
    ok?: unknown;
    id?: unknown;
    ja_nao_existia?: unknown;
  };
  if (corpo.ok !== true) {
    throw new ErroApagarEvento('o servidor respondeu mas não confirmou a exclusão.', {
      retentavel: true,
      status: res.status,
    });
  }
  const confirmado = typeof corpo.id === 'string' ? corpo.id : '';
  if (confirmado !== id) {
    throw new ErroApagarEvento(
      `o servidor confirmou ter apagado outro evento ("${confirmado}"), não o que foi pedido.`,
      { retentavel: false, status: res.status },
    );
  }
  return { id: confirmado, jaNaoExistia: corpo.ja_nao_existia === true };
}
