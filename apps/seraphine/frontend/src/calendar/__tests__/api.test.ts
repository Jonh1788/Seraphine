import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';

/** A realistic ok Response stub (headers included — the code may read them). */
function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, statusText = 'Server Error') {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: async () => ({}),
    text: async () => 'boom',
  };
}

const DAY = {
  date: '2026-07-01',
  tasks: [{ id: 1, title: 'pagar conta', status: 'done' }],
  habits: [{ habit_id: 'h1', name: 'ler', completed: true }],
  health: { steps: 9000, sleep_minutes: 430, sleep_hours: 7.2, calories: 500, resting_hr: 58 },
  water: { intake_ml: 2000, goal_ml: 2500 },
  mood: { avg_valence: 0.7, predominant_label: 'feliz' },
  focus: { total_min: 90, sessions_count: 3 },
  journal: { count: 1 },
  events: [{ title: 'reuniao', start: '2026-07-01T10:00:00Z', end: '2026-07-01T11:00:00Z' }],
  score: 6,
};

const TASK = {
  id: 42,
  type: 'todo',
  status: 'pending',
  title: 'comprar pao',
  description: '',
  source: 'manual',
  payload: '{}',
  created_at: '2026-07-01T09:00:00Z',
  due_date: '2026-07-03',
};

function lastUrl(): string {
  const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls[calls.length - 1][0]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAggregate', () => {
  it('hits /calendar/aggregate with the start and end range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ days: [DAY] })));
    await api.fetchAggregate('2026-07-01', '2026-07-31');
    const url = lastUrl();
    expect(url).toContain('/calendar/aggregate');
    expect(url).toContain('start=2026-07-01');
    expect(url).toContain('end=2026-07-31');
  });

  it('unwraps the days array from the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ days: [DAY] })));
    const days = await api.fetchAggregate('2026-07-01', '2026-07-31');
    expect(days).toEqual([DAY]);
    expect(days[0].mood).toEqual({ avg_valence: 0.7, predominant_label: 'feliz' });
    expect(days[0].score).toBe(6);
  });

  it('returns an empty list when the envelope has no days array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})));
    await expect(api.fetchAggregate('2026-07-01', '2026-07-31')).resolves.toEqual([]);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500)));
    await expect(api.fetchAggregate('2026-07-01', '2026-07-31')).rejects.toThrow('HTTP 500');
  });
});

