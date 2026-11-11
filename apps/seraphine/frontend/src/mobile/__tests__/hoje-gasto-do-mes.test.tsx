import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HojeScreen } from '../HojeScreen';
import { fetchSummary } from '../../finance/api';

/**
 * "Gasto do mês" no Hoje e "despesas" nas Finanças são o MESMO rótulo. Antes
 * do mês de caixa eles concordavam por acidente: os dois somavam por data.
 * Agora `/finance/summary` soma pelo mês em que o dinheiro SAI — o do
 * vencimento ou do pagamento da fatura — e somar por prefixo da data da
 * compra no Hoje devolve outro número.
 *
 * O backend falso abaixo modela essa diferença: uma compra de 15/07 numa
 * fatura que vence em 10/08 sai em agosto pelo resumo e em julho pela data.
 */

const COMPRA_NO_CARTAO = {
  id: 1, type: 'expense', amount: 240, category: 'outros',
  description: 'Mercado', date: '2026-07-15', source: 'pdf', status: 'confirmed',
};
const PIX_DE_AGOSTO = {
  id: 2, type: 'expense', amount: 50, category: 'outros',
  description: 'PIX', date: '2026-08-03', source: 'chat', status: 'confirmed',
};
// O mês de caixa de cada lançamento: a compra no cartão pesa em agosto.
const MES_DE_CAIXA: Record<number, string> = { 1: '2026-08', 2: '2026-08' };

const TODOS = [COMPRA_NO_CARTAO, PIX_DE_AGOSTO];

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Um servidor de mentira que respeita a regra do mês de caixa. */
function servidor(url: string) {
  const u = new URL(url, 'http://local');
  if (u.pathname.endsWith('/finance/summary')) {
    const alvo = `${u.searchParams.get('year')}-${String(u.searchParams.get('month')).padStart(2, '0')}`;
    const doMes = TODOS.filter((e) => MES_DE_CAIXA[e.id] === alvo);
    const expenses = doMes.reduce((s, e) => s + e.amount, 0);
    return json({
      income: 0, expenses, balance: -expenses,
      realized: 50, forecast: 240,
      by_category: expenses ? [{ category: 'outros', total: expenses, count: doMes.length }] : [],
    });
  }
  if (u.pathname.endsWith('/finance/entries')) {
    // Como a rota real: sem mês devolve tudo, e a data é a da COMPRA.
    return json({ entries: TODOS });
  }
  // Os outros blocos do Hoje não são o assunto aqui.
  return json({});
}

function valorDoBloco(): string | null {
  return document.querySelector('.mhoje-orcamento__value')?.textContent ?? null;
}

describe('Hoje — "Gasto do mês" é o número das Finanças', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 20, 10, 0, 0)); // 20 de agosto de 2026
    global.fetch = vi.fn((url: unknown) => Promise.resolve(servidor(String(url)))) as never;
  });

  afterEach(() => { vi.useRealTimers(); });

  it('mostra o mesmo total que o hero das Finanças', async () => {
    // A tela de Finanças lê exatamente isto no hero de despesas.
    const daFinancas = await fetchSummary(8, 2026);
    expect(daFinancas.expenses).toBe(290);

    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(valorDoBloco()).toBeTruthy());
    expect(valorDoBloco()).toBe('R$ 290,00');
  });

  it('a compra de julho na fatura de agosto entra no gasto de agosto', async () => {
    // Somando por prefixo da data da compra, agosto ficava só com o PIX:
    // R$ 50,00 no Hoje contra R$ 290,00 nas Finanças, lado a lado no app.
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(valorDoBloco()).toBeTruthy());
    expect(valorDoBloco()).not.toBe('R$ 50,00');
  });

  it('mês sem gasto nenhum continua sendo um vazio desenhado', async () => {
    vi.setSystemTime(new Date(2026, 10, 5, 10, 0, 0)); // novembro, sem nada
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nenhum gasto/i)).toBeTruthy());
  });

  it('falha de rede continua virando erro do bloco, não um R$ 0,00', async () => {
    global.fetch = vi.fn((url: unknown) => (
      String(url).includes('/finance/summary')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(servidor(String(url)))
    )) as never;
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/não consegui buscar seus gastos/i)).toBeTruthy());
  });
});
