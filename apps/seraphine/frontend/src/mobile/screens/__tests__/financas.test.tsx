import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: um mock de fetch com `{ ok, json }`
// sem `headers` faz qualquer helper que leia `res.headers.get(...)` estourar,
// e o teste passaria pelo caminho de erro achando que testou o feliz.
vi.mock('../../../finance/api', () => ({
  listEntries: vi.fn(),
  fetchSummary: vi.fn(),
  fetchBalance: vi.fn(),
}));

import { listEntries, fetchSummary, fetchBalance } from '../../../finance/api';
import type { FinanceBalance, FinanceEntry, FinanceSummary } from '../../../finance/types';
import { FinancasScreen } from '../FinancasScreen';

const resumo = (over: Partial<FinanceSummary> = {}): FinanceSummary => ({
  income: 6520,
  expenses: 2340,
  balance: 4180,
  by_category: [
    { category: 'moradia', total: 1200, count: 1 },
    { category: 'alimentacao', total: 680, count: 6 },
    { category: 'transporte', total: 320, count: 4 },
  ],
  ...over,
});

const vazio = (): FinanceSummary => ({ income: 0, expenses: 0, balance: 0, by_category: [] });

const lancamentos = (): FinanceEntry[] => [
  { id: 1, type: 'expense', amount: 1200, category: 'moradia', description: 'Aluguel', date: '2026-07-15', source: 'chat', status: 'confirmed' },
  { id: 2, type: 'income', amount: 1800, category: 'freelance', description: 'Freelance — site', date: '2026-07-14', source: 'chat', status: 'confirmed' },
];

const saldoGeral = (over: Partial<FinanceBalance> = {}): FinanceBalance => ({
  balance: 12480,
  total_income: 30000,
  total_expenses: 17520,
  adjustment: 0,
  ...over,
});

/** A tela dispara três buscas independentes; um teste que checa só uma delas
 *  termina com as outras ainda no ar e o React avisa "not wrapped in act".
 *  Isto espera as três assentarem (nenhum esqueleto de pé). */
async function assentar(): Promise<void> {
  await waitFor(() => expect(document.querySelector('.ms-financas-skel')).toBeNull());
}

