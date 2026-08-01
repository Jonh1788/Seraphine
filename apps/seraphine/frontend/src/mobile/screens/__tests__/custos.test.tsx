import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Esta tela mostra DINHEIRO. Um custo errado é pior que um custo ausente: ele
   não quebra nada, não avisa ninguém e corrói a confiança em todo o resto do
   app. Por isso os testes daqui cobrem, além dos três estados da onda, as
   quatro armadilhas que só existem nesta tela:

     1. a lista de backends flat vem do backend (`GET /telemetry/flat-backends`)
        e a tela NÃO pode ter cópia local — enquanto ela não chega, nada é
        classificado;
     2. `budget: null` (nunca configurado) é diferente de `monthly_usd: 0`
        (teto real de zero);
     3. com teto zero o backend manda `pct_used: null` porque não existe
        percentual de zero — dividir no cliente daria `Infinity`;
     4. `budget.spent_usd` é do MÊS e ignora o `?days=`, então ele discorda por
        construção dos agregados de 7/30 dias exibidos ao lado. Sem rótulo, a
        tela mostra dois totais contraditórios. */

vi.mock('../../../telemetry/api', () => ({
  fetchTelemetrySummary: vi.fn(),
  listFlatBackends: vi.fn(),
  fetchEngineInfo: vi.fn(),
}));

import {
  fetchEngineInfo,
  fetchTelemetrySummary,
  listFlatBackends,
} from '../../../telemetry/api';
import { CustosScreen } from '../CustosScreen';

/** A lista que o backend devolve hoje (`pricing.FLAT_BACKENDS`, Task 1). */
const FLAT = ['claude_max', 'cliproxy', 'local', 'ollama'];

const MOTOR = {
  name: 'cliproxy',
  backend: 'cliproxy',
  model: 'claude-sonnet-4.6',
  is_local: false,
  is_flat_cost: true,
  supports_tools: true,
  supports_vision: true,
};

const TETO = {
  monthly_usd: 30.0,
  spent_usd: 11.6,
  days_left: 11,
  projected_usd: 17.4,
  pct_used: 38.6667,
  over_budget: false,
};

/* 1700 cliproxy + 44 ollama = 1744 flat; 96 openrouter medidas ($2,84).
   1744/1840 = 94,8% → "95% sem custo", como no handoff. */
function resumo(over: Record<string, unknown> = {}) {
  return {
    days: 7,
    budget: TETO,
    total: { input_tokens: 3_400_000, output_tokens: 812_000, cost_usd: 2.84, calls: 1840 },
    by_model: [{ model: 'claude-sonnet-4.6', input_tokens: 3_400_000, output_tokens: 812_000, cost_usd: 2.84, calls: 1840 }],
    by_feature: [{ feature: 'chat', cost_usd: 2.84, calls: 1840 }],
    by_backend: [
      { backend: 'cliproxy', cost_usd: 0, calls: 1700 },
      { backend: 'ollama', cost_usd: 0, calls: 44 },
      { backend: 'openrouter', cost_usd: 2.84, calls: 96 },
    ],
    ...over,
  } as never;
}

/** Período sem nenhuma chamada — mas o mês pode ter gasto (ver a armadilha 4). */
function resumoVazio(over: Record<string, unknown> = {}) {
  return resumo({
    total: { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 },
    by_model: [],
    by_feature: [],
    by_backend: [],
    ...over,
  });
}

function comDado(over: Record<string, unknown> = {}) {
  vi.mocked(fetchTelemetrySummary).mockResolvedValue(resumo(over));
  vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
  vi.mocked(fetchEngineInfo).mockResolvedValue(MOTOR);
}

const q = (c: HTMLElement, sel: string) => c.querySelector<HTMLElement>(sel);
const texto = (c: HTMLElement, sel: string) => q(c, sel)?.textContent ?? '';