describe('criarEvento', () => {
  function jsonResponse(body: unknown, status = 201) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 201 ? 'Created' : String(status),
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  const CRIADO = {
    ok: true,
    id: 'evt-1',
    html_link: 'https://cal.example/evt-1',
    all_day: false,
    recurrence: [],
  };

  const EVENTO = {
    titulo: 'Retro do time',
    diaInteiro: false,
    inicio: '2026-06-19T14:00',
    fim: '2026-06-19T15:00',
    local: 'Sala 3',
    repetir: 'nunca',
    calendario: 'agenda',
  };

  function corpo(i = 0): Record<string, unknown> {
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return JSON.parse(String((calls[i][1] as RequestInit).body));
  }

  it('POSTa /google/calendar/events com o que o modal montou', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CRIADO)));

    const criado = await api.criarEvento(EVENTO);

    expect(lastUrl()).toContain('/google/calendar/events');
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(corpo()).toEqual({
      summary: 'Retro do time',
      start: '2026-06-19T14:00',
      end: '2026-06-19T15:00',
      all_day: false,
      location: 'Sala 3',
      repeat: 'nunca',
    });
    expect(criado).toEqual({
      id: 'evt-1',
      link: 'https://cal.example/evt-1',
      diaInteiro: false,
      repeticao: [],
    });
  });

  it('dia inteiro viaja como dia inteiro — a distinção que a leitura faz', async () => {
    // `isAllDay(ev)` é `!start.dateTime && !!start.date`. Se `all_day` não
    // subisse, o backend mandaria `dateTime` e o feriado voltaria como um
    // compromisso às 00:00.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...CRIADO, all_day: true })));

    const criado = await api.criarEvento({
      ...EVENTO,
      diaInteiro: true,
      inicio: '2026-06-19',
      fim: '2026-06-19',
    });

    expect(corpo().all_day).toBe(true);
    expect(corpo().start).toBe('2026-06-19');
    expect(criado.diaInteiro).toBe(true);
  });

  it('devolve a repetição que o backend confirmou, não a que foi pedida', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ...CRIADO, recurrence: ['RRULE:FREQ=WEEKLY'] }),
    ));

    const criado = await api.criarEvento({ ...EVENTO, repetir: 'semanal' });

    expect(corpo().repeat).toBe('semanal');
    expect(criado.repeticao).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('local em branco não vira campo vazio no payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CRIADO)));
    await api.criarEvento({ ...EVENTO, local: '   ' });
    expect('location' in corpo()).toBe(false);
  });

  it('apara o título e recusa um em branco SEM ir à rede', async () => {
    const spy = vi.fn(async () => jsonResponse(CRIADO));
    vi.stubGlobal('fetch', spy);

    await api.criarEvento({ ...EVENTO, titulo: '  Retro do time  ' });
    expect(corpo().summary).toBe('Retro do time');

    await expect(api.criarEvento({ ...EVENTO, titulo: '   ' })).rejects.toThrow(/t[íi]tulo/i);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('recusa a categoria que a leitura NÃO consegue reconstruir, SEM ir à rede', async () => {
    // A ARMADILHA DESTA ROTA. Um evento do Google não carrega categoria
    // nenhuma: `CalendarView.tsx::eventCategory` decide por `ev.calendarId`,
    // que o backend nunca preenche (`list_events` devolve o item cru do
    // Google, e o recurso Events não tem esse campo). Ou seja, TODO evento
    // criado aqui volta como "Agenda". As outras quatro categorias do
    // calendário vêm de outras fontes — finanças dos lançamentos, tarefas das
    // tarefas, lembretes dos lembretes. Salvar em silêncio criaria um evento
    // que nunca aparece no filtro que a pessoa escolheu.
    const spy = vi.fn(async () => jsonResponse(CRIADO));
    vi.stubGlobal('fetch', spy);

    for (const categoria of ['financas', 'tarefas', 'lembretes', 'outros']) {
      await expect(api.criarEvento({ ...EVENTO, calendario: categoria })).rejects.toThrow(
        /agenda/i,
      );
    }
    expect(spy).not.toHaveBeenCalled();

    await api.criarEvento({ ...EVENTO, calendario: 'agenda' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a recusa da categoria diz DE ONDE aquela categoria vem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CRIADO)));
    await expect(api.criarEvento({ ...EVENTO, calendario: 'tarefas' })).rejects.toThrow(
      /tarefas/i,
    );
    await expect(api.criarEvento({ ...EVENTO, calendario: 'financas' })).rejects.toThrow(
      /lançamento|financ/i,
    );
  });

  it('recusa uma repetição fora do conjunto do backend, SEM ir à rede', async () => {
    const spy = vi.fn(async () => jsonResponse(CRIADO));
    vi.stubGlobal('fetch', spy);

    await expect(api.criarEvento({ ...EVENTO, repetir: 'quinzenal' })).rejects.toThrow(
      /repet/i,
    );
    expect(spy).not.toHaveBeenCalled();

    for (const repetir of ['nunca', 'diario', 'semanal', 'mensal', 'anual']) {
      await api.criarEvento({ ...EVENTO, repetir });
    }
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('recusa a forma errada da data, SEM ir à rede', async () => {
    // Um "2026-06-19" no caminho COM hora vira meia-noite lá na frente; um
    // "2026-06-19T09:00" no caminho de dia inteiro vira um dia que o Google
    // recusa. As duas formas são erro do chamador, não do servidor.
    const spy = vi.fn(async () => jsonResponse(CRIADO));
    vi.stubGlobal('fetch', spy);

    await expect(
      api.criarEvento({ ...EVENTO, inicio: '2026-06-19', fim: '2026-06-19' }),
    ).rejects.toThrow(/hora/i);
    await expect(
      api.criarEvento({ ...EVENTO, diaInteiro: true }),
    ).rejects.toThrow(/dia inteiro/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('GOOGLE DESCONECTADO: repassa o que o backend disse, e é retentável', async () => {
    // O caso que mais importa depois do sucesso. Um "HTTP 401" seco não diz
    // nada a quem está olhando o modal.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(
        { detail: 'Google não está conectado — conecte em /google/oauth/start' },
        401,
      ),
    ));

    await expect(api.criarEvento(EVENTO)).rejects.toThrow(/google.*conectado/i);
    await api.criarEvento(EVENTO).catch((e) => {
      expect(e.status).toBe(401);
      expect(e.retentavel).toBe(true);
    });
  });

  it('401 sem detalhe ainda diz que o Google não está conectado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 401)));
    await expect(api.criarEvento(EVENTO)).rejects.toThrow(/google/i);
  });

  it('repassa o detalhe PT-BR dos outros erros do backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ detail: 'criar evento: reconecte o Google em /google/oauth/start' }, 403),
    ));
    await expect(api.criarEvento(EVENTO)).rejects.toThrow(/reconecte o Google/);
  });

  it('sem detalhe nenhum, cai no status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));
    await expect(api.criarEvento(EVENTO)).rejects.toThrow('HTTP 500');
  });

  it('as recusas locais NÃO são retentáveis — tentar de novo daria o mesmo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CRIADO)));
    await api.criarEvento({ ...EVENTO, titulo: '' }).catch((e) => {
      expect(e.retentavel).toBe(false);
      expect(e.status).toBeNull();
    });
  });

  it('um "ok" sem id não conta como evento criado', async () => {
    // A lição do `/planning/accept`, que respondia `ok:true` com zero eventos.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...CRIADO, id: '' })));
    await expect(api.criarEvento(EVENTO)).rejects.toThrow(/n[ãa]o/i);
  });
});

describe('fetchTasksByRange', () => {
  it('hits /tasks/by-date-range with the start and end range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ tasks: [TASK] })));
    await api.fetchTasksByRange('2026-07-01', '2026-07-31');
    const url = lastUrl();
    expect(url).toContain('/tasks/by-date-range');
    expect(url).toContain('start=2026-07-01');
    expect(url).toContain('end=2026-07-31');
  });

  it('unwraps the tasks array from the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ tasks: [TASK] })));
    const tasks = await api.fetchTasksByRange('2026-07-01', '2026-07-31');
    expect(tasks).toEqual([TASK]);
  });

  it('returns an empty list when the envelope has no tasks array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})));
    await expect(api.fetchTasksByRange('2026-07-01', '2026-07-31')).resolves.toEqual([]);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(422, 'Unprocessable Entity')));
    await expect(api.fetchTasksByRange('2026-07-01', '2026-07-31')).rejects.toThrow('HTTP 422');
  });
});