describe('FinancasScreen', () => {
  beforeEach(() => {
    // O mês é o recorte da tela inteira: sem relógio fixo, os testes de mês e de
    // "Hoje/Ontem" seriam diferentes a cada dia. Só o Date é falso — os timers
    // continuam reais, para o `waitFor` funcionar normalmente.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 15, 10, 0, 0)); // 15 de julho de 2026
    vi.mocked(fetchSummary).mockReset().mockResolvedValue(resumo());
    vi.mocked(listEntries).mockReset().mockResolvedValue(lancamentos());
    vi.mocked(fetchBalance).mockReset().mockResolvedValue(saldoGeral());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('desenha o hero, as barras por categoria e as transações do mês', async () => {
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('R$ 4.180,00')).toBeTruthy()); // saldo = 6520 − 2340
    expect(screen.getByText('R$ 6.520,00')).toBeTruthy(); // receitas, dentro do hero
    expect(screen.getByText('R$ 2.340,00')).toBeTruthy(); // despesas, dentro do hero
    expect(screen.getByText('Receitas')).toBeTruthy();
    expect(screen.getByText('Despesas')).toBeTruthy();
    expect(screen.getByText('Julho 2026')).toBeTruthy();

    // barras por categoria
    expect(screen.getByText('Moradia')).toBeTruthy();
    expect(screen.getByText('Alimentação')).toBeTruthy();
    expect(screen.getByText('Transporte')).toBeTruthy();

    // lista de transações
    expect(screen.getByText('Aluguel')).toBeTruthy();
    expect(screen.getByText('Freelance — site')).toBeTruthy();
  });

  // O saldo é a conta que o usuário confere de cabeça: tem de ser exatamente as
  // duas parcelas mostradas ao lado dele, não um terceiro número do servidor.
  it('o saldo exibido é receitas menos despesas, não o campo `balance` do servidor', async () => {
    vi.mocked(fetchSummary).mockResolvedValue(
      resumo({ income: 5000, expenses: 1250, balance: 999999, by_category: [] }),
    );
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('R$ 3.750,00')).toBeTruthy());
    expect(screen.queryByText(/999\.999/)).toBeNull();
  });

  // Date#getMonth() é base 0 e a rota é base 1. Sem o +1 aqui, TODO número da
  // tela seria o do mês passado — e pareceria plausível.
  it('pede o mês em base 1 ao resumo e às transações', async () => {
    render(<FinancasScreen />);
    await waitFor(() => expect(vi.mocked(fetchSummary)).toHaveBeenCalled());
    expect(vi.mocked(fetchSummary).mock.calls[0]).toEqual([7, 2026]); // julho, não 6
    await waitFor(() => expect(vi.mocked(listEntries)).toHaveBeenCalled());
    expect(vi.mocked(listEntries).mock.calls[0][0]).toMatchObject({ month: 7, year: 2026 });
  });

  it('saldo negativo chega negativo ao DOM', async () => {
    vi.mocked(fetchSummary).mockResolvedValue(resumo({ income: 1000, expenses: 2500, balance: -1500 }));
    const { container } = render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('−R$ 1.500,00')).toBeTruthy());
    const saldo = container.querySelector('.ms-financas-saldo');
    expect(saldo?.textContent?.startsWith('−')).toBe(true);
    expect(container.querySelector('.ms-financas-hero--negativo')).toBeTruthy();
  });

  // O mês corrente do usuário real está vazio (o lançamento mais novo é de
  // abril): esta é a tela que ele de fato vê. Não pode virar "R$ 0,00".
  it('mês sem movimento diz que não houve movimento, e nunca mostra R$ 0,00', async () => {
    vi.mocked(fetchSummary).mockResolvedValue(vazio());
    vi.mocked(listEntries).mockResolvedValue([]);
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText(/nenhuma movimentação neste mês/i)).toBeTruthy());
    expect(screen.getByText(/nenhuma transação neste mês/i)).toBeTruthy();
    expect(screen.getByText(/nenhuma despesa por categoria/i)).toBeTruthy();
    expect(screen.queryByText(/R\$ 0,00/)).toBeNull();
  });

  it('mostra erro quando o resumo falha', async () => {
    vi.mocked(fetchSummary).mockRejectedValue(new Error('rede'));
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar o resumo deste mês/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar o resumo deste mês/i).getAttribute('role')).toBe('alert');
  });

  it('erro das transações não derruba o hero', async () => {
    vi.mocked(listEntries).mockRejectedValue(new Error('rede'));
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar suas transações/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar suas transações/i).getAttribute('role')).toBe('alert');
    expect(screen.getByText('R$ 4.180,00')).toBeTruthy();
  });

  // O endpoint sempre manda `balance`, mas o tipo o declara opcional: se um dia
  // vier sem, "R$ 0,00" seria uma mentira plausível.
  it('saldo geral ausente vira estado vazio, não R$ 0,00', async () => {
    vi.mocked(fetchBalance).mockResolvedValue({} as FinanceBalance);
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText(/saldo geral indisponível/i)).toBeTruthy());
    expect(screen.queryByText(/R\$ 0,00/)).toBeNull();
  });

  it('mostra o saldo geral quando ele vem, e erro próprio quando falha', async () => {
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('R$ 12.480,00')).toBeTruthy());

    vi.mocked(fetchBalance).mockRejectedValue(new Error('rede'));
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar o saldo geral/i)).toBeTruthy());
  });

  it('as transações mostram o sinal e o dia relativo', async () => {
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('−R$ 1.200,00')).toBeTruthy()); // despesa
    expect(screen.getByText('+R$ 1.800,00')).toBeTruthy(); // receita
    expect(screen.getByText(/Hoje/)).toBeTruthy();
    expect(screen.getByText(/Ontem/)).toBeTruthy();
  });

  it('a barra de cada categoria é proporcional ao total de despesas', async () => {
    const { container } = render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('Moradia')).toBeTruthy());
    const barras = [...container.querySelectorAll<HTMLElement>('.ms-financas-barra-fill')];
    expect(barras).toHaveLength(3);
    expect(barras[0].style.width).toBe('51%'); // 1200 / 2340
    expect(barras[1].style.width).toBe('29%'); // 680 / 2340
    expect(barras[2].style.width).toBe('14%'); // 320 / 2340
  });

  it('carrega com esqueleto e sem texto — nada pisca "sem movimento" antes do dado', async () => {
    const { container } = render(<FinancasScreen />);
    expect(container.querySelector('.ms-financas-skel')).toBeTruthy();
    expect(screen.queryByText(/nenhuma/i)).toBeNull();
    expect(screen.queryByText(/R\$/)).toBeNull();
    expect(screen.queryByText(/em construção/i)).toBeNull();
    await assentar(); // as três promessas resolvem dentro do teste, não depois
  });

  // O shell deixou de desenhar chrome: sem a seta aqui, quem entra em Finanças
  // fica preso na tela.
  it('tem o voltar e chama onBack ao tocar', async () => {
    const onBack = vi.fn();
    render(<FinancasScreen onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('Aluguel')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  // Não existe api de criar lançamento: o "+" do handoff leva ao chat, que é
  // por onde o lançamento nasce neste produto. Sem `onOpen` ele não aparece,
  // para não virar botão morto.
  it('o "+" abre o chat quando há para onde navegar', async () => {
    const onOpen = vi.fn();
    render(<FinancasScreen onOpen={onOpen} />);
    fireEvent.click(await screen.findByLabelText(/registrar lançamento/i));
    expect(onOpen).toHaveBeenCalledWith({ key: 'chat', title: 'Chat' });
  });

  it('sem onOpen o "+" não aparece', async () => {
    render(<FinancasScreen />);
    await waitFor(() => expect(screen.getByText('Aluguel')).toBeTruthy());
    expect(screen.queryByLabelText(/registrar lançamento/i)).toBeNull();
  });

  // Regra do projeto: ícone é SVG inline, nunca emoji — e CATEGORY_LABELS do
  // desktop vem com emoji embutido.
  it('não renderiza emoji nenhum', async () => {
    const { container } = render(<FinancasScreen onBack={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Moradia')).toBeTruthy());
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