describe('CustosScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchTelemetrySummary).mockReset();
    vi.mocked(listFlatBackends).mockReset();
    vi.mocked(fetchEngineInfo).mockReset();
  });

  /* ── estado 1: dado ─────────────────────────────────────────────── */

  it('mostra o custo medido do período em pt-BR, com os tiles e o motor', async () => {
    comDado();
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());
    expect(screen.getByText(/Nuvem \(medido\) · últimos 7 dias/i)).toBeTruthy();

    // tiles com fmtCount (k/M, vírgula)
    expect(screen.getByText('3,4M')).toBeTruthy();
    expect(screen.getByText('812,0k')).toBeTruthy();
    expect(screen.getByText('1,8k')).toBeTruthy();

    // motor de inferência de GET /llm/engine
    expect(screen.getByText('cliproxy')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-4.6')).toBeTruthy();
    expect(screen.getByText('flat $0')).toBeTruthy();
    expect(screen.getByText('tools')).toBeTruthy();
    expect(screen.getByText('visão')).toBeTruthy();

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('valor sub-centavo mantém 4 casas em vez de virar $0,00', async () => {
    comDado({
      by_backend: [{ backend: 'openrouter', cost_usd: 0.0004, calls: 3 }],
      total: { input_tokens: 10, output_tokens: 5, cost_usd: 0.0004, calls: 3 },
    });
    render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('$0,0004')).toBeTruthy());
    expect(screen.queryByText('$0,00')).toBeNull();
  });

  /* ── a lista de backends flat é do backend, nunca da tela ────────── */

  it('classifica flat vs medido pela lista que o backend mandou', async () => {
    comDado();
    const { container } = render(<CustosScreen />);
    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());

    const barra = q(container, '.ms-custos-hero__barra')!;
    expect(barra.getAttribute('data-flat')).toBe('1744');
    expect(barra.getAttribute('data-medidas')).toBe('96');
    expect(screen.getByText('95% sem custo')).toBeTruthy();
    // legenda com os nomes reais do período, não uma lista escrita na tela
    expect(screen.getByText('cliproxy · ollama')).toBeTruthy();
    expect(screen.getByText('openrouter')).toBeTruthy();
  });

  // Contraprova: se a tela tivesse uma cópia local da lista, `ollama` seguiria
  // flat mesmo com o backend dizendo o contrário.
  it('lista SEM ollama torna as chamadas de ollama medidas', async () => {
    comDado({
      by_backend: [
        { backend: 'cliproxy', cost_usd: 0, calls: 1700 },
        { backend: 'ollama', cost_usd: 5, calls: 44 },
        { backend: 'openrouter', cost_usd: 2.84, calls: 96 },
      ],
    });
    vi.mocked(listFlatBackends).mockResolvedValue(['claude_max', 'cliproxy']);
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(q(container, '.ms-custos-hero__barra')).toBeTruthy());
    const barra = q(container, '.ms-custos-hero__barra')!;
    expect(barra.getAttribute('data-flat')).toBe('1700');
    expect(barra.getAttribute('data-medidas')).toBe('140');
    // e o custo do ollama entra no valor medido
    expect(screen.getByText('$7,84')).toBeTruthy();
    const itens = container.querySelectorAll('.ms-custos-legenda__item');
    expect(itens[0].textContent).toBe('cliproxy');
    expect(itens[1].textContent).toBe('ollama · openrouter');
  });

  it('enquanto a lista flat não chegou, não classifica — esqueleto', async () => {
    vi.mocked(fetchTelemetrySummary).mockResolvedValue(resumo());
    vi.mocked(fetchEngineInfo).mockResolvedValue(MOTOR);
    vi.mocked(listFlatBackends).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CustosScreen />);

    // o teto (que não depende da lista) chega; o herói continua em esqueleto
    await waitFor(() => expect(screen.getByText('$11,60')).toBeTruthy());
    expect(q(container, '[data-testid="custos-hero-esqueleto"]')).toBeTruthy();
    expect(q(container, '.ms-custos-hero__barra')).toBeNull();
    expect(screen.queryByText('$2,84')).toBeNull();
    expect(screen.queryByText(/sem custo/)).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('se a lista flat falha, avisa em vez de chutar — e os totais ficam', async () => {
    comDado();
    vi.mocked(listFlatBackends).mockRejectedValue(new Error('rede'));
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui separar nuvem medida de local/i)).toBeTruthy());
    expect(q(container, '.ms-custos-hero__barra')).toBeNull();
    expect(screen.queryByText('$2,84')).toBeNull();
    // os agregados que não dependem de classificação seguem visíveis
    expect(screen.getByText('3,4M')).toBeTruthy();
    expect(screen.getByText('1,8k')).toBeTruthy();
    // falha secundária não é o alerta da tela
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── estado 2: vazio ────────────────────────────────────────────── */

  it('período sem chamadas diz isso, e não é erro', async () => {
    vi.mocked(fetchTelemetrySummary).mockResolvedValue(resumoVazio());
    vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
    vi.mocked(fetchEngineInfo).mockResolvedValue(MOTOR);
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText(/nenhuma chamada nos últimos 7 dias/i)).toBeTruthy());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(q(container, '.ms-custos-hero__barra')).toBeNull();
  });

  /* ── estado 3: erro ─────────────────────────────────────────────── */

  it('falha do resumo mostra UM alerta e nenhum número inventado', async () => {
    vi.mocked(fetchTelemetrySummary).mockRejectedValue(new Error('HTTP 500'));
    vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
    vi.mocked(fetchEngineInfo).mockResolvedValue(MOTOR);
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getAllByRole('alert').length).toBe(1);
    expect(screen.getByText(/não consegui carregar os custos do período/i)).toBeTruthy();
    // nem valor, nem frase de vazio (que seria mentira)
    expect(screen.queryByText('$2,84')).toBeNull();
    expect(screen.queryByText(/nenhuma chamada nos últimos/i)).toBeNull();
    expect(screen.queryByText('$11,60')).toBeNull();
    // os tiles afirmam a ausência em vez de exibirem zero, que seria lido como fato
    expect(Array.from(container.querySelectorAll('.ms-custos-tile__valor'), (t) => t.textContent))
      .toEqual(['—', '—', '—']);
    expect(screen.getAllByText('indisponível').length).toBe(3);
  });

  it('carregando é esqueleto, sem texto de vazio e sem número', async () => {
    vi.mocked(fetchTelemetrySummary).mockReturnValue(new Promise(() => {}));
    vi.mocked(listFlatBackends).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchEngineInfo).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CustosScreen />);

    expect(q(container, '[data-testid="custos-hero-esqueleto"]')).toBeTruthy();
    expect(q(container, '[data-testid="custos-teto-esqueleto"]')).toBeTruthy();
    expect(q(container, '[data-testid="custos-motor-esqueleto"]')).toBeTruthy();
    expect(screen.queryByText(/nenhuma chamada/i)).toBeNull();
    expect(screen.queryByText(/ainda não definiu um teto/i)).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  /* ── teto do mês (Task 2) ───────────────────────────────────────── */

  it('teto configurado mostra gasto, teto, percentual, dias e projeção', async () => {
    comDado();
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('$11,60')).toBeTruthy());
    expect(screen.getByText('de $30,00')).toBeTruthy();
    expect(screen.getByText(/39% usado/)).toBeTruthy();
    expect(screen.getByText(/faltam 11 dias/)).toBeTruthy();
    expect(screen.getByText('projeção $17,40')).toBeTruthy();
    // a barra usa o pct_used do backend
    expect(q(container, '.ms-custos-teto__fill')!.style.width).toBe('38.6667%');
  });

  it('budget null é convite a configurar — não barra vazia nem zeros', async () => {
    comDado({ budget: null });
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText(/ainda não definiu um teto mensal/i)).toBeTruthy());
    expect(q(container, '.ms-custos-teto__trilho')).toBeNull();
    expect(q(container, '.ms-custos-teto__fill')).toBeNull();
    expect(screen.queryByText('$0,00')).toBeNull();
    expect(screen.queryByText(/% usado/)).toBeNull();
    // convite não é erro
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('teto de zero é um teto real, e não o convite', async () => {
    comDado({
      budget: {
        monthly_usd: 0.0, spent_usd: 11.6, days_left: 30,
        projected_usd: 359.6, pct_used: null, over_budget: true,
      },
    });
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('de $0,00')).toBeTruthy());
    expect(screen.queryByText(/ainda não definiu um teto mensal/i)).toBeNull();
    expect(screen.getByText('$11,60')).toBeTruthy();
    expect(screen.getByText(/teto estourado/i)).toBeTruthy();
    // e desenha a barra, que o convite não tem: é um teto, não uma ausência
    expect(q(container, '.ms-custos-teto__trilho')).toBeTruthy();
  });

  it('pct_used null nunca vira conta no cliente (nada de Infinity/NaN/%)', async () => {
    comDado({
      budget: {
        monthly_usd: 0.0, spent_usd: 11.6, days_left: 30,
        projected_usd: 359.6, pct_used: null, over_budget: true,
      },
    });
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('de $0,00')).toBeTruthy());
    const card = q(container, '.ms-custos-teto')!;
    expect(card.textContent).not.toMatch(/Infinity|NaN/);
    expect(card.textContent).not.toMatch(/% usado/);
    // a barra fica cheia porque estourou, não porque alguém dividiu por zero
    const fill = q(container, '.ms-custos-teto__fill')!;
    expect(fill.style.width).toBe('100%');
    expect(fill.className).toMatch(/ms-custos-teto__fill--estouro/);
  });

  it('teto de zero sem gasto nenhum não é estouro', async () => {
    comDado({
      budget: {
        monthly_usd: 0.0, spent_usd: 0.0, days_left: 30,
        projected_usd: 0.0, pct_used: null, over_budget: false,
      },
    });
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('de $0,00')).toBeTruthy());
    expect(screen.getByText(/nada gasto neste mês/i)).toBeTruthy();
    expect(screen.queryByText(/teto estourado/i)).toBeNull();
    expect(q(container, '.ms-custos-teto__fill')!.style.width).toBe('0%');
  });

  it('pct_used acima de 100 é dito inteiro, mas a barra para em 100%', async () => {
    comDado({
      budget: {
        monthly_usd: 10.0, spent_usd: 16.2, days_left: 3,
        projected_usd: 20.0, pct_used: 162.0, over_budget: true,
      },
    });
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText(/162% usado/)).toBeTruthy());
    expect(q(container, '.ms-custos-teto__fill')!.style.width).toBe('100%');
  });

  it('bloco de teto ilegível não vira número — avisa', async () => {
    comDado({ budget: { monthly_usd: '30', spent_usd: 11.6, days_left: 11, projected_usd: 17.4, pct_used: 38.6, over_budget: false } });
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui ler o teto do mês/i)).toBeTruthy());
    expect(q(container, '.ms-custos-teto')!.textContent).not.toMatch(/\$\d/);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── a discordância de janela entre o teto e o período ───────────── */

  it('rotula as duas janelas: "últimos N dias" no herói, "este mês" no teto', async () => {
    // 7 dias sem nenhuma chamada, mas o mês já gastou $11,60 — os dois números
    // discordam por construção, e é a copy que impede a leitura de "quebrado".
    vi.mocked(fetchTelemetrySummary).mockResolvedValue(resumoVazio());
    vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
    vi.mocked(fetchEngineInfo).mockResolvedValue(MOTOR);
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText('$11,60')).toBeTruthy());
    expect(screen.getByText(/Nuvem \(medido\) · últimos 7 dias/i)).toBeTruthy();
    expect(screen.getByText(/nenhuma chamada nos últimos 7 dias/i)).toBeTruthy();
    expect(texto(container, '.ms-custos-teto__janela')).toMatch(/este mês/i);
    expect(screen.getByText(/o teto é mensal e não acompanha o filtro de 7 dias/i)).toBeTruthy();
  });

  it('trocar para 30 dias muda o período, mas não o gasto do mês', async () => {
    comDado();
    render(<CustosScreen />);
    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());
    expect(vi.mocked(fetchTelemetrySummary).mock.calls[0][0]).toBe(7);

    vi.mocked(fetchTelemetrySummary).mockResolvedValue(
      resumo({ days: 30, total: { input_tokens: 9_000_000, output_tokens: 2_000_000, cost_usd: 9.5, calls: 5000 } }),
    );
    fireEvent.click(screen.getByRole('button', { name: '30 dias' }));

    await waitFor(() => expect(screen.getByText(/Nuvem \(medido\) · últimos 30 dias/i)).toBeTruthy());
    expect(vi.mocked(fetchTelemetrySummary).mock.calls[1][0]).toBe(30);
    // o teto continua sendo do MÊS: mesmo valor, mesmo rótulo
    expect(screen.getByText('$11,60')).toBeTruthy();
    expect(screen.getByText(/o teto é mensal e não acompanha o filtro de 30 dias/i)).toBeTruthy();
  });

  /* ── motor de inferência ────────────────────────────────────────── */

  it('motor indisponível avisa, sem chips e sem derrubar o resto', async () => {
    comDado();
    vi.mocked(fetchEngineInfo).mockRejectedValue(new Error('404'));
    const { container } = render(<CustosScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui ler o motor de inferência/i)).toBeTruthy());
    expect(q(container, '.ms-custos-motor__chips')).toBeNull();
    expect(screen.getByText('$2,84')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── controles ──────────────────────────────────────────────────── */

  it('o botão atualizar refaz a busca do período atual', async () => {
    comDado();
    render(<CustosScreen />);
    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Atualizar'));
    await waitFor(() => expect(vi.mocked(fetchTelemetrySummary).mock.calls.length).toBe(2));
    expect(vi.mocked(fetchTelemetrySummary).mock.calls[1][0]).toBe(7);
  });

  it('o ‹ do cabeçalho chama onBack, e sem onBack não quebra', async () => {
    comDado();
    const onBack = vi.fn();
    const { unmount } = render(<CustosScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();

    render(<CustosScreen />);
    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());
    expect(() => fireEvent.click(screen.getByLabelText('Voltar'))).not.toThrow();
  });

  it('não usa emoji — os ícones são SVG', async () => {
    comDado();
    const { container } = render(<CustosScreen />);
    await waitFor(() => expect(screen.getByText('$2,84')).toBeTruthy());

    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/u;
    expect(emoji.test(container.textContent ?? '')).toBe(false);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
