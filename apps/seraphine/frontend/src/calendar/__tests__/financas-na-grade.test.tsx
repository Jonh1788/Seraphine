import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CalendarView } from '../CalendarView';

/**
 * O calendário posiciona cada lançamento por `entry.date` — a data da COMPRA.
 * A busca pedia `month`/`year`, que recortam pelo MÊS DE CAIXA (o mês em que
 * o dinheiro sai: o do vencimento ou o do pagamento da fatura). As duas
 * premissas deixaram de bater quando a compra no cartão passou a pesar no mês
 * da fatura.
 *
 * Consequência medida: uma compra de 01/07 numa fatura que vence em 10/08
 * nunca era BUSCADA para a semana de 28/06–04/07 — o intervalo da semana não
 * encosta em agosto — e sumia do dia em que aconteceu. A visão de mês
 * escapava por acidente (a grade puxa jun+jul+ago); depois de a fatura ser
 * paga em setembro, sumia de todas.
 *
 * O servidor falso abaixo respeita as duas semânticas, e é o que torna o
 * teste capaz de distinguir uma busca da outra.
 */

const COMPRA_NO_CARTAO = {
  id: 1, type: 'expense', amount: 240, category: 'outros',
  description: 'Mercado no cartao', date: '2026-07-01',
  source: 'pdf', status: 'confirmed',
};
/** Mês de caixa da compra: a fatura vence em 10/08 e não foi paga. */
const MES_DE_CAIXA = '2026-08';

function json(body: unknown) {
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function servidor(url: string) {
  const u = new URL(url, 'http://local');
  if (u.pathname.endsWith('/finance/entries')) {
    const de = u.searchParams.get('date_from');
    const ate = u.searchParams.get('date_to');
    if (de && ate) {
      // Recorte pela DATA DA COMPRA.
      const dentro = COMPRA_NO_CARTAO.date >= de && COMPRA_NO_CARTAO.date <= ate;
      return json({ entries: dentro ? [COMPRA_NO_CARTAO] : [] });
    }
    const mes = u.searchParams.get('month');
    const ano = u.searchParams.get('year');
    if (mes && ano) {
      // Recorte pelo MÊS DE CAIXA — a resposta que o calendário pedia.
      const alvo = `${ano}-${String(mes).padStart(2, '0')}`;
      return json({ entries: alvo === MES_DE_CAIXA ? [COMPRA_NO_CARTAO] : [] });
    }
    return json({ entries: [COMPRA_NO_CARTAO] });
  }
  if (u.pathname.endsWith('/google/calendar/events')) return json([]);
  if (u.pathname.endsWith('/tasks/by-date-range')) return json({ tasks: [] });
  return json({});
}

function urlsDeFinancas(): string[] {
  const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((c) => String(c[0])).filter((u) => u.includes('/finance/entries'));
}

describe('Calendário — a compra aparece no dia em que aconteceu', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01/07/2026 é uma quarta: a semana da grade vai de 28/06 a 04/07, e não
    // encosta em agosto. É o intervalo em que o defeito é visível.
    vi.setSystemTime(new Date(2026, 6, 1, 9, 0, 0));
    global.fetch = vi.fn((url: unknown) => Promise.resolve(servidor(String(url)))) as never;
  });

  afterEach(() => { vi.useRealTimers(); });

  it('a compra de 01/07 aparece na semana de 28/06–04/07', async () => {
    render(<CalendarView onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    await waitFor(() => expect(screen.getAllByText('Mercado no cartao').length).toBeGreaterThan(0));
  });

  it('a busca da semana é pela data da compra, não pelo mês de caixa', async () => {
    render(<CalendarView onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    await waitFor(() => expect(urlsDeFinancas().length).toBeGreaterThan(0));

    const daSemana = urlsDeFinancas().filter((u) => u.includes('date_from'));
    expect(daSemana.length).toBeGreaterThan(0);
    expect(daSemana[daSemana.length - 1]).toContain('date_from=2026-06-28');
    expect(daSemana[daSemana.length - 1]).toContain('date_to=2026-07-04');
    // Nenhuma busca pode voltar a perguntar pelo mês: é a premissa errada.
    expect(urlsDeFinancas().some((u) => u.includes('month='))).toBe(false);
  });

  it('a visão de dia também mostra a compra daquele dia', async () => {
    // O dia é o intervalo mais estreito que existe: se a busca não for pela
    // data da compra, aqui não sobra acidente nenhum para salvá-la.
    render(<CalendarView onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dia' }));
    await waitFor(() => expect(screen.getAllByText('Mercado no cartao').length).toBeGreaterThan(0));
  });
});
