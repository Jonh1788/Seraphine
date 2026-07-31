import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../insights/api', () => ({
  listInsights: vi.fn(),
  getWeeklyReport: vi.fn(),
  getFocusStats: vi.fn(),
  getTimeByCategory: vi.fn(),
}));
import {
  getFocusStats,
  getTimeByCategory,
  getWeeklyReport,
  listInsights,
} from '../../../insights/api';
import type {
  FocusStats,
  Insight,
  TimeByCategoryResponse,
  WeeklyReport,
} from '../../../insights/types';
import { InsightsScreen } from '../InsightsScreen';

/* A tela lê a semana corrente (/focus/stats?period=week devolve os últimos 7
   dias, do mais antigo para hoje), então os fixtures nascem da data real —
   congelar o relógio brigaria com o `waitFor`. */
const HOJE = new Date();
const pad = (n: number) => String(n).padStart(2, '0');

/** ISO local de `n` dias atrás. */
function isoAtras(n: number): string {
  const d = new Date(HOJE.getFullYear(), HOJE.getMonth(), HOJE.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Coluna seg-primeiro (0=seg … 6=dom) de um ISO local. */
function coluna(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const js = new Date(y, m - 1, d).getDay();
  return js === 0 ? 6 : js - 1;
}

const ROTULOS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

/* O handoff pinta a QUINTA de accent. O pico do fixture é escolhido para nunca
   cair na quinta, aconteça o teste no dia da semana que acontecer — assim uma
   tela que fixasse a coluna 'qui' falharia todo dia, e não só às vezes. */
const CHRONO = [6, 5, 4, 3, 2, 1, 0]; // offsets, do mais antigo até hoje
const PICO_I = CHRONO.findIndex((off) => coluna(isoAtras(off)) !== 3);
const PICO_COL = coluna(isoAtras(CHRONO[PICO_I]));

/* Minutos por dia na mesma ordem cronológica: 420 no dia do pico, valores
   distintos nos outros (um deles zero, que é dado e não ausência). */
const OUTROS = [60, 120, 180, 30, 0, 90];
const MINUTOS = CHRONO.map((_, i) =>
  i === PICO_I ? 420 : OUTROS[i > PICO_I ? i - 1 : i]);

function focoComDado(): FocusStats {
  return {
    total_focus_min: MINUTOS.reduce((s, m) => s + m, 0), // 900 → 2,1h/dia
    completed_sessions: 12,
    cancelled_sessions: 1,
    avg_session_min: 42,
    streak_days: 3,
    interruption_rate: 0.1,
    by_day: MINUTOS.map((min, i) => ({
      date: isoAtras(6 - i),
      focus_min: min,
      completed: min > 0 ? 1 : 0,
      cancelled: 0,
      interruptions: 0,
    })),
    by_category: [],
  };
}

/** Semana sem nenhuma sessão: dias existem, minutos são todos zero. */
function focoZerado(): FocusStats {
  return {
    ...focoComDado(),
    total_focus_min: 0,
    by_day: MINUTOS.map((_, i) => ({
      date: isoAtras(6 - i),
      focus_min: 0,
      completed: 0,
      cancelled: 0,
      interruptions: 0,
    })),
  };
}

function relatorio(): WeeklyReport {
  return {
    id: 1,
    week_start: isoAtras(6),
    week_end: isoAtras(0),
    tasks: { created: 24, completed: 18, overdue: 2 },
    finance: { income: 0, expenses: 0, balance: 0 },
    habits: { maintained: [], broken: [] },
    goals: {},
    mood: {
      summary: 'Humor da semana',
      trend: 'subindo',
      daily_avgs: [
        { date: isoAtras(2), avg_valence: 0.5 },
        { date: isoAtras(1), avg_valence: 0.7 },
      ],
      total_logs: 9,
    },
    focus: {},
    journal: {},
    insights: [],
    suggestion: '',
    created_at: `${isoAtras(0)}T10:00:00`,
  };
}

const INSIGHT: Insight = {
  id: 'i1',
  type: 'productivity',
  severity: 'info',
  title: 'Seu dia mais produtivo',
  description: 'Quinta é seu dia mais produtivo — proteja as manhãs de quinta.',
  data: {},
  created_at: `${isoAtras(0)}T10:00:00`,
  dismissed: false,
};

function categorias(): TimeByCategoryResponse {
  return {
    period: 'week',
    total_focus_min: 2580,
    categories: [
      { category: 'Trabalho', focus_min: 1680, sessions: 40, pct: 65.1 },
      { category: 'Estudo', focus_min: 540, sessions: 12, pct: 20.9 },
      { category: 'Saúde', focus_min: 360, sessions: 8, pct: 14 },
    ],
  };
}

function comDado() {
  vi.mocked(listInsights).mockResolvedValue([INSIGHT]);
  vi.mocked(getWeeklyReport).mockResolvedValue(relatorio());
  vi.mocked(getFocusStats).mockResolvedValue(focoComDado());
  vi.mocked(getTimeByCategory).mockResolvedValue(categorias());
}

const barras = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('.ms-insights-barra'));

describe('InsightsScreen', () => {
  beforeEach(() => {
    vi.mocked(listInsights).mockReset();
    vi.mocked(getWeeklyReport).mockReset();
    vi.mocked(getFocusStats).mockReset();
    vi.mocked(getTimeByCategory).mockReset();
  });

  it('renderiza os três stat-cards com o número real', async () => {
    comDado();
    render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText('18')).toBeTruthy());
    expect(screen.getByText('tarefas feitas')).toBeTruthy();
    // 900 min / 7 dias = 128,6 min = 2,1h por dia
    expect(screen.getByText('2,1h')).toBeTruthy();
    expect(screen.getByText('foco / dia')).toBeTruthy();
    // humor: média das valências (0,6) → "Bem", sem emoji
    expect(screen.getByText('Bem')).toBeTruthy();
    expect(screen.getByText('humor médio')).toBeTruthy();
  });

  it('o pico é o MAIOR do dado, não uma posição fixa', async () => {
    comDado();
    const { container } = render(<InsightsScreen />);
    await waitFor(() => expect(barras(container).length).toBe(7));

    // guarda do próprio fixture: o pico não é a quinta do handoff
    expect(ROTULOS[PICO_COL]).not.toBe('qui');
    const picos = container.querySelectorAll('.ms-insights-barra--pico');
    expect(picos.length).toBe(1);
    // o pico está na coluna do dia de 420 min — que muda conforme o dia da semana
    expect(picos[0].getAttribute('data-dia')).toBe(ROTULOS[PICO_COL]);
    expect(picos[0].getAttribute('data-min')).toBe('420');
    // e é de fato o máximo do conjunto
    const mins = barras(container).map((b) => Number(b.getAttribute('data-min')));
    expect(Math.max(...mins)).toBe(420);
  });

  it('as barras escalam pela amplitude real do dado', async () => {
    comDado();
    const { container } = render(<InsightsScreen />);
    await waitFor(() => expect(barras(container).length).toBe(7));

    const porColuna = new Map(
      barras(container).map((b) => [
        b.getAttribute('data-dia'),
        { min: Number(b.getAttribute('data-min')), pct: Number(b.getAttribute('data-pct')) },
      ]),
    );
    // cada barra vale minutos/pico — o zero fica em 0, o pico em 100
    MINUTOS.forEach((min, i) => {
      const col = ROTULOS[coluna(isoAtras(6 - i))];
      expect(porColuna.get(col)).toEqual({ min, pct: Math.round((min / 420) * 100) });
    });
    // e a altura inline segue o pct (nada de sete barras iguais)
    const alturas = new Set(barras(container).map((b) => b.style.height));
    expect(alturas.size).toBeGreaterThan(4);
  });

  it('semana sem nenhuma sessão diz isso — não desenha um gráfico vazio', async () => {
    comDado();
    vi.mocked(getFocusStats).mockResolvedValue(focoZerado());
    const { container } = render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText(/nenhuma sessão de foco nesta semana/i)).toBeTruthy());
    expect(barras(container).length).toBe(0);
    // vazio não é erro
    expect(container.querySelector('.ms-insights-grafico [role="alert"]')).toBeNull();
  });

  it('carregando mostra esqueleto e NÃO a frase de vazio', async () => {
    vi.mocked(listInsights).mockReturnValue(new Promise(() => {}));
    vi.mocked(getWeeklyReport).mockReturnValue(new Promise(() => {}));
    vi.mocked(getFocusStats).mockReturnValue(new Promise(() => {}));
    vi.mocked(getTimeByCategory).mockReturnValue(new Promise(() => {}));
    const { container } = render(<InsightsScreen />);

    // o gráfico espera em esqueleto — e não numa moldura de barras vazia
    expect(container.querySelector('.ms-insights-skel--barras')).toBeTruthy();
    expect(container.querySelector('.ms-insights-barras')).toBeNull();
    expect(barras(container).length).toBe(0);
    expect(screen.queryByText(/nenhuma sessão de foco nesta semana/i)).toBeNull();
    expect(screen.queryByText(/ainda não encontrei padrões/i)).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // /focus/stats pode responder sem corpo JSON: a api devolve `null`, e isso
  // não é erro nem gráfico — é semana sem dado, e tem que dizer isso.
  it('resposta sem corpo não vira moldura de gráfico vazia', async () => {
    comDado();
    vi.mocked(getFocusStats).mockResolvedValue(null);
    const { container } = render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText(/nenhuma sessão de foco nesta semana/i)).toBeTruthy());
    expect(container.querySelector('.ms-insights-barras')).toBeNull();
    // e o stat de foco assume a ausência em vez de mentir um número
    expect(screen.getByText('sem foco registrado')).toBeTruthy();
  });

  it('renderiza o que a Seraphine notou', async () => {
    comDado();
    render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText('SERAPHINE NOTOU')).toBeTruthy());
    expect(screen.getByText(/proteja as manhãs de quinta/i)).toBeTruthy();
  });

  it('sem insights, o bloco continua de pé e diz o que falta', async () => {
    comDado();
    vi.mocked(listInsights).mockResolvedValue([]);
    render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText(/ainda não encontrei padrões/i)).toBeTruthy());
    expect(screen.getByText('SERAPHINE NOTOU')).toBeTruthy();
  });

  it('renderiza as barras de onde foi seu tempo com a fatia real', async () => {
    comDado();
    const { container } = render(<InsightsScreen />);
    await waitFor(() => expect(screen.getByText('Trabalho')).toBeTruthy());

    expect(screen.getByText('28h')).toBeTruthy();
    expect(screen.getByText('9h')).toBeTruthy();
    const larguras = Array.from(
      container.querySelectorAll<HTMLElement>('.ms-insights-fatia'),
      (f) => f.style.width,
    );
    expect(larguras).toEqual(['65.1%', '20.9%', '14%']);
  });

  it('sem categorias, a seção diz que não há sessão categorizada', async () => {
    comDado();
    vi.mocked(getTimeByCategory).mockResolvedValue({
      period: 'week', total_focus_min: 0, categories: [],
    });
    render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText(/nenhuma sessão de foco categorizada/i)).toBeTruthy());
    expect(screen.getByText('Onde foi seu tempo')).toBeTruthy();
  });

  it('cada bloco erra com a sua frase quando a api falha', async () => {
    vi.mocked(listInsights).mockRejectedValue(new Error('rede'));
    vi.mocked(getWeeklyReport).mockRejectedValue(new Error('rede'));
    vi.mocked(getFocusStats).mockRejectedValue(new Error('rede'));
    vi.mocked(getTimeByCategory).mockRejectedValue(new Error('rede'));
    render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui carregar o resumo da semana/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar as sessões de foco/i)).toBeTruthy();
    expect(screen.getByText(/não consegui carregar o que eu notei/i)).toBeTruthy();
    expect(screen.getByText(/não consegui somar onde seu tempo foi/i)).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBe(4);
    // e nunca mente dizendo que a semana foi vazia
    expect(screen.queryByText(/nenhuma sessão de foco nesta semana/i)).toBeNull();
    expect(screen.queryByText(/ainda não encontrei padrões/i)).toBeNull();
  });

  it('a falha do foco não derruba os outros blocos', async () => {
    comDado();
    vi.mocked(getFocusStats).mockRejectedValue(new Error('rede'));
    render(<InsightsScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui carregar as sessões de foco/i)).toBeTruthy());
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('Trabalho')).toBeTruthy();
    expect(screen.getByText(/proteja as manhãs de quinta/i)).toBeTruthy();
  });

  it('o ‹ do cabeçalho chama onBack', async () => {
    comDado();
    const onBack = vi.fn();
    render(<InsightsScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('18')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack, tocar no ‹ não quebra', async () => {
    comDado();
    render(<InsightsScreen />);
    await waitFor(() => expect(screen.getByText('18')).toBeTruthy());

    expect(() => fireEvent.click(screen.getByLabelText('Voltar'))).not.toThrow();
  });

  it('não usa emoji em lugar nenhum', async () => {
    comDado();
    const { container } = render(<InsightsScreen />);
    await waitFor(() => expect(screen.getByText('Trabalho')).toBeTruthy());

    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/u;
    expect(emoji.test(container.textContent ?? '')).toBe(false);
    // e os ícones são SVG de verdade
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
